// The Next.js site in web/ (deployed on Vercel): its own session endpoint for the browser call widget.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web');
// web/ is an ES module package (its package.json says "type": "module").
const load = (file) => import(pathToFileURL(path.join(WEB, 'lib', file)).href);

const AGENT_PARAMS = { orgId: '01a0c3a4-b74a-7441-813a-d7d799923769', workspaceId: '01a0c3ef-4753-7a81-a20c-07f739dcf1d6', appId: 'Tiffany-Des-0db8e21d-e099' };
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
    + '/workspaces/01a0c3ef-4753-7a81-a20c-07f739dcf1d6/apps/Tiffany-Des-0db8e21d-e099/url?interaction_type=call&version=3');
  assert.equal(sarvam.requests[0].options.headers['X-API-Key'], 'sk_samvaad_test', 'a pasted key loses its quotes and spaces');
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
  assert.deepEqual(api.match(/signedIn: false/g), ['signedIn: false'], 'only one read goes without a sign-in');
  assert.match(api, /callAdmin\('service', \{ signedIn: false \}\)/, 'and it is the service hours');
  assert.match(api, /answer\.hours/, 'of which only the hours are passed on');
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

test('the sign-in details are shown only while developing, never on a deployed site', () => {
  const page = fs.readFileSync(path.join(WEB, 'app', 'login', 'page.js'), 'utf8');
  assert.match(page, /process\.env\.NODE_ENV !== 'production' && config\.ready \? \{ email: config\.email, password: config\.password \} : null/);
});

test('the call widget shows the agent name instead of its maker\'s, and its style sheet is left alone', () => {
  const widget = fs.readFileSync(path.join(WEB, 'components', 'VoiceAgent.js'), 'utf8');
  assert.match(widget, /const PANEL_TITLE = `\$\{AGENT_NAME\}, Tiffany Designs`;/);
  assert.match(widget, /\['STYLE', 'SCRIPT'\]\.includes\(node\.parentElement\?\.tagName\) \? NodeFilter\.FILTER_REJECT/, 'animation names in the widget CSS keep working');
  assert.match(fs.readFileSync(path.join(WEB, 'lib', 'agent.js'), 'utf8'), /export const AGENT_NAME = 'Satish Choudhary';/);
});
