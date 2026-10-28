// The Next.js site in web/ (deployed on Vercel): its own session endpoint for the browser call widget.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web');
// web/ is an ES module package (its package.json says "type": "module").
const load = (file) => import(pathToFileURL(path.join(WEB, 'lib', file)).href);

const AGENT_PARAMS = { orgId: '01a0c3a4-b74a-7441-813a-d7d799923769', workspaceId: '01a0c3ef-4753-7a81-a20c-07f739dcf1d6', appId: 'Tiffany-Des-4ab4474a-620f' };
const LINK = '{"url":"wss://apps.sarvam.test/session?token=t1","reference_id":"ref-1"}';

function fakeSarvam(status = 200, body = LINK, headers = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { status, ok: status < 400, text: async () => body, headers: { get: (name) => headers[name.toLowerCase()] ?? null } };
  };
  return { requests, fetchImpl };
}

async function setup({ env = {}, status, body, headers } = {}) {
  const { startWebSession } = await load('webSession.js');
  const { createLimiter } = await load('limits.js');
  const clock = { now: Date.parse('2026-10-15T06:31:00Z') };
  const fullEnv = { SARVAM_API_KEY: 'sk_samvaad_test', ...env };
  const limiter = createLimiter({ env: fullEnv, now: () => clock.now });
  const sarvam = fakeSarvam(status, body, headers);
  const logged = [];
  const start = ({ ip = '198.51.100.7', params = AGENT_PARAMS, query = 'interaction_type=call' } = {}) => startWebSession(
    { params, searchParams: new URLSearchParams(query), ip },
    { limiter, env: fullEnv, fetchImpl: sarvam.fetchImpl, logger: { error: (m) => logged.push(m) } },
  );
  return { start, sarvam, clock, logged };
}

test('the site asks Sarvam for a signed call URL with the server key and the server agent version', async () => {
  const { start, sarvam } = await setup({ env: { SARVAM_API_KEY: ' "sk_samvaad_test" ', SARVAM_APP_VERSION: '3' } });
  const res = await start({ query: 'interaction_type=call&version=99' });
  assert.equal(res.status, 200);
  assert.equal(res.body, LINK);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(sarvam.requests[0].url, 'https://apps.sarvam.ai/api/app-runtime/orgs/01a0c3a4-b74a-7441-813a-d7d799923769'
    + '/workspaces/01a0c3ef-4753-7a81-a20c-07f739dcf1d6/apps/Tiffany-Des-4ab4474a-620f/url?interaction_type=call&version=3');
  assert.equal(sarvam.requests[0].options.headers['X-API-Key'], 'sk_samvaad_test', 'a pasted key loses its quotes and spaces');
});

test('with the number the customer typed, the call link also names the customer\'s first name, and only then', async () => {
  const { startWebSession } = await load('webSession.js');
  const { createLimiter } = await load('limits.js');
  const asked = [];
  const lookupCaller = async (phone) => { asked.push(phone); return phone === '+917357558134' ? 'Satish' : null; };
  const session = (input, options = {}) => startWebSession(
    { params: AGENT_PARAMS, searchParams: new URLSearchParams('interaction_type=call'), ip: '198.51.100.7', ...input },
    { limiter: createLimiter({ env: {} }), env: { SARVAM_API_KEY: 'k' }, fetchImpl: fakeSarvam().fetchImpl, logger: { error() {} }, lookupCaller, ...options },
  );

  const known = await session({ phone: '73575 58134' });
  assert.deepEqual(JSON.parse(known.body), { ...JSON.parse(LINK), caller: { phone: '+917357558134', first_name: 'Satish' } });
  assert.deepEqual(asked, ['+917357558134'], 'looked up in +91 form');
  assert.deepEqual(JSON.parse((await session({ phone: '9123456780' })).body).caller, { phone: '+919123456780', first_name: null }, 'an unknown number gets no name');

  assert.equal((await session({ phone: null })).body, LINK, 'no number, no lookup');
  assert.equal((await session({ phone: '12345' })).body, LINK, 'nor for something that is not a mobile number');
  assert.equal((await session({ phone: '7357558134' }, { fetchImpl: fakeSarvam(429, '{"detail":"slow down"}').fetchImpl })).status, 429);
  assert.equal(asked.length, 2, 'nobody is looked up without a call link');
  const broken = await session({ phone: '7357558134' }, { lookupCaller: async () => { throw new Error('Node is asleep'); } });
  assert.deepEqual(JSON.parse(broken.body), { ...JSON.parse(LINK), caller: { phone: '+917357558134', first_name: null } }, 'a failed lookup still starts the call, with the number');
});

