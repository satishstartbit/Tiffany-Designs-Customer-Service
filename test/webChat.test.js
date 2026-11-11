// The website chat on /support (web/lib/chat.js): Sarvam's text chat protocol, to the same agent as the website call,
// through the same session route and limits.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web');
const load = (file) => import(pathToFileURL(path.join(WEB, 'lib', file)).href);
const LINK_PATH = '/api/sarvam/orgs/01a0c3a4-b74a-7441-813a-d7d799923769/workspaces/01a0c3ef-4753-7a81-a20c-07f739dcf1d6'
  + '/apps/Tiffany-Des-4ab4474a-620f/url';
const PHONE = '+919876543210';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.listeners = {};
    FakeSocket.made.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code });
  }
}
FakeSocket.made = [];

function fakeRoute(status, answer, headers = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      status,
      ok: status < 400,
      json: async () => (typeof answer === 'string' ? JSON.parse(answer) : answer),
      text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)),
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    };
  };
  return { requests, fetchImpl };
}

const LINK = { url: 'wss://apps.sarvam.test/s?token=t1', reference_id: 'r1', caller: { phone: PHONE, first_name: 'Satish' } };

async function begin({ route = fakeRoute(200, LINK), ...options } = {}) {
  const { startChat } = await load('chat.js');
  FakeSocket.made = [];
  const seen = [];
  const problems = [];
  const warned = [];
  const chat = startChat({
    server: 'https://site.test',
    phone: PHONE,
    userId: 'tiffany-chat-1',
    onChange: (t) => seen.push(t),
    onProblem: (p) => problems.push(p),
    fetchImpl: route.fetchImpl,
    WebSocketImpl: FakeSocket,
    logger: { warn: (m) => warned.push(m) },
    ...options,
  });
  await chat.ready;
  return { chat, route, seen, problems, warned, socket: FakeSocket.made[0], last: () => seen.at(-1) };
}

test('the chat is shown only when SUPPORT_CHAT is on', async () => {
  const { supportChatOn } = await load('chat.js');
  for (const value of ['on', 'ON', 'true', 'yes', '1', ' on ']) assert.equal(supportChatOn({ SUPPORT_CHAT: value }), true, value);
  for (const value of [undefined, '', 'off', 'false', '0', 'no', 'later']) assert.equal(supportChatOn({ SUPPORT_CHAT: value }), false, String(value));
  assert.equal(supportChatOn(undefined), false);
});

test('a chat link comes from the call session route, and the socket gets what Sarvam\'s SDK adds', async () => {
  const { chatLinkUrl, chatSocketUrl } = await load('chat.js');
  assert.equal(chatLinkUrl('https://site.test'), `https://site.test${LINK_PATH}?interaction_type=chat`);
  assert.equal(chatSocketUrl('wss://apps.sarvam.test/s?token=t1', 'tiffany-chat-1'),
    'wss://apps.sarvam.test/s?token=t1&user_identifier=tiffany-chat-1&user_identifier_type=custom&interaction_type=chat');
  assert.equal(chatSocketUrl('wss://apps.sarvam.test/s', 'a b'),
    'wss://apps.sarvam.test/s?user_identifier=a%20b&user_identifier_type=custom&interaction_type=chat');
});

test('the session route hands out chat links within the call limits', async () => {
  const { startWebSession } = await load('webSession.js');
  const { createLimiter } = await load('limits.js');
  const env = { SARVAM_API_KEY: 'sk_samvaad_test', SARVAM_APP_VERSION: '26' };
  const limiter = createLimiter({ env, now: () => Date.parse('2026-11-11T06:31:00Z') });
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return { status: 200, ok: true, text: async () => '{"url":"wss://apps.sarvam.test/s?token=t1","reference_id":"r1"}', headers: { get: () => null } };
  };
  const params = { orgId: '01a0c3a4-b74a-7441-813a-d7d799923769', workspaceId: '01a0c3ef-4753-7a81-a20c-07f739dcf1d6', appId: 'Tiffany-Des-4ab4474a-620f' };
  const start = () => startWebSession({ params, searchParams: new URLSearchParams('interaction_type=chat'), ip: '198.51.100.9', phone: PHONE },
    { limiter, env, fetchImpl, logger: { error() {} }, lookupCaller: async () => 'Satish' });
  const first = await start();
  assert.equal(first.status, 200);
  assert.match(requests[0], /\/url\?interaction_type=chat&version=26$/);
  assert.deepEqual(JSON.parse(first.body).caller, { phone: PHONE, first_name: 'Satish' });
  for (let i = 0; i < 4; i += 1) await start();
  const sixth = await start();
  assert.equal(sixth.status, 429, 'a chat counts like a call: 5 per visitor in 10 minutes');
  assert.equal(requests.length, 5);
});

