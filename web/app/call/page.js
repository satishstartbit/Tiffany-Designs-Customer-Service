import BrandMark from '@/components/BrandMark.js';
import VoiceAgent from '@/components/VoiceAgent.js';

export const metadata = { title: 'Talk to our voice agent' };

// Public: anyone with the link can try the voice agent, without a console sign-in.
export default function CallPage() {
  return (
    <main className="call-page">
      <header>
        <BrandMark />
        <div>
          <div className="eyebrow" style={{ marginBottom: 2 }}>Tiffany Designs</div>
          <h1>Voice agent</h1>
        </div>
      </header>
      <p>Click <strong>Begin call</strong> at the bottom right and allow the microphone when your browser asks.</p>
      <VoiceAgent />
    </main>
  );
}