test('only the Tiffany agent can be reached, and nothing works without a key', async () => {
  const { start, sarvam } = await setup();
  for (const params of [{ ...AGENT_PARAMS, appId: 'Arogaya-Hos-ec23d46a-0bcc' }, { ...AGENT_PARAMS, orgId: 'other' }, { ...AGENT_PARAMS, workspaceId: 'other' }]) {
    assert.equal((await start({ params })).status, 404);
  }
  assert.equal(sarvam.requests.length, 0);

  const noKey = await setup({ env: { SARVAM_API_KEY: '' } });
  const res = await noKey.start();
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).error, 'not_configured');
});

test('a refused key is a plain "not available" for the visitor, logged for the owner, and not counted', async () => {
  const { start, logged } = await setup({ status: 401, body: '{"error":{"data":{"details":"Invalid API key format."}}}' });
  for (let i = 0; i < 6; i += 1) {
    const res = await start();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
  }
  assert.match(logged[0], /Invalid API key format/);
});

test('a visitor can start 5 calls in 10 minutes and 20 a day; others are not affected', async () => {
  const { start, clock } = await setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await start()).status, 200);
  const blocked = await start();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal((await start({ ip: '203.0.113.9' })).status, 200, 'another visitor');
  for (let block = 0; block < 3; block += 1) {
    clock.now += 10 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) assert.equal((await start()).status, 200);
  }
  clock.now += 10 * 60 * 1000;
  assert.equal((await start()).status, 429, 'the 21st call of the day');
});

test('an overall hourly cap stops a flood from many addresses', async () => {
  const { start, sarvam } = await setup({ env: { WEB_CALLS_MAX_PER_HOUR: '2' } });
  assert.equal((await start({ ip: '203.0.113.1' })).status, 200);
  assert.equal((await start({ ip: '203.0.113.2' })).status, 200);
  assert.equal((await start({ ip: '203.0.113.3' })).status, 429);
  assert.equal(sarvam.requests.length, 2);
});

test('Sarvam\'s own limits pass through, and an outage is a 502', async () => {
  const limited = await setup({ status: 429, body: '{"detail":"slow down"}', headers: { 'retry-after': '30' } });
  const res = await limited.start();
  assert.equal(res.status, 429);
  assert.equal(res.headers['Retry-After'], '30');

  const { startWebSession } = await load('webSession.js');
  const { createLimiter } = await load('limits.js');
  const down = await startWebSession(
    { params: AGENT_PARAMS, searchParams: new URLSearchParams(), ip: '198.51.100.7' },
    { limiter: createLimiter({ env: {} }), env: { SARVAM_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('offline'); }, logger: { error() {} } },
  );
  assert.equal(down.status, 502);
});

test('with Upstash connected, the counts are shared through Redis', async () => {
  const { createLimiter } = await load('limits.js');
  const sent = [];
  const counts = new Map();
  const fetchImpl = async (url, options) => {
    const commands = JSON.parse(options.body);
    sent.push({ url, auth: options.headers.Authorization, commands });
    const results = commands.map(([cmd, key]) => {
      if (cmd === 'GET') return { result: counts.has(key) ? String(counts.get(key)) : null };
      if (cmd === 'INCR') { counts.set(key, (counts.get(key) || 0) + 1); return { result: counts.get(key) }; }
      return { result: 1 };
    });
    return { ok: true, json: async () => results };
  };
  const limiter = createLimiter({ env: { KV_REST_API_URL: 'https://redis.example/', KV_REST_API_TOKEN: 'tok' }, now: () => 0, fetchImpl });
  assert.equal((await limiter.check('1.2.3.4')).allowed, true);
  for (let i = 0; i < 5; i += 1) await limiter.record('1.2.3.4');
  assert.deepEqual(await limiter.check('1.2.3.4'), { allowed: false, retryAfterSeconds: 600 });
  assert.equal(sent[0].url, 'https://redis.example/pipeline');
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.deepEqual(sent[1].commands.slice(0, 2), [['INCR', 'tiffany-web:ip_10min:1.2.3.4:0'], ['PEXPIREAT', 'tiffany-web:ip_10min:1.2.3.4:0', '600000']]);
});