test('a chat starts with the same caller variables as a website call', async () => {
  const { chatStartMessage, chatTextMessage, chatPong } = await load('chat.js');
  const { withCallerPhone, CALL_START } = await load('caller.js');
  const now = () => 1700000000000;
  const start = chatStartMessage({ phone: PHONE, name: 'Satish', now });
  const fromWidget = JSON.parse(withCallerPhone(JSON.stringify({ type: CALL_START }), PHONE, 'Satish'));
  assert.deepEqual(start, { type: CALL_START, origin: 'client', timestamp: 1700000000, agent_variables: fromWidget.agent_variables });
  assert.equal(start.agent_variables.customer_name, 'Satish');
  assert.equal(chatStartMessage({ phone: PHONE, now }).agent_variables.customer_name, undefined, 'no name for a number not on record');
  assert.deepEqual(chatTextMessage('Where is my order?', now), { type: 'client.media.text', origin: 'client', timestamp: 1700000000, text: 'Where is my order?' });
  assert.deepEqual(chatPong(7, now), { type: 'client.system.pong', origin: 'client', timestamp: 1700000000, event_id: 7 });
});

test('streamed and whole agent messages build one transcript', async () => {
  const { newTranscript, applyServerMessage, addCustomerText } = await load('chat.js');
  const run = (messages, state = newTranscript()) => messages.reduce((s, m) => applyServerMessage(s, m).state, state);
  let state = run([{ type: 'server.action.interaction_connected', interaction_id: 'i-1' }]);
  assert.equal(state.status, 'open');

  // Pieces with only the new words, then the whole reply again: one message.
  state = run([
    { type: 'server.media.text_chunk', text: 'Namaste, ', status: 'pending' },
    { type: 'server.media.text_chunk', text: 'how can I help?', status: 'pending' },
    { type: 'server.media.text_chunk', text: '', status: 'completed' },
    { type: 'server.media.text', text: 'Namaste, how can I help?' },
  ], state);
  assert.deepEqual(state.messages.map((m) => [m.from, m.text, m.done]), [['agent', 'Namaste, how can I help?', true]]);

  state = addCustomerText(state, 'Where is my order?');
  assert.equal(state.waiting, true);
  // Pieces with the reply so far, after a tool call.
  state = run([
    { type: 'server.event.tool_call', name: 'order_lookup' },
    { type: 'server.media.text_chunk', text: 'Your study table', status: 'pending' },
    { type: 'server.media.text_chunk', text: 'Your study table was delivered.', status: 'completed' },
  ], state);
  assert.equal(state.waiting, false);
  assert.deepEqual(state.messages.map((m) => m.text), ['Namaste, how can I help?', 'Where is my order?', 'Your study table was delivered.']);

  // A whole message on its own; the same words after the customer wrote again are a new answer.
  state = run([{ type: 'server.media.text', text: 'Anything else?' }], state);
  state = addCustomerText(state, 'Say that again');
  state = run([{ type: 'server.media.text', text: 'Anything else?' }], state);
  assert.equal(state.messages.length, 6);
  assert.equal(new Set(state.messages.map((m) => m.id)).size, 6, 'every message has its own id');

  const { reply } = applyServerMessage(state, { type: 'server.system.ping', event_id: 42 });
  assert.equal(reply.type, 'client.system.pong');
  assert.equal(reply.event_id, 42);

  state = run([{ type: 'server.media.text_chunk', text: 'Thank you', status: 'pending' }, { type: 'server.action.interaction_end' }], state);
  assert.equal(state.status, 'ended');
  assert.equal(state.messages.at(-1).done, true, 'an unfinished reply is closed when the chat ends');
  assert.equal(applyServerMessage(state, { type: 'server.event.state_transition' }).state, state, 'other events change nothing');
});

