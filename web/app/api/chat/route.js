import { supportChatOn } from '@/lib/chat.js';
import { startChatSession } from '@/lib/chatServer.js';
import { createLimiter } from '@/lib/limits.js';
import { visitorIp } from '@/lib/visitor.js';

const limiter = createLimiter();

// Starts a website chat (the chat panel on /support) for the mobile number the customer typed.
export async function POST(request) {
  if (!supportChatOn(process.env)) return Response.json({ error: 'off', message: 'The chat is not available.' }, { status: 404 });
  try {
    return await startChatSession(request, { limiter, ip: visitorIp(request) });
  } catch (err) {
    console.error(`Starting a website chat failed: ${err.message}`);
    return Response.json({ error: 'server_error', message: 'The chat could not be started. Please try again.' }, { status: 500 });
  }
}
