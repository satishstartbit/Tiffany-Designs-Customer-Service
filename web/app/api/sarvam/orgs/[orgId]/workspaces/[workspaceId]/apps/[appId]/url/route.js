import { createLimiter } from '@/lib/limits.js';
import { startWebSession } from '@/lib/webSession.js';

const limiter = createLimiter();

// Vercel sets these from the connection, so a visitor cannot pick another address to dodge the limits.
function visitorIp(request) {
  return request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

export async function GET(request, { params }) {
  try {
    const result = await startWebSession(
      { params: await params, searchParams: new URL(request.url).searchParams, ip: visitorIp(request) },
      { limiter },
    );
    return new Response(result.body, { status: result.status, headers: result.headers });
  } catch (err) {
    console.error(`Web call session failed: ${err.message}`);
    return Response.json({ error: 'server_error', message: 'The call could not be started. Please try again.' }, { status: 500 });
  }
}
