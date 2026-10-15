'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';

// The Node server (repository root) keeps the Sarvam API key: the widget asks its /api/sarvam/ for a signed call URL.
const DEFAULT_SERVER = process.env.NEXT_PUBLIC_VOICE_SERVER_URL || 'https://tiffany-designs-customer-service.onrender.com';

const AGENT = {
  'app-id': 'Tiffany-Des-0db8e21d-e099',
  'org-id': '01a0c3a4-b74a-7441-813a-d7d799923769',
  'workspace-id': '01a0c3ef-4753-7a81-a20c-07f739dcf1d6',
};

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
      return `${server} does not know this agent. Check app-id, org-id and workspace-id.`;
    case 429:
      return `Too many calls were started from this network. Try again in about ${waitFor(res)}.`;
    case 503:
      return `${server} is up but cannot start calls: its SARVAM_API_KEY is missing or Sarvam refused it. `
        + 'Set the current Sarvam workspace key in that server\'s environment (Render: Environment; '
        + 'Vercel: Settings, Environment Variables), redeploy, then try again.';
    default:
      return `${server} answered ${res.status}. Try again in a minute.`;
  }
}

export default function VoiceAgent() {
  const [server, setServer] = useState(withoutTrailingSlash(DEFAULT_SERVER));
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState({ text: '', problem: false });

  useEffect(() => {
    const show = (text, problem = false) => setStatus({ text, problem });
    // ?server=http://localhost:8081 points the page at another copy of the Node server.
    const active = withoutTrailingSlash(new URLSearchParams(location.search).get('server') || DEFAULT_SERVER);
    setServer(active);
    // The user id is what Sarvam's Log Analyser searches by; one per visit, findable by its prefix.
    setUserId(`tiffany-web-${Date.now()}`);
    if (window.isSecureContext) show(`Ready. Calls go through ${active}.`);
    else show(`This browser blocks the microphone on ${location.origin}. Open the page over https:// or on http://localhost.`, true);

    // A sleeping Render server takes up to a minute to start, so wake it before the first click.
    fetch(`${active}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});

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

  return (
    <>
      <p className={status.problem ? 'status problem' : 'status'} role="status">{status.text}</p>
      {/* Rendered in the browser only, so the per-visit user id is set before the widget starts. */}
      {userId && (
        <sarvam-widget
          session-endpoint={`${server}/api/sarvam/`}
          user-id={userId}
          {...AGENT}
          button-text="Begin call"
          interaction-type="call"
          button-color="#6b3a1e"
          position="bottom-right"
        />
      )}
      <Script src="https://unpkg.com/sarvam-convai-embed@1.0.20/index.js" strategy="afterInteractive" />
    </>
  );
}
