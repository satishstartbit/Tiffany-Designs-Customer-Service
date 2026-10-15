'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { AGENT } from '@/lib/agent.js';

// By default this site's own /api/sarvam/ (app/api/sarvam/...) gives each signed call URL, with the Sarvam key kept
// in the server environment. NEXT_PUBLIC_VOICE_SERVER_URL, or ?server= in the address, uses another server's
// /api/sarvam/ instead, such as the Node server (http://localhost:8081 or Render).
const CONFIGURED_SERVER = process.env.NEXT_PUBLIC_VOICE_SERVER_URL || '';

const withoutTrailingSlash = (url) => url.replace(/\/+$/, '');

function waitFor(res) {
  const seconds = Number(res.headers.get('Retry-After')) || 60;
  return seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds / 3600)} h`;
}

// The widget shows only raw errors ("Failed to fetch", "Server error: ..."), so the page names the cause.
function explain(res, server) {
  switch (res.status) {
    case 403:
      return `${server} does not accept calls from ${location.origin}: add it to WEB_CALL_ALLOWED_ORIGINS on the server.`;
    case 404:
      return `${server} does not know this agent. Check the agent ids in lib/agent.js.`;
    case 429:
      return `Too many calls were started from this network. Try again in about ${waitFor(res)}.`;
    case 503:
      return `${server} cannot start calls: its SARVAM_API_KEY is missing or Sarvam refused it. `
        + 'Set the current Sarvam workspace key in that server\'s environment (Vercel: Settings, Environment Variables; '
        + 'Render: Environment), redeploy, then try again.';
    default:
      return `${server} answered ${res.status}. Try again in a minute.`;
  }
}

// "inline" shows the status line in the page (the public call page); "floating" (the console) shows a note above
// the call button only while a call starts or when something is wrong.
export default function VoiceAgent({ variant = 'inline' }) {
  const [server, setServer] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState({ text: '', problem: false, ready: true });

  useEffect(() => {
    const show = (text, problem = false, ready = false) => setStatus({ text, problem, ready });
    const active = withoutTrailingSlash(new URLSearchParams(location.search).get('server') || CONFIGURED_SERVER || location.origin);
    setServer(active);
    // The user id is what Sarvam's Log Analyser searches by; one per visit, findable by its prefix.
    setUserId(`tiffany-web-${Date.now()}`);
    if (window.isSecureContext) show(`Ready. Calls go through ${active}.`, false, true);
    else show(`This browser blocks the microphone on ${location.origin}. Open the page over https:// or on http://localhost.`, true);

    // A sleeping Render server takes up to a minute to start, so wake another server before the first click.
    if (active !== location.origin) fetch(`${active}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});

    const nativeFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${active}/api/sarvam/`)) return nativeFetch.call(window, input, init);
      show(`Starting the call through ${active}...`);
      try {
        const res = await nativeFetch.call(window, input, init);
        if (res.ok) show(`Connected to ${active}. If the call does not start, allow the microphone and try again.`);
        else show(explain(res, active), true);
        return res;
      } catch (err) {
        show(`Cannot reach ${active}. Check the internet connection and the server address, then try again.`, true);
        throw err;
      }
    };
    return () => {
      window.fetch = nativeFetch;
    };
  }, []);

  const note = variant === 'floating'
    ? !status.ready && status.text && (
      <div className={status.problem ? 'voice-note problem-note' : 'voice-note'} role="status">
        {status.text}
        <button type="button" aria-label="Dismiss" onClick={() => setStatus((s) => ({ ...s, ready: true }))}>
          <X aria-hidden="true" />
        </button>
      </div>
    )
    : <p className={status.problem ? 'status-line problem-line' : 'status-line'} role="status">{status.text}</p>;

  return (
    <>
      {note}
      {/* Rendered in the browser only, so the server address and per-visit user id are set before the widget starts. */}
      {userId && (
        <sarvam-widget
          session-endpoint={`${server}/api/sarvam/`}
          user-id={userId}
          app-id={AGENT.appId}
          org-id={AGENT.orgId}
          workspace-id={AGENT.workspaceId}
          button-text="Begin call"
          interaction-type="call"
          button-color="#6e2a24"
          position="bottom-right"
        />
      )}
      <Script src="https://unpkg.com/sarvam-convai-embed@1.0.20/index.js" strategy="afterInteractive" />
    </>
  );
}
