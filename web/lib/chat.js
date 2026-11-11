// The website chat with the agent (the chat panel on /support). It speaks Sarvam's text chat protocol, as Sarvam's own
// SDK does, to the same agent and version as the website call: the signed chat URL comes from the call session route
// (this site's /api/sarvam/, or the server ?server= names), so the Sarvam key stays on the server and the call limits
// count chats too. The page offers the chat only when SUPPORT_CHAT is on in the site's server environment.
import { AGENT } from './agent.js';
import { CALL_START, callerVariables } from './caller.js';
import { SUPPORT_PHONE } from './contact.js';

// The chat panel opens on this window event (detail: { phone, start }), from the page's buttons and the call widget,
// and closes on the other when no chat is live.
export const CHAT_OPEN_EVENT = 'tiffany:open-chat';
export const CHAT_CLOSE_EVENT = 'tiffany:close-chat';
export const MAX_MESSAGE_LENGTH = 500;
const CONNECT_TIMEOUT_MS = 20000;
const OPEN = 1;

// SUPPORT_CHAT=on (or true, yes, 1) shows the chat. Leave it off until Sarvam enables text chat for the agent: until
// then Sarvam refuses chat sessions with "App not found for the interaction type".
export function supportChatOn(env) {
  return /^(on|true|yes|1)$/i.test(String(env?.SUPPORT_CHAT ?? '').trim());
}

// The session route's address for a chat link: the call link's, with interaction_type=chat.
export function chatLinkUrl(server) {
  return `${server}/api/sarvam/orgs/${AGENT.orgId}/workspaces/${AGENT.workspaceId}/apps/${AGENT.appId}/url?interaction_type=chat`;
}

