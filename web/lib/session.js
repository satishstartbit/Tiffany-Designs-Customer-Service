import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signToken, verifyToken } from './token.js';

const COOKIE = 'td_console';
const MAX_AGE_SECONDS = 12 * 60 * 60;

// The console has one staff sign-in, set in the server environment (web/.env.local, or Vercel variables).
export function authConfig() {
  const secret = process.env.SESSION_SECRET || '';
  const password = process.env.ADMIN_PASSWORD || '';
  return {
    email: (process.env.ADMIN_EMAIL || 'admin@tiffanydesigns.in').trim().toLowerCase(),
    password,
    secret,
    ready: Boolean(password) && secret.length >= 32,
  };
}

// Reading the cookie first makes every page that checks the session render per request, never at build time.
export async function getSession() {
  const store = await cookies();
  const { secret, ready } = authConfig();
  if (!ready) return null;
  return verifyToken(store.get(COOKIE)?.value, secret);
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export async function startSession(email) {
  (await cookies()).set(COOKIE, signToken({ email }, authConfig().secret, { maxAgeSeconds: MAX_AGE_SECONDS }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}
