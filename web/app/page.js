import VoiceAgent from './VoiceAgent';

export default function Home() {
  return (
    <main>
      <h1>Tiffany Designs voice agent</h1>
      <p>Click <strong>Begin call</strong> at the bottom right and allow the microphone when your browser asks.</p>
      <VoiceAgent />
    </main>
  );
}
