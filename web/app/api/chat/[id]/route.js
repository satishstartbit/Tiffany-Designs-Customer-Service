import { supportChatOn } from '@/lib/chat.js';
import { endChatSession, sendChatMessage } from '@/lib/chatServer.js';

const off = () => Response.json({ error: 'off', message: 'The chat is not available.' }, { status: 404 });

// One customer message in a website chat, answered with the assistant's reply.
export async function POST(request, { params }) {
  if (!supportChatOn(process.env)) return off();
  try {
    return await sendChatMessage(request, (await params).id);
  } catch (err) {
    console.error(`A website chat message failed: ${err.message}`);
    return Response.json({ error: 'server_error', message: 'Sorry, something went wrong. Please send your message again.' }, { status: 500 });
  }
}

// The customer ended the chat.
export async function DELETE(request, { params }) {
  if (!supportChatOn(process.env)) return off();
  try {
    return await endChatSession((await params).id);
  } catch {
    return new Response(null, { status: 204 });
  }
}