test('a chat asks for its link with the number, starts with the caller variables and keeps the transcript', async () => {
  const { callerVariables } = await load('caller.js');
  const { chat, route, socket, problems, last } = await begin();
  assert.equal(route.requests[0].url, `https://site.test${LINK_PATH}?interaction_type=chat`);
  assert.equal(route.requests[0].options.headers['X-Caller-Phone'], PHONE, 'so the route can name a known customer');
  assert.equal(socket.url, 'wss://apps.sarvam.test/s?token=t1&user_identifier=tiffany-chat-1&user_identifier_type=custom&interaction_type=chat');
  assert.equal(last().status, 'connecting');
  assert.equal(chat.send('too early'), false, 'nothing is sent before the chat is open');

  socket.open();
  assert.equal(socket.sent[0].type, 'client.action.interaction_start');
  assert.deepEqual(socket.sent[0].agent_variables, callerVariables(PHONE, 'Satish'), 'the first name the route found greets the customer');
  socket.receive({ type: 'server.action.interaction_connected', interaction_id: 'i-1' });
  socket.receive({ type: 'server.media.text', text: 'Namaste Satish ji, how can I help?' });
  socket.receive({ type: 'server.system.ping', event_id: 5 });
  assert.deepEqual([socket.sent.at(-1).type, socket.sent.at(-1).event_id], ['client.system.pong', 5]);

  assert.equal(chat.send('  Where is my study table?  '), true);
  assert.deepEqual([socket.sent.at(-1).type, socket.sent.at(-1).text], ['client.media.text', 'Where is my study table?']);
  assert.equal(last().waiting, true);
  assert.deepEqual(last().messages.map((m) => m.from), ['agent', 'customer']);
  assert.equal(chat.send('   '), false, 'an empty message is not sent');
  chat.send('x'.repeat(600));
  assert.equal(socket.sent.at(-1).text.length, 500, 'long messages are cut to 500 characters');

  chat.end();
  assert.equal(socket.readyState, 3);
  assert.equal(last().status, 'ended');
  assert.deepEqual(problems, [], 'ending the chat is no problem');
});

test('the agent ending the chat closes it without a problem', async () => {
  const { socket, problems, last } = await begin();
  socket.open();
  socket.receive({ type: 'server.action.interaction_connected' });
  socket.receive({ type: 'server.media.text', text: 'Thank you for contacting Tiffany Designs.' });
  socket.receive({ type: 'server.action.interaction_end' });
  assert.equal(last().status, 'ended');
  assert.equal(socket.readyState, 3);
  assert.deepEqual(problems, []);
});

test('when Sarvam has no chat for the agent, the customer gets a plain message and staff the reason', async () => {
  const { problems, warned, last, socket } = await begin({ route: fakeRoute(404, '{"detail":"App not found for the interaction type"}') });
  assert.equal(socket, undefined, 'no socket without a link');
  assert.equal(last().status, 'ended');
  assert.deepEqual(problems, ['Our chat is not available right now. Please try again in a little while, or call us on +91-98799-99999.']);
  assert.match(warned[0], /Sarvam has no text chat for agent Tiffany-Des-4ab4474a-620f/);
  assert.match(warned[0], /turn SUPPORT_CHAT off/);
});

test('the call limits show the customer how long to wait', async () => {
  const { problems } = await begin({ route: fakeRoute(429, '{"error":"rate_limited"}', { 'retry-after': '540' }) });
  assert.deepEqual(problems, ['Too many chats and calls were started from this network. Please try again in about 9 min.']);
});

test('a chat that cannot connect or drops tells the customer what to do', async () => {
  const { CHAT_OFFLINE, CHAT_DROPPED } = await load('chat.js');
  const offline = await begin({ route: { fetchImpl: async () => { throw new Error('Failed to fetch'); } } });
  assert.deepEqual(offline.problems, [CHAT_OFFLINE]);
  assert.match(offline.warned[0], /Cannot reach https:\/\/site\.test: Failed to fetch/);

  const dropped = await begin();
  dropped.socket.open();
  dropped.socket.receive({ type: 'server.action.interaction_connected' });
  dropped.socket.receive({ type: 'server.media.text', text: 'Namaste' });
  dropped.socket.close(1006);
  assert.deepEqual(dropped.problems, [CHAT_DROPPED]);
  assert.equal(dropped.last().status, 'ended');

  const refused = await begin();
  refused.socket.close(1006);
  assert.match(refused.problems[0], /^Our chat is not available right now/, 'closed before it started');
});

test('a chat Sarvam never starts gives up', async () => {
  const { socket, problems, last } = await begin({ connectTimeoutMs: 20 });
  socket.open();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(problems[0], /^Our chat is not available right now/);
  assert.equal(last().status, 'ended');
  assert.equal(socket.readyState, 3);
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
  assert.match(panel, /startChat\(\{/);
  assert.match(panel, /callerPhone\(value\)/, 'a chat needs a valid mobile number, like a call');
  assert.doesNotMatch(panel, /SARVAM_API_KEY|NODE_API_KEY|sk_samvaad/, 'no key in the chat panel');
  const widget = read('components', 'VoiceAgent.js');
  assert.match(widget, /new CustomEvent\(CHAT_OPEN_EVENT, \{ detail: \{ phone: field\.input\.value, start: true \} \}\)/,
    'Start chat in the call widget opens the chat with the number typed there');
  assert.match(read('components', 'StartChatButton.js'), /document\.body\.dataset\.voice === 'calling'/, 'no chat during a call');
  assert.match(read('components', 'StartCallButton.js'), /document\.body\.dataset\.chat === 'live'/, 'no call during a chat');
});
