// The invoice upload page (/invoice) sends the customer's file through its own route (app/api/invoice), which
// forwards it here to the Node server's public /api/invoice-uploads. The server finds the customer and the order from
// the invoice itself, so nothing else is sent and no server key is involved. Keep the file rules in step with
// src/routes/invoiceUploads.js.

const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
// Vercel functions take request bodies up to 4.5 MB; the page scales photos down well below this.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
// Only these fields of the Node server's answer reach the browser, never an error's technical detail.
const PASSED_ON = ['available', 'status', 'invoice_number', 'order_id', 'error', 'message'];

const UNAVAILABLE = { error: 'unavailable', message: 'Invoice upload is not available right now. Please try again in a few minutes.' };

function reply(status, body) {
  return { status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } };
}

// `body` is a function that reads the request body, so a refused upload is never read.
export async function forwardInvoiceUpload(
  { method, contentType, contentLength, body, ip },
  { env = process.env, fetchImpl = (...args) => fetch(...args), logger = console, timeoutMs = 55_000 } = {},
) {
  const server = String(env.NODE_API_URL || '').replace(/\/+$/, '');
  if (!server) {
    logger.error('Invoice uploads are off: set NODE_API_URL in this site\'s environment.');
    return reply(503, UNAVAILABLE);
  }

  const headers = ip ? { 'X-Forwarded-For': ip } : {};
  let payload;
  if (method === 'POST') {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!FILE_TYPES.includes(type)) {
      return reply(415, { error: 'unsupported_file', message: 'Please upload a photo or screenshot (JPG, PNG or WebP) or a PDF of the invoice.' });
    }
    const tooLarge = reply(413, { error: 'too_large', message: 'The file is larger than 4 MB. Please upload a smaller photo or a screenshot.' });
    if (Number(contentLength) > MAX_UPLOAD_BYTES) return tooLarge;
    payload = Buffer.from(await body());
    if (!payload.length) return reply(415, { error: 'unsupported_file', message: 'The file is empty. Please choose the invoice again.' });
    if (payload.length > MAX_UPLOAD_BYTES) return tooLarge;
    headers['Content-Type'] = type;
  }

  let res;
  try {
    res = await fetchImpl(`${server}/api/invoice-uploads`, {
      method,
      headers,
      body: payload,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    logger.error(`Invoice upload: cannot reach the Node server at ${server}: ${err.message}`);
    return reply(502, { error: 'unreachable', message: 'Our server is starting up. Please try again in a minute.' });
  }

  const answer = await res.json().catch(() => null);
  if (res.status === 404) {
    logger.error(`The Node server at ${server} has no invoice upload route: deploy the latest server code.`);
    return reply(503, UNAVAILABLE);
  }
  if (!answer || typeof answer !== 'object' || (!res.ok && typeof answer.message !== 'string')) {
    logger.error(`Invoice upload: the Node server answered ${res.status}.`);
    return reply(502, { error: 'upstream_failed', message: 'Something went wrong. Please try again in a minute.' });
  }
  return reply(res.status, Object.fromEntries(PASSED_ON.filter((key) => key in answer).map((key) => [key, answer[key]])));
}