test('the page uses the site\'s own endpoint by default and holds no key', () => {
  const page = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(page, /session-endpoint=\{`\$\{server\}\/api\/sarvam\/`\}/);
  assert.match(page, /\|\| CONFIGURED_SERVER \|\| location\.origin/);
  assert.doesNotMatch(page, /api-key|sk_/, 'no API key in the browser code');
  assert.ok(fs.existsSync(path.join(WEB, 'app', 'api', 'sarvam', 'orgs', '[orgId]', 'workspaces', '[workspaceId]', 'apps', '[appId]', 'url', 'route.js')),
    'the route sits where the widget looks: {endpoint}orgs/{org}/workspaces/{ws}/apps/{app}/url');
});

test('the mobile number typed above the widget goes into the call as customer_phone, and nothing else changes', async () => {
  const { callerPhone, withCallerPhone, openingLine, CALL_START } = await load('caller.js');
  for (const [typed, phone] of [['98765 43210', '+919876543210'], ['+91 98765-43210', '+919876543210'], ['098765 43210', '+919876543210'],
    ['12345', null], ['5876543210', null], ['', null]]) {
    assert.equal(callerPhone(typed), phone, typed);
  }
  const start = JSON.stringify({ type: CALL_START, origin: 'client', timestamp: 1 });
  const welcome = "Namaste, welcome to Tiffany Designs. I'm the AI service assistant. Hindi or English?";
  assert.equal(openingLine(), welcome);
  assert.deepEqual(JSON.parse(withCallerPhone(start, '+919876543210')), {
    type: CALL_START, origin: 'client', timestamp: 1, agent_variables: { customer_phone: '+919876543210', opening_line: welcome },
  });
  const withVariables = JSON.stringify({ type: CALL_START, agent_variables: { call_reason: 'inbound' } });
  assert.deepEqual(JSON.parse(withCallerPhone(withVariables, '+919876543210')).agent_variables,
    { call_reason: 'inbound', customer_phone: '+919876543210', opening_line: welcome });
  assert.deepEqual(JSON.parse(withCallerPhone(start, '+919876543210', 'Satish')).agent_variables, {
    customer_phone: '+919876543210',
    opening_line: "Namaste Satish ji, welcome to Tiffany Designs. I'm the AI service assistant. Hindi or English?",
    customer_name: 'Satish',
  }, 'a known customer is welcomed by first name, which also goes in as customer_name');
  assert.equal(withCallerPhone(start, null), start, 'no number, no change');
  const audio = JSON.stringify({ type: 'client.media.audio_chunk', audio_base64: 'AAAA' });
  assert.equal(withCallerPhone(audio, '+919876543210'), audio, 'only the call-start message');
  const bytes = new Uint8Array([1]);
  assert.equal(withCallerPhone(bytes, '+919876543210'), bytes);

  const widget = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(widget, /WebSocket\.prototype\.send = function send\(data\) \{\n\s+const sent = withCallerPhone\(data, callerRef\.current, callerNameRef\.current\);/);
  assert.match(widget, /headers\.set\('X-Caller-Phone', callerRef\.current\);/, 'the call link request carries the number for the lookup');
  assert.match(widget, /const caller = await res\.clone\(\)\.json\(\)\.then\(\(answer\) => answer\?\.caller \|\| null\)/);
  assert.match(widget, /callerNameRef\.current = caller\?\.first_name \|\| null;/);
  assert.match(widget, /WebSocket\.prototype\.send = nativeSend;/, 'the browser\'s own send comes back when the widget goes away');
  assert.match(widget, /id: 'caller-mobile'/, 'the field is in the widget\'s panel');
  assert.match(widget, /if \(field\.block\.nextElementSibling !== button\) button\.before\(field\.block\);/, 'right above its call button');
});

test('a call cannot start without a valid mobile number', () => {
  const widget = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(widget, /if \(!button \|\| !\/start call\/i\.test\(button\.textContent \|\| ''\) \|\| callerRef\.current\) return;\n\s+event\.preventDefault\(\);\n\s+event\.stopImmediatePropagation\(\);/,
    'the call button\'s click is stopped before the widget sees it');
  assert.match(widget, /root\.addEventListener\('click', guard, true\);/, 'on the way in, before the widget\'s own handler');
  assert.match(widget, /if \(!callerRef\.current\) \{\n\s+show\(PHONE_NEEDED, true\);\n\s+return new Response\(JSON\.stringify\(\{ error: 'phone_required'/,
    'and no call link is asked for without a number');
});

test('the console session cookie is signed and expires', async () => {
  const { signToken, verifyToken, sameSecret } = await load('token.js');
  const secret = 'x'.repeat(40);
  const now = Date.parse('2026-10-15T06:00:00Z');
  const token = signToken({ email: 'admin@tiffanydesigns.in' }, secret, { maxAgeSeconds: 3600, now });

  assert.equal(verifyToken(token, secret, { now: now + 1000 }).email, 'admin@tiffanydesigns.in');
  assert.equal(verifyToken(token, secret, { now: now + 3601 * 1000 }), null, 'expired');
  assert.equal(verifyToken(token, 'y'.repeat(40), { now }), null, 'signed with another secret');
  const [body, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'someone@else.in', exp: now + 1e9 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${signature}`, secret, { now }), null, 'a changed body fails the signature');
  assert.equal(verifyToken(`${body}.${signature}.x`, secret, { now }), null);
  assert.equal(verifyToken('', secret, { now }), null);

  assert.equal(sameSecret('open sesame', 'open sesame'), true);
  assert.equal(sameSecret('open sesam', 'open sesame'), false);
  assert.equal(sameSecret('', ''), false, 'an unset password never matches');
});

test('the console key and session code never reach browser code', () => {
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.js$/.test(entry.name) ? [full] : [];
  });
  const sources = [...files(path.join(WEB, 'app')), ...files(path.join(WEB, 'components'))].map((file) => [file, fs.readFileSync(file, 'utf8')]);
  const client = sources.filter(([, text]) => /^\s*['"]use client['"]/.test(text));
  assert.ok(client.length >= 3, 'the client components were found');
  for (const [file, text] of client) {
    assert.doesNotMatch(text, /lib\/(api|session)(\.js)?['"]/, `${path.relative(WEB, file)} must not import server-only code`);
    assert.doesNotMatch(text, /NODE_API_KEY|ADMIN_PASSWORD|SESSION_SECRET|SARVAM_API_KEY\b(?!.*(missing|refused))/, path.relative(WEB, file));
  }
  for (const lib of ['api.js', 'session.js']) {
    assert.match(fs.readFileSync(path.join(WEB, 'lib', lib), 'utf8'), /^import 'server-only';/, `lib/${lib} is marked server-only`);
  }
  assert.match(fs.readFileSync(path.join(WEB, 'app', '(console)', 'layout.js'), 'utf8'), /await requireSession\(\)/, 'every console page needs a sign-in');
  const api = fs.readFileSync(path.join(WEB, 'lib', 'api.js'), 'utf8');
  assert.match(api, /signedIn = true \} = \{\}\) \{\n\s+const session = signedIn \? await requireSession\(\) : null;/, 'data reads check the sign-in by default');
  assert.deepEqual(api.match(/signedIn: false/g), ['signedIn: false', 'signedIn: false'], 'only two reads go without a sign-in');
  assert.match(api, /callAdmin\('service', \{ signedIn: false \}\)/, 'the service hours');
  assert.match(api, /answer\.hours/, 'of which only the hours are passed on');
  assert.match(api, /callAdmin\('caller', \{ params: \{ phone \}, signedIn: false \}\);\n\s+return answer\?\.found \? answer\.first_name \|\| null : null;/,
    'and a caller\'s first name, nothing else');
  const route = fs.readFileSync(path.join(WEB, 'app', 'api', 'sarvam', 'orgs', '[orgId]', 'workspaces', '[workspaceId]', 'apps', '[appId]', 'url', 'route.js'), 'utf8');
  assert.match(route, /\{ limiter, lookupCaller \}/, 'which only the call session route asks for');
});

test('the voice agent is on the public customer page, not in the staff console', () => {
  const read = (...parts) => fs.readFileSync(path.join(WEB, 'app', ...parts), 'utf8');
  assert.doesNotMatch(read('(console)', 'layout.js'), /VoiceAgent/, 'the console has no call widget');
  const support = read('support', 'page.js');
  assert.match(support, /<VoiceAgent \/>/);
  assert.match(support, /<StartCallButton/);
  assert.doesNotMatch(support, /requireSession|loadAdmin|sendAdmin/, 'the customer page needs no sign-in and reads no staff data');
  assert.match(read('call', 'page.js'), /permanentRedirect\('\/support'\)/, 'the old call page link still works');
  const widget = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(widget, /console\.warn\(`\[voice\] \$\{explain\(res, active\)\}`\)/, 'server details go to the console for staff');
  assert.doesNotMatch(widget, /show\(explain/, 'customers never see server details');
});

function fakeNode(status, answer) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { status, ok: status < 400, json: async () => answer };
  };
  return { requests, fetchImpl };
}

test('the invoice page forwards only the file to the Node server, and passes on only plain answers', async () => {
  const { forwardInvoiceUpload } = await load('invoiceUpload.js');
  const env = { NODE_API_URL: 'https://node.example.test/' };
  const quiet = { error() {} };
  const node = fakeNode(200, { status: 'matched', message: 'Thank you.', invoice_number: 'INV-1', detail: 'internal' });
  const res = await forwardInvoiceUpload(
    { method: 'POST', contentType: 'image/jpeg; charset=binary', body: async () => new Uint8Array([1, 2, 3]), ip: '198.51.100.7' },
    { env, fetchImpl: node.fetchImpl, logger: quiet },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'matched', invoice_number: 'INV-1', message: 'Thank you.' }, 'nothing else from the server reaches the browser');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const [sent] = node.requests;
  assert.equal(sent.url, 'https://node.example.test/api/invoice-uploads');
  assert.deepEqual(sent.options.headers, { 'X-Forwarded-For': '198.51.100.7', 'Content-Type': 'image/jpeg' });
  assert.deepEqual([...sent.options.body], [1, 2, 3]);

  const unread = async () => { throw new Error('the body must not be read'); };
  const call = (input, options = {}) => forwardInvoiceUpload({ method: 'POST', contentType: 'image/png', body: unread, ...input },
    { env, fetchImpl: node.fetchImpl, logger: quiet, ...options });
  assert.equal((await call({ contentType: 'text/html' })).status, 415);
  assert.equal((await call({ contentLength: String(5 * 1024 * 1024) })).status, 413);
  assert.equal((await call({ body: async () => new Uint8Array(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await call({}, { env: {} })).status, 503, 'without NODE_API_URL');
  assert.equal(node.requests.length, 1);

  const oldServer = await call({ method: 'GET' }, { fetchImpl: fakeNode(404, { error: 'Not found' }).fetchImpl });
  assert.equal(oldServer.status, 503, 'a server without the upload route is "not available"');
  const crashed = await call({ method: 'GET' }, { fetchImpl: fakeNode(502, { error: 'Upstream request failed', detail: 'Salesforce said no' }).fetchImpl });
  assert.deepEqual(JSON.parse(crashed.body), { error: 'upstream_failed', message: 'Something went wrong. Please try again in a minute.' });
  const asleep = await call({ method: 'GET' }, { fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(asleep.status, 502);
});

test('the invoice upload page has one public address, asks only for the file, reads no staff data and holds no key', () => {
  const read = (...parts) => fs.readFileSync(path.join(WEB, ...parts), 'utf8');
  const page = read('app', 'invoice', 'page.js');
  assert.match(page, /<InvoiceUpload \/>/);
  assert.doesNotMatch(page, /requireSession|loadAdmin|loadSupportHours|sendAdmin|lib\/api/, 'the page reads nothing from the console API');
  const route = read('app', 'api', 'invoice', 'route.js');
  const lib = read('lib', 'invoiceUpload.js');
  const widget = read('components', 'InvoiceUpload.js');
  for (const source of [route, lib, widget]) {
    assert.doesNotMatch(source, /NODE_API_KEY|lib\/api|lib\/session|SARVAM_API_KEY|OPENAI/, 'no key is involved');
  }
  assert.match(widget, /^'use client';/);
  assert.equal((widget.match(/<input /g) || []).length, 1, 'the only field is the file');
  assert.match(widget, /<input ref=\{input\} className="sr-only" id="invoice-file" type="file"/);
  assert.match(lib, /`\$\{server\}\/api\/invoice-uploads`/);
});

test('the sign-in details are shown only while developing, never on a deployed site', () => {
  const page = fs.readFileSync(path.join(WEB, 'app', 'login', 'page.js'), 'utf8');
  assert.match(page, /process\.env\.NODE_ENV !== 'production' && config\.ready \? \{ email: config\.email, password: config\.password \} : null/);
});

test('the call widget shows the agent name instead of its maker\'s, and its style sheet is left alone', () => {
  const widget = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(widget, /const PANEL_TITLE = AGENT_NAME;/);
  assert.match(widget, /\['STYLE', 'SCRIPT'\]\.includes\(node\.parentElement\?\.tagName\) \? NodeFilter\.FILTER_REJECT/, 'animation names in the widget CSS keep working');
  assert.match(fs.readFileSync(path.join(WEB, 'lib', 'agent.js'), 'utf8'), /export const AGENT_NAME = 'Tiffany Designs AI service assistant';/);
});
