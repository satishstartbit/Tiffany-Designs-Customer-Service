import ConsoleShell from '@/components/ConsoleShell.js';
import { requireSession } from '@/lib/session.js';

// Every console page needs a staff sign-in; each data read checks it again (lib/api.js).
// The voice agent is for customers, on the public customer care page (/support), not here.
export default async function ConsoleLayout({ children }) {
  const session = await requireSession();
  return <ConsoleShell email={session.email}>{children}</ConsoleShell>;
}