const withParam = (url, key, value) => `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

// The signed URL with what Sarvam's SDK adds before it connects a chat. Sarvam's logs search by the user id.
export function chatSocketUrl(signedUrl, userId) {
  const url = withParam(withParam(signedUrl, 'user_identifier', userId), 'user_identifier_type', 'custom');
  return withParam(url, 'interaction_type', 'chat');
}

const seconds = (now) => now() / 1000;

// The first message carries the caller variables, as on a website call, so the agent knows the number (and the first
// name of a known customer) and opens with the same welcome.
export function chatStartMessage({ phone, name = null, now = Date.now }) {
  return { type: CALL_START, origin: 'client', timestamp: seconds(now), agent_variables: callerVariables(phone, name) };
}

export function chatTextMessage(text, now = Date.now) {
  return { type: 'client.media.text', origin: 'client', timestamp: seconds(now), text };
}

export function chatPong(eventId, now = Date.now) {
  return { type: 'client.system.pong', origin: 'client', timestamp: seconds(now), event_id: eventId };
}

// The conversation as the panel shows it. status: 'connecting', 'open' or 'ended'; waiting: the customer wrote and the
// agent has not answered yet. An agent message stays open (done: false) while its words are still streaming in.
export function newTranscript() {
  return { status: 'connecting', waiting: false, messages: [], nextId: 1 };
}

const finishOpen = (messages) => messages.map((m) => (m.done ? m : { ...m, done: true }));
const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
const openAgentMessage = (messages) => {
  const last = messages.at(-1);
  return last && last.from === 'agent' && !last.done ? last : null;
};

// A streamed piece is either the reply so far or only its new words.
function joinPiece(sofar, piece) {
  if (!sofar) return piece;
  return piece.startsWith(sofar) ? piece : sofar + piece;
}

export function addCustomerText(state, text) {
  return {
    ...state,
    waiting: true,
    nextId: state.nextId + 1,
    messages: [...finishOpen(state.messages), { id: state.nextId, from: 'customer', text, done: true }],
  };
}

// One message from Sarvam: the new transcript, and the answer to send back (to a ping), if any. Agent words come as
// whole messages (server.media.text) or streamed pieces (server.media.text_chunk, completed at the end); a whole
// message that repeats the reply just streamed is not shown twice.
export function applyServerMessage(state, message) {
  switch (message?.type) {
    case 'server.action.interaction_connected':
      return { state: { ...state, status: 'open' } };
    case 'server.system.ping':
      return { state, reply: chatPong(message.event_id) };
    case 'server.media.text_chunk': {
      const piece = String(message.text ?? '');
      const open = openAgentMessage(state.messages);
      if (!open && !piece) return { state };
      const done = message.status === 'completed' || message.status === 'failed';
      if (open) {
        const messages = [...state.messages.slice(0, -1), { ...open, text: joinPiece(open.text, piece), done }];
        return { state: { ...state, status: 'open', waiting: false, messages } };
      }
      const messages = [...state.messages, { id: state.nextId, from: 'agent', text: piece, done }];
      return { state: { ...state, status: 'open', waiting: false, nextId: state.nextId + 1, messages } };
    }
    case 'server.media.text': {
      const text = String(message.text ?? '');
      if (!text.trim()) return { state };
      const open = openAgentMessage(state.messages);
      if (open) {
        return { state: { ...state, status: 'open', waiting: false, messages: [...state.messages.slice(0, -1), { ...open, text, done: true }] } };
      }
      const last = state.messages.at(-1);
      if (last && last.from === 'agent' && sameText(last.text, text)) return { state: { ...state, waiting: false } };
      const messages = [...state.messages, { id: state.nextId, from: 'agent', text, done: true }];
      return { state: { ...state, status: 'open', waiting: false, nextId: state.nextId + 1, messages } };
    }
    case 'server.action.interaction_end':
      return { state: { ...state, status: 'ended', waiting: false, messages: finishOpen(state.messages) } };
    default:
      return { state };
  }
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
export const CHAT_DROPPED = 'The chat was disconnected. Start a new chat to carry on.';

// The technical reason, for staff: it goes to the browser console, never on the customer's screen.
export function chatProblemForStaff(status, body, server) {
  if (status === 404 && /interaction type/i.test(body)) {
    return `Sarvam has no text chat for agent ${AGENT.appId} ("App not found for the interaction type"). `
      + 'Ask Sarvam to enable chat for it, or turn SUPPORT_CHAT off.';
  }
  switch (status) {
    case 403:
      return `${server} does not accept chats from this site: add it to WEB_CALL_ALLOWED_ORIGINS on the server.`;
    case 404:
      return `${server} does not know this agent. Check the agent ids in lib/agent.js.`;
    case 429:
      return `${server} refused the chat: the call limits for this network are used up.`;
    case 503:
      return `${server} cannot start chats: its Sarvam key is missing or was refused. Check the server log.`;
    default:
      return `${server} answered ${status}.`;
  }
}

// One chat. Asks the session route for a signed chat URL with the customer's number (X-Caller-Phone, so the route can
// name a known customer), connects, starts the interaction with the caller variables, answers Sarvam's pings and keeps
// the transcript: onChange gets each new one, onProblem what to tell the customer when the chat cannot start or drops.
export function startChat({
  server, phone, userId, onChange, onProblem,
  fetchImpl = (...args) => fetch(...args), WebSocketImpl = globalThis.WebSocket, now = Date.now, logger = console,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  let state = newTranscript();
  let socket = null;
  let timer = null;
  let stopped = false;

  const update = (next) => {
    if (next === state) return;
    state = next;
    onChange(state);
  };
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const close = () => {
    stopped = true;
    stopTimer();
    if (socket && socket.readyState <= OPEN) socket.close(1000);
  };
  const fail = (message) => {
    close();
    update({ ...state, status: 'ended', waiting: false, messages: finishOpen(state.messages) });
    onProblem(message);
  };

  onChange(state);

  const ready = (async () => {
    let res;
    try {
      res = await fetchImpl(chatLinkUrl(server), { headers: { 'X-Caller-Phone': phone }, cache: 'no-store' });
    } catch (err) {
      if (stopped) return;
      logger.warn(`[chat] Cannot reach ${server}: ${err.message}`);
      fail(CHAT_OFFLINE);
      return;
    }
    if (stopped) return;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`[chat] ${chatProblemForStaff(res.status, body, server)}`);
      fail(chatProblem(res.status, Number(res.headers.get('Retry-After'))));
      return;
    }
    const link = await res.json().catch(() => null);
    if (stopped) return;
    if (!link?.url) {
      logger.warn(`[chat] ${server} answered without a chat link.`);
      fail(chatProblem(res.status));
      return;
    }

    const caller = link.caller || {};
    socket = new WebSocketImpl(chatSocketUrl(link.url, userId));
    timer = setTimeout(() => {
      logger.warn('[chat] Sarvam did not start the chat in time.');
      fail(chatProblem(0));
    }, connectTimeoutMs);
    timer?.unref?.();
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(chatStartMessage({ phone: caller.phone || phone, name: caller.first_name || null, now })));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      const { state: next, reply } = applyServerMessage(state, message);
      if (reply && socket.readyState === OPEN) socket.send(JSON.stringify(reply));
      if (next.status !== 'connecting') stopTimer();
      update(next);
      if (next.status === 'ended') close();
    });
    socket.addEventListener('close', () => {
      stopTimer();
      if (stopped || state.status === 'ended') return;
      logger.warn('[chat] The chat connection closed.');
      fail(state.messages.length ? CHAT_DROPPED : chatProblem(0));
    });
    socket.addEventListener('error', () => logger.warn('[chat] The chat connection failed.'));
  })();

  return {
    ready,
    // false when the text is empty or the chat is not open; the panel keeps the draft then.
    send(text) {
      const clean = String(text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!clean || state.status !== 'open' || !socket || socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(chatTextMessage(clean, now)));
      update(addCustomerText(state, clean));
      return true;
    },
    end() {
      close();
      if (state.status !== 'ended') update({ ...state, status: 'ended', waiting: false, messages: finishOpen(state.messages) });
    },
  };
}
