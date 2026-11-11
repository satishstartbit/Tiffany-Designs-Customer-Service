'use client';

import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { CHAT_OPEN_EVENT } from '@/lib/chat.js';

// Opens the chat panel (bottom right) from anywhere on the page, at its mobile number step. Not during a voice call:
// the chat takes the call widget's place.
export default function StartChatButton({ className = 'btn btn-outline', children = 'Chat with us' }) {
  const [hint, setHint] = useState('');

  function open() {
    if (document.body.dataset.voice === 'calling') {
      setHint('Please end the voice call first, then start a chat.');
      return;
    }
    setHint('');
    window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
  }

  return (
    <>
      <button className={className} type="button" onClick={open}>
        <MessageCircle aria-hidden="true" /> {children}
      </button>
      {hint && <span className="hint" role="status">{hint}</span>}
    </>
  );
}
