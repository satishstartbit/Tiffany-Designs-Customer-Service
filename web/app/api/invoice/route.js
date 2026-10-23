import { forwardInvoiceUpload } from '@/lib/invoiceUpload.js';
import { visitorIp } from '@/lib/visitor.js';

// Reading an invoice takes the Node server up to about half a minute (longer if it was asleep).
export const maxDuration = 60;

async function forward(request, method) {
  try {
    const result = await forwardInvoiceUpload({
      method,
      contentType: request.headers.get('content-type'),
      contentLength: request.headers.get('content-length'),
      body: () => request.arrayBuffer(),
      ip: visitorIp(request),
    });
    return new Response(result.body, { status: result.status, headers: result.headers });
  } catch (err) {
    console.error(`Invoice upload failed: ${err.message}`);
    return Response.json({ error: 'server_error', message: 'Something went wrong. Please try again in a minute.' }, { status: 500 });
  }
}

// GET says whether uploads work (and wakes the Node server while the customer picks a file); POST sends the file.
export const GET = (request) => forward(request, 'GET');
export const POST = (request) => forward(request, 'POST');
