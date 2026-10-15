import 'server-only';
import { requireSession } from './session.js';

const DEFAULT_SERVER = 'https://tiffany-designs-customer-service.onrender.com';

export const nodeServer = () => (process.env.NODE_API_URL || DEFAULT_SERVER).replace(/\/+$/, '');

// Reads console data from the Node server's /api/admin with its internal key, which stays on this server.
// Every read checks the staff session first. Returns { data } (null for an unknown record) or { error } to show.
export async function loadAdmin(path, params = {}) {
  await requireSession();
  const server = nodeServer();
  const key = process.env.NODE_API_KEY;
  if (!key) {
    return { error: 'NODE_API_KEY is not set. Add the Node server\'s INTERNAL_API_KEY as NODE_API_KEY in this site\'s environment.' };
  }

  const url = new URL(`${server}/api/admin/${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }

  let res;
  try {
    res = await fetch(url, { headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(70_000) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'no answer within 70 seconds' : err.message;
    return { error: `Cannot reach the Node server at ${server} (${reason}). A sleeping Render server takes up to a minute to start: reload the page.` };
  }

  const body = await res.json().catch(() => null);
  if (res.ok) return { data: body };
  if (res.status === 404 && body?.error === 'not_found') return { data: null };
  if (res.status === 404) return { error: `The Node server at ${server} has no console API yet. Deploy the latest server code, which adds /api/admin.` };
  if (res.status === 401) return { error: `The Node server at ${server} refused NODE_API_KEY. It must equal INTERNAL_API_KEY on that server.` };
  const detail = body?.detail || body?.message || body?.error;
  return { error: `The Node server at ${server} answered ${res.status}${detail ? `: ${detail}` : ''}.` };
}
