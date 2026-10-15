'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authConfig, endSession, startSession } from '@/lib/session.js';
import { sameSecret } from '@/lib/token.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const failures = new Map();

// Wrong passwords are limited per visitor address (per server instance), so the password cannot be guessed quickly.
export async function signIn(previous, formData) {
  const config = authConfig();
  if (!config.ready) {
    return { error: 'Sign-in is not set up yet: set ADMIN_PASSWORD and SESSION_SECRET (32 characters or more) in this site\'s environment.' };
  }
  const h = await headers();
  const visitor = h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const now = Date.now();
  const recent = (failures.get(visitor) || []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) return { error: 'Too many attempts. Try again in 15 minutes.' };

  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');
  const passwordOk = sameSecret(password, config.password);
  if (email !== config.email || !passwordOk) {
    failures.set(visitor, [...recent, now]);
    return { error: 'That email and password do not match.', email };
  }

  failures.delete(visitor);
  await startSession(email);
  redirect('/');
}

export async function signOut() {
  await endSession();
  redirect('/login');
}
