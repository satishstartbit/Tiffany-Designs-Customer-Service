import { callerPhone } from './caller.js';

// This site's /api/chat: the website chat runs on the Node server (/api/chat there), which is called with its key
// (NODE_API_KEY), kept on this server. A new chat counts against the same per-visitor limits as a website call.
// The route files reach these through chatServer.js, which keeps them out of browser code.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = { error: 'unavailable', message: 'Our chat is not available right now. Please try again in a little while.' };

const json = (status, body, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

async function callChat(path, { method = 'POST', body } = {}, { env = process.env, fetchImpl = (...args) => fetch(...args), logger = console } = {}) {
  const server = String(env.NODE_API_URL || '').replace(/\/+$/, '');
  const key = env.NODE_API_KEY;
  if (!server || !key) {
    logger.error('The website chat is off: set NODE_API_URL and NODE_API_KEY (the Node server\'s INTERNAL_API_KEY) in this site\'s environment.');
    return json(503, UNAVAILABLE);
  }
  let res;
  try {
    res = await fetchImpl(`${server}/api/chat/${path}`, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(70_000),
    });
  } catch (err) {
    logger.error(`The website chat cannot reach the Node server at ${server}: ${err.message}`);
    return json(503, UNAVAILABLE);
  }
  if (res.status === 204) return new Response(null, { status: 204 });
  const answer = await res.json().catch(() => null);
  if (res.status === 404 && !answer?.message) {
    logger.error(`The Node server at ${server} has no website chat: deploy the latest server code, with GROQ_API_KEY and AGENT_TOOL_SECRET set there.`);
    return json(503, UNAVAILABLE);
  }
  if (res.status === 401) {
    logger.error('The Node server refused NODE_API_KEY for the website chat. It must equal INTERNAL_API_KEY on that server.');
    return json(503, UNAVAILABLE);
  }
  return json(res.status, answer || UNAVAILABLE);
}

// A new chat for the mobile number the customer typed.
export async function startChatSession(request, { limiter, ip, ...deps }) {
  const { phone } = await request.json().catch(() => ({}));
  const number = callerPhone(phone);
  if (!number) return json(400, { error: 'phone', message: 'Enter your 10 digit mobile number to start the chat.' });
  const verdict = await limiter.check(ip);
  if (!verdict.allowed) {
    return json(429, { error: 'rate_limited', message: 'Too many chats and calls were started. Please try again later.' }, { 'Retry-After': String(verdict.retryAfterSeconds) });
  }
  const res = await callChat('sessions', { body: { phone: number } }, deps);
  if (res.ok) await limiter.record(ip);
  return res;
}

export async function sendChatMessage(request, id, deps = {}) {
  if (!SESSION_ID.test(String(id))) return json(410, { error: 'ended', message: 'This chat has ended. Please start a new chat.' });
  const { text } = await request.json().catch(() => ({}));
  return callChat(`sessions/${id}/messages`, { body: { text: String(text ?? '').slice(0, 500) } }, deps);
}

export async function endChatSession(id, deps = {}) {
  if (!SESSION_ID.test(String(id))) return new Response(null, { status: 204 });
  return callChat(`sessions/${id}`, { method: 'DELETE' }, deps);
}
