import { createHmac, timingSafeEqual } from 'node:crypto';

const signature = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

// The session cookie: base64url(JSON with an expiry) and its HMAC, so it cannot be forged or kept past its time.
export function signToken(value, secret, { maxAgeSeconds, now = Date.now() }) {
  const body = Buffer.from(JSON.stringify({ ...value, exp: now + maxAgeSeconds * 1000 })).toString('base64url');
  return `${body}.${signature(body, secret)}`;
}

export function verifyToken(token, secret, { now = Date.now() } = {}) {
  const [body, given, extra] = String(token || '').split('.');
  if (!body || !given || extra !== undefined || !secret) return null;
  const expected = Buffer.from(signature(body, secret));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof value.exp === 'number' && value.exp > now ? value : null;
  } catch {
    return null;
  }
}

// Compares a typed password with the configured one in constant time, whatever their lengths.
export function sameSecret(given, expected) {
  if (!expected) return false;
  const digest = (value) => createHmac('sha256', 'tiffany-console').update(String(value ?? '')).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
