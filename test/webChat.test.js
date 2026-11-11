// The website chat on /support: the browser side (web/lib/chat.js) and this site's /api/chat (web/lib/chatSession.js),
// which runs the chat through the Node server's /api/chat with its key, within the website call limits.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web');
const load = (file) => import(pathToFileURL(path.join(WEB, 'lib', file)).href);
const PHONE = '+919876543210';
const SESSION = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

const answer = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

// The site's /api/chat as the browser sees it: each request answered in turn.
function fakeSite(...answers) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next || answer(200, { reply: 'ok' });
  };
  return { requests, fetchImpl };
}

async function begin(site) {
  const { startChat } = await load('chat.js');
  const seen = [];
  const problems = [];
  const warned = [];
  const chat = startChat({
    server: 'https://site.test',
    phone: PHONE,
    onChange: (t) => seen.push(t),
    onProblem: (p) => problems.push(p),
    fetchImpl: site.fetchImpl,
    logger: { warn: (m) => warned.push(m) },
  });
  await chat.ready;
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 5); });
  return { chat, seen, problems, warned, settle, last: () => seen.at(-1) };
}

test('the chat is shown only when SUPPORT_CHAT is on', async () => {
  const { supportChatOn } = await load('chat.js');
  for (const value of ['on', 'ON', 'true', 'yes', '1', ' on ']) assert.equal(supportChatOn({ SUPPORT_CHAT: value }), true, value);
  for (const value of [undefined, '', 'off', 'false', '0', 'no', 'later']) assert.equal(supportChatOn({ SUPPORT_CHAT: value }), false, String(value));
  assert.equal(supportChatOn(undefined), false);
});

test('a chat starts on this site\'s /api/chat with the number, shows the greeting and answers each message', async () => {
  const site = fakeSite(
    answer(200, { session_id: SESSION, reply: 'Namaste Satish ji, how can I help?', first_name: 'Satish' }),
    answer(200, { reply: 'Hardware K is the handle, one piece.' }),
  );
  const { chat, settle, last, problems } = await begin(site);
  assert.deepEqual([site.requests[0].url, site.requests[0].options.method, site.requests[0].body], ['https://site.test/api/chat', 'POST', { phone: PHONE }]);
  assert.equal(last().status, 'open');
  assert.deepEqual(last().messages.map((m) => [m.from, m.text]), [['agent', 'Namaste Satish ji, how can I help?']]);

  assert.equal(chat.send('  letter K kya hai?  '), true);
  assert.equal(last().waiting, true, 'the panel shows the assistant typing');
  assert.equal(chat.send('another'), false, 'nothing else is sent while a reply is coming');
  await settle();
  assert.deepEqual([site.requests[1].url, site.requests[1].body], [`https://site.test/api/chat/${SESSION}`, { text: 'letter K kya hai?' }]);
  assert.equal(last().waiting, false);
  assert.deepEqual(last().messages.map((m) => m.text), ['Namaste Satish ji, how can I help?', 'letter K kya hai?', 'Hardware K is the handle, one piece.']);
  assert.equal(new Set(last().messages.map((m) => m.id)).size, 3, 'every message has its own id');
  assert.equal(chat.send('   '), false, 'an empty message is not sent');

  chat.send('x'.repeat(600));
  await settle();
  assert.equal(site.requests[2].body.text.length, 500, 'long messages are cut to 500 characters');
  chat.end();
  await settle();
  assert.deepEqual([site.requests.at(-1).url, site.requests.at(-1).options.method], [`https://site.test/api/chat/${SESSION}`, 'DELETE']);
  assert.equal(last().status, 'ended');
  assert.deepEqual(problems.filter(Boolean), [], 'ending the chat is no problem');
});

