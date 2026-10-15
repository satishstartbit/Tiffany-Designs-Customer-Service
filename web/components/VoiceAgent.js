'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { AGENT, AGENT_NAME } from '@/lib/agent.js';
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

// The voice call widget (bottom right) for customers. A short note above it says what is happening while a call
// starts, and what to do when it cannot.
export default function VoiceAgent() {
  const [server, setServer] = useState('');
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState({ text: '', problem: false });

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
      show('Connecting you to our assistant…');
      try {
        const res = await nativeFetch.call(window, input, init);
        if (res.ok) {
          show('Connected. Allow the microphone if your browser asks, then start speaking.');
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
  // watched and renamed each time.
  useEffect(() => {
    if (!userId) return undefined;
    let observer = null;
    const attach = () => {
      const root = document.querySelector('sarvam-widget')?.shadowRoot;
      if (!root) return false;
      renameWidget(root);
      observer = new MutationObserver(() => renameWidget(root));
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['alt'] });
      return true;
    };
    const timer = attach() ? null : setInterval(() => attach() && clearInterval(timer), 200);
    return () => {
      if (timer) clearInterval(timer);
      observer?.disconnect();
    };
  }, [userId]);

  return (
    <>
      {note.text && (
        <div className={note.problem ? 'voice-note problem-note' : 'voice-note'} role="status">
          {note.text}
          <button type="button" aria-label="Dismiss" onClick={() => setNote({ text: '', problem: false })}>
            <X aria-hidden="true" />
          </button>
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
