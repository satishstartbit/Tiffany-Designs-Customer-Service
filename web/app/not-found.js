import Link from 'next/link';
import BrandMark from '@/components/BrandMark.js';

export default function NotFound() {
  return (
    <main className="call-page" style={{ textAlign: 'center' }}>
      <BrandMark />
      <h1 style={{ marginTop: 16 }}>Page not found</h1>
      <p className="muted">The page you asked for does not exist.</p>
      <Link className="btn" href="/">Go to the console</Link>
    </main>
  );
}
