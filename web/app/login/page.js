import { redirect } from 'next/navigation';
import { Boxes, LifeBuoy, Mic } from 'lucide-react';
import BrandMark from '@/components/BrandMark.js';
import { authConfig, getSession } from '@/lib/session.js';
import LoginForm from './LoginForm.js';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  // Shown only while developing (npm run dev). A deployed site never shows them: the console holds customer data.
  const config = authConfig();
  const localSignIn = process.env.NODE_ENV !== 'production' && config.ready ? { email: config.email, password: config.password } : null;
  return (
    <div className="auth">
      <section className="auth-art">
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          <span>
            <span className="brand-name">Tiffany Designs</span>
            <span className="brand-sub">Home furniture</span>
          </span>
        </div>
        <div>
          <div className="eyebrow">Service console</div>
          <h2>Every order, case and call in one place.</h2>
          <p>Live from Salesforce: the catalogue, customer orders, service cases, technician visits, replacement parts and the AI voice agent&apos;s calls.</p>
        </div>
        <div className="chips">
          <span className="tag"><Boxes size={14} aria-hidden="true" />&nbsp;Products &amp; orders</span>
          <span className="tag"><LifeBuoy size={14} aria-hidden="true" />&nbsp;Cases &amp; requests</span>
          <span className="tag"><Mic size={14} aria-hidden="true" />&nbsp;AI voice agent</span>
        </div>
      </section>
      <section className="auth-form">
        <LoginForm localSignIn={localSignIn} />
      </section>
    </div>
  );
}
