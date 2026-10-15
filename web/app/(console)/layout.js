import ConsoleShell from '@/components/ConsoleShell.js';
import VoiceAgent from '@/components/VoiceAgent.js';
import { requireSession } from '@/lib/session.js';

// Every console page needs a staff sign-in; each data read checks it again (lib/api.js).
export default async function ConsoleLayout({ children }) {
  const session = await requireSession();
  return (
    <>
      <ConsoleShell email={session.email}>{children}</ConsoleShell>
      <VoiceAgent variant="floating" />
    </>
  );
}
