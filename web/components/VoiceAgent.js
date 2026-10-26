'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AGENT, AGENT_NAME } from '@/lib/agent.js';
import { callerPhone, withCallerPhone } from '@/lib/caller.js';
import { SUPPORT_PHONE } from '@/lib/contact.js';

// The widget titles its panel with its maker's name and has no setting for it, so the title is replaced with the
// agent's own name, and any other mention of the maker with the brand.
const PANEL_TITLE = AGENT_NAME;

// Only visible text: the widget's style sheet uses its maker's name in animation names, which must stay.
const visibleText = {
  acceptNode: (node) => (['STYLE', 'SCRIPT'].includes(node.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
};

function renameWidget(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, visibleText);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/sarvam/i.test(node.nodeValue)) {
      node.nodeValue = node.nodeValue.replace(/sarvam voice assistant/gi, PANEL_TITLE).replace(/sarvam/gi, 'Tiffany Designs');
    }
  }
  for (const img of root.querySelectorAll('img[alt]')) {
    if (/sarvam/i.test(img.alt)) img.alt = PANEL_TITLE;
  }
}

// By default this site's own /api/sarvam/ (app/api/sarvam/...) gives each signed call URL, with the Sarvam key kept
// in the server environment. NEXT_PUBLIC_VOICE_SERVER_URL, or ?server= in the address, uses another server's
// /api/sarvam/ instead, such as the Node server (http://localhost:8081 or Render).
const CONFIGURED_SERVER = process.env.NEXT_PUBLIC_VOICE_SERVER_URL || '';

const withoutTrailingSlash = (url) => url.replace(/\/+$/, '');