test('a message the server could not answer can be sent again, and an ended chat says so', async () => {
  const site = fakeSite(
    answer(200, { session_id: SESSION, reply: 'Hello' }),
    answer(503, { error: 'busy_model', message: 'Sorry, I could not finish that just now.' }),
    answer(200, { reply: 'Here it is.' }),
    answer(410, { error: 'ended', message: 'This chat has ended. Please start a new chat.' }),
  );
  const { chat, settle, last, problems } = await begin(site);
  chat.send('where is my order?');
  await settle();
  assert.equal(last().status, 'open');
  assert.equal(last().waiting, false);
  assert.equal(problems.at(-1), 'Sorry, I could not finish that just now.');
  chat.send('where is my order?');
  await settle();
  assert.equal(problems.at(-1), '', 'a new message clears the problem');
  assert.equal(last().messages.at(-1).text, 'Here it is.');
  chat.send('more');
  await settle();
  assert.equal(last().status, 'ended');
  assert.equal(problems.at(-1), 'This chat has ended. Please start a new chat.');
  assert.equal(chat.send('hello?'), false);
});

test('a chat that cannot start tells the customer what to do, and how long to wait at the limit', async () => {
  const { CHAT_OFFLINE } = await load('chat.js');
  const limited = await begin(fakeSite(answer(429, { error: 'rate_limited' }, { 'retry-after': '540' })));
  assert.deepEqual(limited.problems, ['Too many chats and calls were started from this network. Please try again in about 9 min.']);
  assert.equal(limited.last().status, 'ended');

  const down = await begin(fakeSite(answer(503, { error: 'unavailable', message: 'x' })));
  assert.deepEqual(down.problems, ['Our chat is not available right now. Please try again in a little while, or call us on +91-98799-99999.']);
  assert.match(down.warned[0], /Starting a chat failed \(503\)/);

  const offline = await begin(fakeSite(new Error('Failed to fetch')));
  assert.deepEqual(offline.problems, [CHAT_OFFLINE]);
  assert.match(offline.warned[0], /Cannot reach https:\/\/site\.test: Failed to fetch/);
});

function nodeServer(...answers) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return answers.shift() || answer(200, {});
  };
  return { requests, fetchImpl };
}

const request = (body) => new Request('https://site.test/api/chat', { method: 'POST', body: JSON.stringify(body) });

test('this site\'s /api/chat starts chats on the Node server with its key, within the website call limits', async () => {
  const { startChatSession, sendChatMessage, endChatSession } = await load('chatSession.js');
  const { createLimiter } = await load('limits.js');
  const env = { NODE_API_URL: 'http://node.test/', NODE_API_KEY: 'internal-key' };
  const limiter = createLimiter({ env: {}, now: () => Date.parse('2026-11-11T06:31:00Z') });
  const node = nodeServer(...Array.from({ length: 5 }, () => answer(200, { session_id: SESSION, reply: 'Welcome' })));
  const deps = { limiter, ip: '198.51.100.9', env, fetchImpl: node.fetchImpl, logger: { error() {} } };

  const bad = await startChatSession(request({ phone: '123' }), deps);
  assert.equal(bad.status, 400);
  const first = await startChatSession(request({ phone: '98765 43210' }), deps);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { session_id: SESSION, reply: 'Welcome' });
  assert.deepEqual([node.requests[0].url, node.requests[0].options.headers['x-api-key'], node.requests[0].body], ['http://node.test/api/chat/sessions', 'internal-key', { phone: PHONE }]);
  for (let i = 0; i < 4; i += 1) await startChatSession(request({ phone: PHONE }), deps);
  const sixth = await startChatSession(request({ phone: PHONE }), deps);
  assert.equal(sixth.status, 429, 'a chat counts like a call: 5 per visitor in 10 minutes');
  assert.equal(sixth.headers.get('retry-after') !== null, true);
  assert.equal(node.requests.length, 5);

  const reply = nodeServer(answer(200, { reply: 'Sure.' }), new Response(null, { status: 204 }));
  const sent = await sendChatMessage(request({ text: 'hello' }), SESSION, { env, fetchImpl: reply.fetchImpl });
  assert.deepEqual(await sent.json(), { reply: 'Sure.' });
  assert.equal(reply.requests[0].url, `http://node.test/api/chat/sessions/${SESSION}/messages`);
  assert.equal((await sendChatMessage(request({ text: 'x' }), '../admin', { env, fetchImpl: reply.fetchImpl })).status, 410, 'only a session id goes on to the server');
  assert.equal((await endChatSession(SESSION, { env, fetchImpl: reply.fetchImpl })).status, 204);
});

