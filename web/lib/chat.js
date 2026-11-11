// The website chat with the assistant (the chat panel on /support). Sarvam has no text chat for the voice agent, so
// the Node server runs the chat (src/chat/chatAgent.js: a text model with the voice agent's tools and rules), reached
// through this site's /api/chat, which keeps the server key here and counts each new chat against the call limits.
// The page offers the chat only when SUPPORT_CHAT is on in the site's server environment.
import { SUPPORT_PHONE } from './contact.js';

// The chat panel opens on this window event (detail: { phone, start }), from the page's buttons and the call widget,
// and closes on the other when no chat is live.
export const CHAT_OPEN_EVENT = 'tiffany:open-chat';
export const CHAT_CLOSE_EVENT = 'tiffany:close-chat';
export const MAX_MESSAGE_LENGTH = 500;

// SUPPORT_CHAT=on (or true, yes, 1) shows the chat.
export function supportChatOn(env) {
  return /^(on|true|yes|1)$/i.test(String(env?.SUPPORT_CHAT ?? '').trim());
}

// The conversation as the panel shows it. status: 'connecting', 'open' or 'ended'; waiting: the customer wrote and the
// assistant has not answered yet.
export function newTranscript() {
  return { status: 'connecting', waiting: false, messages: [], nextId: 1 };
}

export function addCustomerText(state, text) {
  return { ...state, waiting: true, nextId: state.nextId + 1, messages: [...state.messages, { id: state.nextId, from: 'customer', text, done: true }] };
}

export function addAgentText(state, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ...state, waiting: false };
  return { ...state, status: 'open', waiting: false, nextId: state.nextId + 1, messages: [...state.messages, { id: state.nextId, from: 'agent', text: clean, done: true }] };
}

const wait = (secs) => (secs < 3600 ? `${Math.ceil(secs / 60)} min` : `${Math.ceil(secs / 3600)} h`);

// What the customer reads when a chat cannot start or stops; the reason for staff goes to the browser console.
export function chatProblem(status, retryAfterSeconds) {
  if (status === 429) {
    return `Too many chats and calls were started from this network. Please try again in about ${wait(retryAfterSeconds > 0 ? retryAfterSeconds : 60)}.`;
  }
  return `Our chat is not available right now. Please try again in a little while, or call us on ${SUPPORT_PHONE}.`;
}

export const CHAT_OFFLINE = `We could not connect the chat. Check your internet connection and try again, or call us on ${SUPPORT_PHONE}.`;
export const CHAT_ENDED = 'This chat has ended. Start a new chat to carry on.';
const NOT_SENT = 'Your message did not go through. Please send it again.';

// One chat: starts it with the customer's number, sends each message and adds the reply. onChange gets each new
// transcript, onProblem what to tell the customer (with '' once it is resolved).
export function startChat({
  server, phone, onChange, onProblem, fetchImpl = (...args) => fetch(...args), logger = console,
}) {
  let state = newTranscript();
  let sessionId = null;
  let stopped = false;

  const update = (next) => {
    if (stopped && next.status !== 'ended') return;
    state = next;
    onChange(state);
  };
  const finish = (problem) => {
    update({ ...state, status: 'ended', waiting: false });
    stopped = true;
    if (problem) onProblem(problem);
  };
  const post = (path, body) => fetchImpl(`${server}/api/chat${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
  });

  onChange(state);

  const ready = (async () => {
    let res;
    try {
      res = await post('', { phone });
    } catch (err) {
      logger.warn(`[chat] Cannot reach ${server}: ${err.message}`);
      if (!stopped) finish(CHAT_OFFLINE);
      return;
    }
    const answer = await res.json().catch(() => null);
    if (stopped) return;
    if (!res.ok || !answer?.session_id) {
      logger.warn(`[chat] Starting a chat failed (${res.status}): ${answer?.message || 'no answer'}. See the site's server log.`);
      finish(chatProblem(res.status, Number(res.headers.get('Retry-After'))));
      return;
    }
    sessionId = answer.session_id;
    update(addAgentText({ ...state, status: 'open' }, answer.reply));
  })();

  return {
    ready,
    // false when the text is empty, the chat is not open or a reply is still coming; the panel keeps the draft then.
    send(text) {
      const clean = String(text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!clean || stopped || state.status !== 'open' || state.waiting || !sessionId) return false;
      update(addCustomerText(state, clean));
      onProblem('');
      (async () => {
        let res;
        try {
          res = await post(`/${sessionId}`, { text: clean });
        } catch (err) {
          logger.warn(`[chat] Cannot reach ${server}: ${err.message}`);
          if (!stopped) { update({ ...state, waiting: false }); onProblem(CHAT_OFFLINE); }
          return;
        }
        const answer = await res.json().catch(() => null);
        if (stopped) return;
        if (res.ok) {
          update(addAgentText(state, answer?.reply));
          return;
        }
        if (res.status === 410 || res.status === 404) {
          finish(answer?.message || CHAT_ENDED);
          return;
        }
        // The server took the message back (busy model or a hiccup): the customer can send it again.
        update({ ...state, waiting: false });
        onProblem(answer?.message || NOT_SENT);
      })();
      return true;
    },
    end() {
      if (sessionId) fetchImpl(`${server}/api/chat/${sessionId}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
      if (state.status !== 'ended') finish('');
      stopped = true;
    },
  };
}
