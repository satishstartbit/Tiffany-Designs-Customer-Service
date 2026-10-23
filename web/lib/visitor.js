// Vercel sets these from the connection, so a visitor cannot pick another address to dodge the limits.
export function visitorIp(request) {
  return request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}
