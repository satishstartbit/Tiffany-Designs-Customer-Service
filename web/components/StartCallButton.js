'use client';

import { useState } from 'react';
import { Mic } from 'lucide-react';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts a call from anywhere on the page: opens the voice widget (bottom right) and presses its Start call button.
export default function StartCallButton({ className = 'btn', children = 'Start a voice call' }) {
  const [waiting, setWaiting] = useState('');

  async function start() {
    const root = document.querySelector('sarvam-widget')?.shadowRoot;
    const buttons = () => [...(root?.querySelectorAll('button') || [])];
    const find = (pattern) => buttons().find((b) => pattern.test(b.textContent || ''));
    if (!buttons().length) {
      setWaiting('The voice assistant is still loading. Please try again in a moment.');
      return;
    }
    setWaiting('');
    if (find(/end call|hang up|disconnect/i)) return;
    let begin = find(/start call/i);
    if (!begin) {
      buttons()[0].click();
      for (let i = 0; i < 20 && !begin; i += 1) {
        await sleep(100);
        begin = find(/start call/i);
      }
    }
    begin?.click();
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