test('without the Node server\'s chat, the customer gets a plain message and the site log the reason', async () => {
  const { startChatSession } = await load('chatSession.js');
  const { createLimiter } = await load('limits.js');
  const logged = [];
  const deps = (env, fetchImpl) => ({ limiter: createLimiter({ env: {} }), ip: '198.51.100.10', env, fetchImpl, logger: { error: (m) => logged.push(m) } });
  const missing = await startChatSession(request({ phone: PHONE }), deps({ NODE_API_URL: 'http://node.test' }, async () => answer(200, {})));
  assert.equal(missing.status, 503);
  assert.match(logged.at(-1), /set NODE_API_URL and NODE_API_KEY/);
  const old = await startChatSession(request({ phone: PHONE }), deps({ NODE_API_URL: 'http://node.test', NODE_API_KEY: 'k' }, async () => answer(404, { error: 'Not found' })));
  assert.equal(old.status, 503);
  assert.deepEqual(await old.json(), { error: 'unavailable', message: 'Our chat is not available right now. Please try again in a little while.' });
  assert.match(logged.at(-1), /has no website chat: deploy the latest server code, with GROQ_API_KEY and AGENT_TOOL_SECRET/);
});

test('the support page offers the chat only when SUPPORT_CHAT is on, and the panel takes the widget\'s place', () => {
  const read = (...parts) => fs.readFileSync(path.join(WEB, ...parts), 'utf8');
  const page = read('app', 'support', 'page.js');
  assert.match(page, /const chat = supportChatOn\(process\.env\);/);
  assert.match(page, /\{chat && <ChatAgent \/>\}/);
  assert.match(page, /\{chat && <StartChatButton \/>\}/);
  assert.match(page, /<VoiceAgent chat=\{chat\} \/>/);
  assert.match(read('app', 'globals.css'), /body\[data-chat\] sarvam-widget,/, 'the call widget steps aside for the chat');
  const panel = read('components', 'ChatAgent.js');
  assert.match(panel, /startChat\(\{\r?\n\s+server: location\.origin,/, 'the chat runs through this site\'s own /api/chat');
  assert.match(panel, /callerPhone\(value\)/, 'a chat needs a valid mobile number, like a call');
  assert.doesNotMatch(panel, /SARVAM_API_KEY|NODE_API_KEY|sk_samvaad/, 'no key in the chat panel');
  assert.match(read('lib', 'chatServer.js'), /^import 'server-only';/, 'the route logic that reads NODE_API_KEY stays out of browser code');
  for (const route of [['app', 'api', 'chat', 'route.js'], ['app', 'api', 'chat', '[id]', 'route.js']]) {
    assert.match(read(...route), /from '@\/lib\/chatServer\.js'/);
    assert.match(read(...route), /if \(!supportChatOn\(process\.env\)\)/, 'the routes are off with the chat');
  }
  const widget = read('components', 'VoiceAgent.js');
  assert.match(widget, /new CustomEvent\(CHAT_OPEN_EVENT, \{ detail: \{ phone: field\.input\.value, start: true \} \}\)/,
    'Chat in the call widget opens the chat with the number typed there');
  assert.match(widget, /const call = option\('call', CALL_ICON, 'Call', onCall\);\r?\n\s+const chat = option\('chat', CHAT_ICON, 'Chat', onChat\);/,
    'the panel offers two options under the number: Call and Chat');
  assert.match(widget, /button\.toggleAttribute\('data-tdc-hidden', !calling\);\r?\n\s+options\.row\.hidden = calling;/,
    'the options take the call button\'s place until a call starts');
  assert.match(widget, /if \(needPhone\(PHONE_NEEDED_CHAT\)\) return;/, 'a chat needs the number too');
  assert.match(panel, /onClick=\{callInstead\}/, 'a chat that cannot start offers the call instead');
  assert.match(read('components', 'StartChatButton.js'), /document\.body\.dataset\.voice === 'calling'/, 'no chat during a call');
  assert.match(read('lib', 'startCall.js'), /document\.body\.dataset\.chat === 'live'/, 'no call during a chat');
});