function waitFor(res) {
  const seconds = Number(res.headers.get('Retry-After')) || 60;
  return seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds / 3600)} h`;
}

// The technical reason, for staff: it goes to the browser console, never on the customer's screen.
function explain(res, server) {
  switch (res.status) {
    case 403:
      return `${server} does not accept calls from ${location.origin}: add it to WEB_CALL_ALLOWED_ORIGINS on the server.`;
    case 404:
      return `${server} does not know this agent. Check the agent ids in lib/agent.js.`;
    case 503:
      return `${server} cannot start calls: its voice service key is missing or was refused. `
        + 'Check the server log, set the current workspace key in that server\'s environment and redeploy.';
    default:
      return `${server} answered ${res.status}.`;
  }
}

function customerMessage(res) {
  if (res.status === 429) return `Too many calls were started from this network. Please try again in about ${waitFor(res)}.`;
  return `Our voice assistant is not available right now. Please try again in a little while, or call us on ${SUPPORT_PHONE}.`;
}

const SAVED_PHONE = 'tiffany-caller-phone';
const remembered = () => {
  try { return sessionStorage.getItem(SAVED_PHONE) || ''; } catch { return ''; }
};
const remember = (value) => {
  try { sessionStorage.setItem(SAVED_PHONE, value); } catch { /* private window */ }
};

const PHONE_HINT = 'We use it to find your orders.';
const PHONE_NEEDED = 'Enter your 10 digit mobile number to start the call.';

// The page's style sheet does not reach into the widget, so the mobile number field brings its own, in the panel's
// look (rounded like its call button, the brand maroon). The call button is dimmed until the number is valid.
const CALLER_STYLE = `
.tdc-caller { display: grid; gap: 6px; margin: 0 0 12px; }
.tdc-caller[hidden] { display: none; }
.tdc-caller label { color: #6b7280; font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; }
.tdc-caller input { box-sizing: border-box; width: 100%; height: 40px; padding: 0 16px; border: 1px solid #d9cfc4; border-radius: 9999px;
  background: #ffffff; color: #111827; font: inherit; font-size: 14px; outline: none; }
.tdc-caller input:focus { border-color: #6e2a24; box-shadow: 0 0 0 3px rgba(110, 42, 36, 0.14); }
.tdc-caller input[aria-invalid="true"] { border-color: #b3261e; background: #fbe9e7; }
.tdc-caller p { margin: 0; color: #6b7280; font-size: 12px; line-height: 1.4; }
.tdc-caller p.tdc-error { color: #b3261e; font-weight: 500; }
button[data-needs-phone] { opacity: 0.5 !important; cursor: not-allowed !important; }
`;

// The mobile number field inside the widget's panel, above its call button. Made once and moved back in whenever the
// panel is opened again, so what the customer typed stays.
function createCallerField({ initial, onInput, onEnter }) {
  const block = document.createElement('div');
  block.className = 'tdc-caller';
  block.dataset.caller = '';
  const label = document.createElement('label');
  label.htmlFor = 'caller-mobile';
  label.textContent = 'Your mobile number';
  const input = document.createElement('input');
  Object.assign(input, { id: 'caller-mobile', type: 'tel', inputMode: 'numeric', autocomplete: 'tel-national', placeholder: '10 digit mobile number', maxLength: 16, value: initial });
  input.setAttribute('aria-describedby', 'caller-mobile-hint');
  const hint = document.createElement('p');
  hint.id = 'caller-mobile-hint';
  hint.textContent = PHONE_HINT;
  block.append(label, input, hint);

  const showProblem = (problem) => {
    input.setAttribute('aria-invalid', problem ? 'true' : 'false');
    hint.className = problem ? 'tdc-error' : '';
    hint.textContent = problem || PHONE_HINT;
  };
  input.addEventListener('input', () => {
    onInput(input.value);
    if (callerPhone(input.value)) showProblem(null);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onEnter();
  });
  return { block, input, showProblem };
}

// The voice call widget (bottom right) for customers. Its panel asks for the customer's mobile number above the call
// button, and a call starts only with a valid one: the number goes into the call so the agent can find their orders.
// A short note says what is happening while a call starts, and what to do when it cannot.
export default function VoiceAgent() {
  const [server, setServer] = useState('');
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState({ text: '', problem: false });
  // 'closed', 'open' (asking for the number) or 'calling': the notes sit just above the panel.
  const [panel, setPanel] = useState('closed');
  const callerRef = useRef(null);
  // The customer's first name, when the call link came back with it (the number belongs to a customer).
  const callerNameRef = useRef(null);

  // The widget opens its own WebSocket, so the number and the name are added to its call-start message on the way out.
  useEffect(() => {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      const sent = withCallerPhone(data, callerRef.current, callerNameRef.current);
      return nativeSend.call(this, sent);
    };
    return () => {
      WebSocket.prototype.send = nativeSend;
    };
  }, []);

  useEffect(() => {
    const show = (text, problem = false) => setNote({ text, problem });
    const active = withoutTrailingSlash(new URLSearchParams(location.search).get('server') || CONFIGURED_SERVER || location.origin);
    setServer(active);
    // The user id is what the voice platform's Log Analyser searches by; one per visit, findable by its prefix.
    setUserId(`tiffany-web-${Date.now()}`);
    if (!window.isSecureContext) {
      show('Your browser blocks the microphone on this address. Please open the secure (https) version of this page.', true);
    }

    // A sleeping Render server takes up to a minute to start, so wake another server before the first click.
    if (active !== location.origin) fetch(`${active}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});

    const nativeFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${active}/api/sarvam/`)) return nativeFetch.call(window, input, init);
      // The call button refuses without a number; this stops any other way of starting one.
      if (!callerRef.current) {
        show(PHONE_NEEDED, true);
        return new Response(JSON.stringify({ error: 'phone_required', message: PHONE_NEEDED }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      show('Connecting you to our assistant…');
      // The server looks the number up when it hands out the call link, and answers with the customer's first name.
      const headers = new Headers(init?.headers);
      headers.set('X-Caller-Phone', callerRef.current);
      callerNameRef.current = null;
      try {
        const res = await nativeFetch.call(window, input, { ...init, headers });
        if (res.ok) {
          const caller = await res.clone().json().then((answer) => answer?.caller || null).catch(() => null);
          if (caller?.phone) callerRef.current = caller.phone;
          callerNameRef.current = caller?.first_name || null;
          show(callerNameRef.current
            ? `Hello ${callerNameRef.current}, you are connected. Allow the microphone if your browser asks, then start speaking.`
            : 'Connected. Allow the microphone if your browser asks, then start speaking.');
        } else {
          console.warn(`[voice] ${explain(res, active)}`);
          show(customerMessage(res), true);
        }
        return res;
      } catch (err) {
        console.warn(`[voice] Cannot reach ${active}: ${err.message}`);
        show(`We could not connect the call. Check your internet connection and try again, or call us on ${SUPPORT_PHONE}.`, true);
        throw err;
      }
    };
    return () => {
      window.fetch = nativeFetch;
    };
  }, []);

  // The widget renders inside its own shadow root, and again whenever it opens or a call starts, so its text is
  // renamed, and the mobile number field is put back above its call button, each time.
  useEffect(() => {
    if (!userId) return undefined;
    let observer = null;
    let root = null;
    const callButton = () => [...root.querySelectorAll('button')].find((b) => /start call|end call|connecting/i.test(b.textContent || ''));
    const initial = remembered();
    callerRef.current = callerPhone(initial);
    const field = createCallerField({
      initial,
      onInput: (value) => {
        callerRef.current = callerPhone(value);
        remember(value);
        const button = callButton();
        if (button) button.toggleAttribute('data-needs-phone', !callerRef.current && /start call/i.test(button.textContent || ''));
      },
      onEnter: () => callButton()?.click(),
    });

    // Runs before the widget's own click handler (which listens further in): no valid number, no call.
    const guard = (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || !/start call/i.test(button.textContent || '') || callerRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      field.showProblem(PHONE_NEEDED);
      field.input.focus();
    };

    const update = () => {
      renameWidget(root);
      const button = callButton();
      const calling = Boolean(button) && !/start call/i.test(button.textContent || '');
      setPanel(!button ? 'closed' : calling ? 'calling' : 'open');
      if (!button) return;
      field.block.hidden = calling;
      button.toggleAttribute('data-needs-phone', !calling && !callerRef.current);
      if (field.block.nextElementSibling !== button) button.before(field.block);
    };

    const attach = () => {
      root = document.querySelector('sarvam-widget')?.shadowRoot;
      if (!root) return false;
      const style = document.createElement('style');
      style.textContent = CALLER_STYLE;
      root.append(style);
      root.addEventListener('click', guard, true);
      update();
      observer = new MutationObserver(update);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['alt'] });
      return true;
    };
    const timer = attach() ? null : setInterval(() => attach() && clearInterval(timer), 200);
    return () => {
      if (timer) clearInterval(timer);
      observer?.disconnect();
      root?.removeEventListener('click', guard, true);
    };
  }, [userId]);

  return (
    <>
      {note.text && (
        <div className={`voice-dock${{ open: ' above-panel', calling: ' above-call' }[panel] || ''}`}>
          <div className={note.problem ? 'voice-note problem-note' : 'voice-note'} role="status">
            {note.text}
            <button type="button" aria-label="Dismiss" onClick={() => setNote({ text: '', problem: false })}>
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      {/* Rendered in the browser only, so the server address and per-visit user id are set before the widget starts. */}
      {userId && (
        <sarvam-widget
          session-endpoint={`${server}/api/sarvam/`}
          user-id={userId}
          app-id={AGENT.appId}
          org-id={AGENT.orgId}
          workspace-id={AGENT.workspaceId}
          button-text="Start call"
          interaction-type="call"
          button-color="#6e2a24"
          position="bottom-right"
        />
      )}
      <Script src="https://unpkg.com/sarvam-convai-embed@1.0.20/index.js" strategy="afterInteractive" />
    </>
  );
}
