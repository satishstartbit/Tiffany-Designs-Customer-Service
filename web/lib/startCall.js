import { CHAT_CLOSE_EVENT } from './chat.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts a call from anywhere on the page through the voice widget (bottom right). A closed widget is opened first,
// with the cursor in the mobile number field of its panel, so the customer gives the number and then chooses Call; an
// open one starts the call at once (the widget refuses without a valid number). An open chat panel with no chat
// running steps aside for the widget; a running chat has to end first. Answers what to tell the customer, or ''.
export async function startVoiceCall() {
  if (document.body.dataset.chat === 'live') return 'Please end the chat first, then start a voice call.';
  if (document.body.dataset.chat) {
    window.dispatchEvent(new CustomEvent(CHAT_CLOSE_EVENT));
    await sleep(50);
  }
  const root = document.querySelector('sarvam-widget')?.shadowRoot;
  const buttons = () => [...(root?.querySelectorAll('button') || [])];
  const find = (pattern) => buttons().find((b) => pattern.test(b.textContent || ''));
  if (!buttons().length) return 'The voice assistant is still loading. Please try again in a moment.';
  if (find(/end call|hang up|disconnect/i)) return '';
  // The widget's own Start call button, also while the panel shows its Call and Chat options in its place.
  const begin = find(/start call/i);
  if (begin) {
    begin.click();
    return '';
  }
  buttons()[0].click();
  for (let i = 0; i < 20; i += 1) {
    await sleep(100);
    const field = root.getElementById('caller-mobile');
    if (field) {
      field.focus();
      return '';
    }
  }
  return '';
}
