'use client';

import { useState } from 'react';
import { Mic } from 'lucide-react';
import { startVoiceCall } from '@/lib/startCall.js';

// Starts a call from anywhere on the page through the voice widget (bottom right), as startVoiceCall says. A running
// chat has to end first: "Please end the chat first, then start a voice call."
export default function StartCallButton({ className = 'btn', children = 'Start a voice call' }) {
  const [waiting, setWaiting] = useState('');

  async function start() {
    setWaiting('');
    setWaiting(await startVoiceCall());
  }

  return (
    <>
      <button className={className} type="button" onClick={start}>
        <Mic aria-hidden="true" /> {children}
      </button>
      {waiting && <span className="hint" role="status">{waiting}</span>}
    </>
  );
}
