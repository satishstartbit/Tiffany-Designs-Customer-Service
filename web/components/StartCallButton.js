'use client';

import { useState } from 'react';
import { Mic } from 'lucide-react';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts a call from anywhere on the page through the voice widget (bottom right). A closed widget is opened first,
// with the cursor in the mobile number field of its panel, so the customer gives the number and then presses Start
// call; an open one starts the call at once (the widget refuses without a valid number).
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
    const begin = find(/start call/i);
    if (begin) {
      begin.click();
      return;
    }
    buttons()[0].click();
    for (let i = 0; i < 20; i += 1) {
      await sleep(100);
      const field = root.getElementById('caller-mobile');
      if (field) {
        field.focus();
        return;
      }
    }
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
