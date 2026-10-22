import 'server-only';
import { requireSession } from './session.js';

export const nodeServer = () => (process.env.NODE_API_URL ).replace(/\/+$/, '');

// Calls the Node server's /api/admin with its internal key, which stays on this server, after checking the staff
// session. The signed-in person is named in X-Console-User, so order edits are noted under their name.
// Only loadSupportHours (below) reads without a session.
async function callAdmin(path, { method = 'GET', params = {}, body, signedIn = true } = {}) {
  const session = signedIn ? await requireSession() : null;
  const server = nodeServer();
  const key = process.env.NODE_API_KEY;
  if (!key) {
    return { problem: 'NODE_API_KEY is not set. Add the Node server\'s INTERNAL_API_KEY as NODE_API_KEY in this site\'s environment.' };
  }

  const url = new URL(`${server}/api/admin/${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-api-key': key,
        ...(session ? { 'x-console-user': session.email } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(70_000),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'no answer within 70 seconds' : err.message;
    return { problem: `Cannot reach the Node server at ${server} (${reason}). A sleeping Render server takes up to a minute to start: try again.` };
  }

  const answer = await res.json().catch(() => null);
  if (res.ok) return { answer };
  if (res.status === 404 && answer?.error === 'not_found') return { answer: null, notFound: true };
  if ((res.status === 400 || res.status === 422) && answer?.message) return { refused: answer };
  if (res.status === 404) return { problem: `The Node server at ${server} does not have this console feature yet. Deploy the latest server code.` };
  if (res.status === 401) return { problem: `The Node server at ${server} refused NODE_API_KEY. It must equal INTERNAL_API_KEY on that server.` };
  const detail = answer?.detail || answer?.message || answer?.error;
  return { problem: `The Node server at ${server} answered ${res.status}${detail ? `: ${detail}` : ''}.` };
}

// Reads console data. Returns { data } (null for an unknown record) or { error } to show.
export async function loadAdmin(path, params = {}) {
  const { answer, problem } = await callAdmin(path, { params });
  return problem ? { error: problem } : { data: answer };
}

const HOURS_TTL_MS = 5 * 60 * 1000;
let hoursCache = null;

// The service team's hours for the public customer page: no sign-in, only the hours are passed on, and the answer
// is kept for 5 minutes so visitors do not add Salesforce calls. Null when unavailable; the page then leaves them out.
export async function loadSupportHours() {
  if (hoursCache && Date.now() - hoursCache.at < HOURS_TTL_MS) return hoursCache.hours;
  const { answer, problem } = await callAdmin('service', { signedIn: false });
  const hours = problem || !answer?.hours?.configured ? null : answer.hours;
  hoursCache = { at: Date.now(), hours };
  return hours;
}

// Saves a change. Returns { data } or { error, field } (field: the form field the error is about, if any).
export async function sendAdmin(path, { method = 'PATCH', body }) {
  const { answer, problem, refused, notFound } = await callAdmin(path, { method, body });
  if (problem) return { error: problem };
  if (notFound) return { error: 'This record no longer exists in Salesforce.' };
  if (refused) return { error: refused.message, field: refused.field || null };
  return { data: answer };
}
