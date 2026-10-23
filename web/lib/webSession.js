import { AGENT } from './agent.js';
import { callerPhone } from './caller.js';

const INTERACTION_TYPES = ['call', 'chat'];

// A key pasted into a hosting dashboard often keeps its .env quotes or the whole NAME=value line,
// and Sarvam refuses a quoted key as "Invalid API key format".
export function cleanApiKey(value) {
  return String(value || '').trim()
    .replace(/^SARVAM_API_KEY\s*=\s*/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

function reply(status, body, headers = {}) {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  };
}

// The widget asks here for Sarvam's signed call URL, so the Sarvam API key stays on the server.
// The route is public, so it reaches only this project's agent and is rate-limited; only a call link counts.
// With the mobile number the customer typed (`phone`), a call link also names the customer's first name
// (`lookupCaller`), so the page can pass it to the agent; nothing else about the customer is given.
// Keep in step with the Node server's route (src/routes/webCalls.js).
export async function startWebSession(
  { params, searchParams, ip, phone },
  { limiter, env = process.env, fetchImpl = (...args) => fetch(...args), logger = console, lookupCaller = null },
) {
  if (params.orgId !== AGENT.orgId || params.workspaceId !== AGENT.workspaceId || params.appId !== AGENT.appId) {
    return reply(404, { error: 'not_found' });
  }
  const apiKey = cleanApiKey(env.SARVAM_API_KEY);
  if (!apiKey) {
    // The visitor's widget shows this message, so it names no setting; the log says what is missing.
    logger.error('Web calls are off: set SARVAM_API_KEY in this site\'s environment.');
    return reply(503, { error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
  }

  const verdict = await limiter.check(ip);
  if (!verdict.allowed) {
    return reply(429, { error: 'rate_limited', message: 'Too many calls were started. Please try again later.' },
      { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const query = new URLSearchParams({
    interaction_type: INTERACTION_TYPES.includes(searchParams.get('interaction_type')) ? searchParams.get('interaction_type') : 'call',
  });
  // The server's agent version wins over the browser's, so website and phone calls reach the same version.
  if (/^\d+$/.test(env.SARVAM_APP_VERSION || '')) query.set('version', env.SARVAM_APP_VERSION);
  const baseUrl = (env.SARVAM_APPS_BASE_URL || 'https://apps.sarvam.ai').replace(/\/+$/, '');

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/app-runtime/orgs/${AGENT.orgId}/workspaces/${AGENT.workspaceId}/apps/${AGENT.appId}/url?${query}`, {
      headers: { 'X-API-Key': apiKey },
    });
  } catch (err) {
    logger.error(`Web call session failed: ${err.message}`);
    return reply(502, { error: 'upstream_failed', message: 'The call could not be started. Please try again.' });
  }
  const body = await res.text();

  // A refused key is the server's setup, not the visitor's; Sarvam's wording would only confuse the caller.
  if (res.status === 401 || res.status === 403) {
    logger.error(`Sarvam refused SARVAM_API_KEY for a web call (${res.status}): ${body}. `
      + 'It must be a current workspace API key (sk_samvaad_...) from the Sarvam agents dashboard (Settings, API keys).');
    return reply(503, { error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
  }
  if (res.ok) await limiter.record(ip);
  const retryAfter = res.headers.get('retry-after');
  const number = callerPhone(phone);
  if (res.ok && number && lookupCaller) {
    try {
      const firstName = await lookupCaller(number);
      return reply(res.status, { ...JSON.parse(body), caller: { first_name: firstName } });
    } catch (err) {
      logger.error(`Looking up the web caller failed: ${err.message}`);
    }
  }
  return reply(res.status, body, retryAfter ? { 'Retry-After': retryAfter } : {});
}
