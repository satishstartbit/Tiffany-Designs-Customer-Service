const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('../rules');

// The website chat (the chat panel on /support): Sarvam has no text chat for the voice agent, so this server runs the
// conversation with a text model (src/chat/groqChat.js), the instructions in sarvam/chat-prompt.md and the voice
// agent's own tools (src/chat/chatTools.js), which run through this server's /api/agent like a call's. It starts the
// way a website call does: the mobile number the customer typed is the number of the chat (customer_phone), looked up
// by /call-start, and the greeting is the call's opening line.

const PROMPT_FILE = path.join(__dirname, '..', '..', 'sarvam', 'chat-prompt.md');
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_TURNS = 40;
// Model calls per customer message: a lookup or two, then the answer.
const MAX_STEPS = 6;
// What the model sees of the conversation, newest first, so each request stays within Groq's free per-minute tokens.
const HISTORY_CHARS = 4500;
const MAX_MESSAGE_LENGTH = 500;
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;
const GREETING = 'नमस्ते, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?';
const SORRY = 'Sorry, I could not finish that just now. Please send your message again, or call us on +91-98799-99999.';

const todayInIst = (ms) => new Date(ms).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

// Plain text for the chat panel: no markdown the model may still write.
const plain = (text) => String(text || '').replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim();

// The whole conversation when it fits; otherwise the newest messages that do, starting at a customer message, so a
// tool answer never loses the call it answers. The latest customer message and what followed it always go.
function recent(history, maxChars = HISTORY_CHARS) {
  let size = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    size += String(m.content || '').length + JSON.stringify(m.tool_calls || '').length;
    if (size > maxChars && start < history.length) return history.slice(start);
    if (m.role === 'user') start = i;
  }
  return size > maxChars ? history.slice(start) : history.slice();
}

function createChatAgent({ llm, tools, promptFile = PROMPT_FILE, now = () => Date.now(), logger = console }) {
  const template = fs.readFileSync(promptFile, 'utf8');
  const sessions = new Map();

  const instructions = (s) => template
    .replace('{{today}}', todayInIst(now()))
    .replace('{{phone_ending}}', s.vars.customer_phone.slice(-4))
    .replace('{{customer_name}}', s.vars.customer_name || 'not known')
    .replace('{{caller_details}}', s.vars.caller_details || 'not looked up yet; call find_customer when the customer\'s orders or requests are needed.');

  function sweep() {
    for (const [id, s] of sessions) if (now() - s.lastAt > SESSION_IDLE_MS) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  // A new chat for the number the customer typed: { id, reply, firstName } or { error, message }.
  async function start({ phone, callTool }) {
    const number = normalizePhone(phone);
    if (!number || !INDIAN_MOBILE.test(number)) return { error: 'phone', message: 'A valid 10 digit mobile number is needed to start the chat.' };
    sweep();
    let caller = {};
    try {
      caller = await callTool('/api/agent/call-start', { customer_phone: number, call_reason: 'inbound', caller_type: 'phone_number' }) || {};
    } catch (err) {
      logger.warn(`[chat] The caller lookup failed: ${err.message}`);
    }
    const vars = {
      customer_phone: INDIAN_MOBILE.test(caller.customer_phone || '') ? caller.customer_phone : number,
      customer_name: caller.customer_name || '',
      caller_details: caller.caller_details || '',
      order_phone: '',
    };
    const reply = caller.opening_line || GREETING;
    const id = crypto.randomUUID();
    sessions.set(id, { id, vars, history: [{ role: 'assistant', content: reply }], turns: 0, busy: false, lastAt: now() });
    return { id, reply, firstName: vars.customer_name || null };
  }

  // The answer to one customer message: { reply } or { error, message }.
  async function send({ id, text, callTool }) {
    const s = sessions.get(id);
    if (!s || now() - s.lastAt > SESSION_IDLE_MS) {
      sessions.delete(id);
      return { error: 'ended', message: 'This chat has ended. Please start a new chat.' };
    }
    const clean = String(text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!clean) return { error: 'empty', message: 'Type a message first.' };
    if (s.busy) return { error: 'busy', message: 'Please wait for the answer to your last message.' };
    if (s.turns >= MAX_TURNS) {
      sessions.delete(id);
      return { error: 'ended', message: 'This chat is long enough now. Please start a new chat to carry on.' };
    }
    s.busy = true;
    s.turns += 1;
    s.history.push({ role: 'user', content: clean });
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const { message } = await llm.complete({ messages: [{ role: 'system', content: instructions(s) }, ...recent(s.history)], tools: tools.definitions });
        const calls = (message.tool_calls || []).filter((c) => c?.function?.name);
        if (!calls.length) {
          const reply = plain(message.content) || SORRY;
          s.history.push({ role: 'assistant', content: reply });
          return { reply };
        }
        s.history.push({
          role: 'assistant',
          content: message.content || '',
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } })),
        });
        for (const call of calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* the tool answers what is missing */ }
          const { text: answer, saved } = await tools.run(call.function.name, args, s.vars, callTool);
          Object.assign(s.vars, saved);
          s.history.push({ role: 'tool', tool_call_id: call.id, content: answer });
        }
      }
      s.history.push({ role: 'assistant', content: SORRY });
      return { reply: SORRY };
    } catch (err) {
      logger.error(`[chat] ${err.message}`);
      // The message is taken back, so the customer can send it again.
      while (s.history.length && s.history.at(-1).role !== 'user') s.history.pop();
      s.history.pop();
      s.turns -= 1;
      return { error: err.status === 503 ? 'not_configured' : 'busy_model', message: SORRY };
    } finally {
      s.busy = false;
      s.lastAt = now();
    }
  }

  function end(id) {
    return sessions.delete(id);
  }

  return { start, send, end, sessions };
}

module.exports = { createChatAgent, recent, MAX_MESSAGE_LENGTH };
