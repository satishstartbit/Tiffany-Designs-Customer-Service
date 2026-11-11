'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Phone, Send, X } from 'lucide-react';
import { AGENT_NAME } from '@/lib/agent.js';
import { callerPhone } from '@/lib/caller.js';
import { CHAT_CLOSE_EVENT, CHAT_OPEN_EVENT, MAX_MESSAGE_LENGTH, startChat } from '@/lib/chat.js';
import { startVoiceCall } from '@/lib/startCall.js';

// The call widget's key too, so a number typed in one is already in the other.
const SAVED_PHONE = 'tiffany-caller-phone';
const remembered = () => {
  try { return sessionStorage.getItem(SAVED_PHONE) || ''; } catch { return ''; }
};
const remember = (value) => {
  try { sessionStorage.setItem(SAVED_PHONE, value); } catch { /* private window */ }
};

const PHONE_HINT = 'We use it to find your orders.';
const PHONE_NEEDED = 'Enter your 10 digit mobile number to start the chat.';

function statusLine(transcript) {
  if (!transcript) return 'Chat · answers any time';
  if (transcript.status === 'connecting') return 'Connecting…';
  if (transcript.status === 'ended') return 'Chat ended';
  return transcript.waiting ? 'Typing…' : 'Online';
}

// The chat panel (bottom right): a text chat with the same agent as the voice call. It opens from the page's Chat with
// us buttons and the call widget's Start chat button (CHAT_OPEN_EVENT), needs a valid mobile number like a call, and
// takes the call widget's place while it is open or a chat is live (body[data-chat] hides the widget). Closing a live
// chat folds it into a button; End chat finishes it.
export default function ChatAgent() {
  // 'closed', 'open', or 'minimised' (folded into the button at the bottom right).
  const [view, setView] = useState('closed');
  const [phone, setPhone] = useState('');
  const [phoneProblem, setPhoneProblem] = useState('');
  // null before a chat starts: the panel asks for the number.
  const [transcript, setTranscript] = useState(null);
  const [problem, setProblem] = useState('');
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(false);
  const chatRef = useRef(null);
  const chatIdRef = useRef(0);
  const liveRef = useRef(false);
  const seenRef = useRef(0);
  const logRef = useRef(null);
  const phoneRef = useRef(null);
  const draftRef = useRef(null);

  const live = Boolean(transcript) && transcript.status !== 'ended';
  liveRef.current = live;
  const stage = transcript ? transcript.status : 'start';

  function begin(value) {
    const number = callerPhone(value);
    if (!number) {
      setTranscript(null);
      setPhoneProblem(PHONE_NEEDED);
      phoneRef.current?.focus();
      return;
    }
    remember(value);
    setPhoneProblem('');
    setProblem('');
    setDraft('');
    // Only the newest chat may change the panel, so the old one is let go before it is ended.
    chatIdRef.current += 1;
    const id = chatIdRef.current;
    chatRef.current?.end();
    // This site's /api/chat runs the chat through the Node server, with its key kept on this site's server.
    chatRef.current = startChat({
      server: location.origin,
      phone: number,
      onChange: (next) => id === chatIdRef.current && setTranscript(next),
      onProblem: (text) => id === chatIdRef.current && setProblem(text),
    });
  }

  function close() {
    if (liveRef.current) {
      setView('minimised');
      return;
    }
    setView('closed');
    setTranscript(null);
    setProblem('');
  }

  function send(event) {
    event?.preventDefault();
    if (chatRef.current?.send(draft)) setDraft('');
  }

  // A chat that could not start: the same assistant takes the call instead, with the number already typed (saved
  // under the key the call widget reads).
  async function callInstead() {
    remember(phone);
    chatIdRef.current += 1;
    chatRef.current?.end();
    setView('closed');
    setTranscript(null);
    setProblem('');
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    await startVoiceCall();
  }

  useEffect(() => {
    setPhone(remembered());
    const onOpen = (event) => {
      const typed = event.detail?.phone || remembered();
      setView('open');
      if (liveRef.current) return;
      setPhone(typed);
      if (event.detail?.start) begin(typed);
    };
    const onClose = () => {
      if (liveRef.current) return;
      setView('closed');
      setTranscript(null);
      setProblem('');
    };
    window.addEventListener(CHAT_OPEN_EVENT, onOpen);
    window.addEventListener(CHAT_CLOSE_EVENT, onClose);
    return () => {
      window.removeEventListener(CHAT_OPEN_EVENT, onOpen);
      window.removeEventListener(CHAT_CLOSE_EVENT, onClose);
      chatRef.current?.end();
    };
    // begin only uses refs and state setters.
  }, []);

  // 'open' while the panel is up, 'live' while a chat runs: the call widget and its notes step aside for both.
  useEffect(() => {
    const mode = live ? 'live' : view === 'closed' ? null : 'open';
    if (mode) document.body.dataset.chat = mode;
    else delete document.body.dataset.chat;
  }, [live, view]);
  useEffect(() => () => { delete document.body.dataset.chat; }, []);

  // A new answer while the chat is folded away marks the button.
  useEffect(() => {
    const answers = transcript ? transcript.messages.filter((m) => m.from === 'agent').length : 0;
    if (view !== 'minimised') {
      seenRef.current = answers;
      setUnread(false);
    } else if (answers > seenRef.current) {
      setUnread(true);
    }
  }, [transcript, view]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [transcript, problem, view]);

  useEffect(() => {
    if (view !== 'open') return;
    if (stage === 'start') phoneRef.current?.focus();
    else if (stage === 'open') draftRef.current?.focus();
  }, [view, stage]);

  if (view === 'closed') return null;

  if (view === 'minimised') {
    return (
      <button type="button" className="chat-bubble" onClick={() => setView('open')} aria-label={unread ? 'Open the chat: new message' : 'Open the chat'}>
        <MessageCircle aria-hidden="true" /> Chat
        {unread && <span className="chat-unread" aria-hidden="true" />}
      </button>
    );
  }

  const answered = transcript?.messages.some((m) => m.from === 'agent');
  const typing = live && (transcript.status === 'connecting' || transcript.waiting || !answered);

  return (
    <section
      className="chat-panel"
      role="dialog"
      aria-label={`Chat with the ${AGENT_NAME}`}
      onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
    >
      <header className="chat-head">
        <span className="chat-avatar" aria-hidden="true"><MessageCircle /></span>
        <span className="chat-title">
          <strong>{AGENT_NAME}</strong>
          <span><span className={live && stage === 'open' ? 'dot on' : 'dot'} /> {statusLine(transcript)}</span>
        </span>
        <button type="button" className="chat-close" onClick={close} aria-label={live ? 'Fold the chat away' : 'Close the chat'}>
          <X aria-hidden="true" />
        </button>
      </header>

      {!transcript ? (
        <form className="chat-start" onSubmit={(event) => { event.preventDefault(); begin(phone); }} noValidate>
          <p className="chat-intro">
            Type your question: track an order, book installation, report a damaged or missing part, check a request or order furniture.
          </p>
          <label htmlFor="chat-mobile">Your mobile number</label>
          <input
            id="chat-mobile"
            ref={phoneRef}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="10 digit mobile number"
            maxLength={16}
            value={phone}
            aria-invalid={phoneProblem ? 'true' : 'false'}
            aria-describedby="chat-mobile-hint"
            onChange={(event) => {
              setPhone(event.target.value);
              remember(event.target.value);
              if (callerPhone(event.target.value)) setPhoneProblem('');
            }}
          />
          <p id="chat-mobile-hint" className={phoneProblem ? 'chat-hint problem' : 'chat-hint'}>{phoneProblem || PHONE_HINT}</p>
          <button className="btn btn-maroon btn-block" type="submit">Start chat</button>
          <p className="chat-safety">We never ask for card, UPI, bank or OTP details. Do not share them in the chat.</p>
        </form>
      ) : (
        <>
          <div className="chat-log" ref={logRef} role="log" aria-label="Conversation">
            {transcript.messages.map((m) => (
              <div key={m.id} className={`chat-msg ${m.from}`}>{m.text}</div>
            ))}
            {typing && (
              <div className="chat-msg agent chat-typing" aria-label="The assistant is typing">
                <span /><span /><span />
              </div>
            )}
            {transcript.status === 'connecting' && !problem && <p className="chat-note">Connecting you to our assistant…</p>}
            {problem && <p className="chat-problem" role="alert">{problem}</p>}
            {transcript.status === 'ended' && !problem && <p className="chat-note">The chat has ended.</p>}
          </div>

          {transcript.status === 'ended' ? (
            <div className="chat-foot">
              {!transcript.messages.length && problem && (
                <button className="btn btn-maroon btn-block" type="button" onClick={callInstead}>
                  <Phone aria-hidden="true" /> Call instead
                </button>
              )}
              <button className="btn btn-block" type="button" onClick={() => begin(phone)}>
                {transcript.messages.length ? 'Start a new chat' : 'Try again'}
              </button>
            </div>
          ) : (
            <form className="chat-foot" onSubmit={send}>
              <div className="chat-compose">
                <textarea
                  ref={draftRef}
                  rows={1}
                  value={draft}
                  maxLength={MAX_MESSAGE_LENGTH}
                  placeholder={stage === 'open' ? 'Type your message' : 'Connecting…'}
                  aria-label="Your message"
                  disabled={stage !== 'open'}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
                  }}
                />
                <button className="chat-send" type="submit" aria-label="Send" disabled={stage !== 'open' || !draft.trim()}>
                  <Send aria-hidden="true" />
                </button>
              </div>
              <button className="btn btn-ghost chat-end" type="button" onClick={() => chatRef.current?.end()}>End chat</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
