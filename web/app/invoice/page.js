import Link from 'next/link';
import { Mail, Phone, ShieldCheck } from 'lucide-react';
import BrandMark from '@/components/BrandMark.js';
import InvoiceUpload from '@/components/InvoiceUpload.js';
import { SUPPORT_EMAIL, SUPPORT_PHONE, telLink } from '@/lib/contact.js';

export const metadata = {
  title: 'Upload your invoice',
  description: 'Send Tiffany Designs a photo, screenshot or PDF of your invoice so our service team can find your order.',
  robots: { index: false, follow: false },
};

const TIPS = [
  'Show the whole invoice, with the invoice number, the order id, your name, your phone number, your address and the product list.',
  'It must be a Tiffany Designs invoice, where Sold By shows Tiffany Designs Private Limited. An invoice from our website, a showroom bill, or an Amazon, Flipkart or FirstCry invoice works when it shows this.',
  'If you are on the call with our assistant, stay on the line and tell it once this page says your invoice is received. It then finds your order and carries on with your request.',
];

// Public, no sign-in, one address for every customer: the WhatsApp link the voice agent sends when it cannot find a
// caller's order. The page asks only for the file and reads nothing itself; the file goes through app/api/invoice.
export default function InvoicePage() {
  return (
    <div className="site">
      <div className="site-utility">
        <a href={telLink(SUPPORT_PHONE)}><Phone aria-hidden="true" /> {SUPPORT_PHONE}</a>
        <a href={`mailto:${SUPPORT_EMAIL}`}><Mail aria-hidden="true" /> {SUPPORT_EMAIL}</a>
      </div>

      <header className="site-header">
        <Link className="brand" href="/support" style={{ padding: 0 }}>
          <BrandMark />
          <span>
            <span className="brand-name">Tiffany Designs</span>
            <span className="brand-sub">Home furniture</span>
          </span>
        </Link>
      </header>

      <main className="upload-page">
        <div className="eyebrow">Customer care</div>
        <h1>Upload your invoice</h1>
        <p className="upload-lead">
          We could not find your order on the call. Send us your invoice and we will find the order, or add it from the invoice, and link it to your request.
        </p>

        <InvoiceUpload />

        <ul className="upload-tips">
          {TIPS.map((tip) => <li key={tip}>{tip}</li>)}
        </ul>

        <div className="safety">
          <ShieldCheck aria-hidden="true" />
          <span>We only need the invoice. We never ask for card, UPI, bank or OTP details.</span>
        </div>
      </main>

      <footer className="site-footer">
        <div>
          <strong>Tiffany Designs</strong>
          <span>Home furniture · Customer care</span>
        </div>
        <div>
          <a href={telLink(SUPPORT_PHONE)}>{SUPPORT_PHONE}</a>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </div>
        <div>
          <span>© {new Date().getFullYear()} Tiffany Designs</span>
          <Link href="/support">Customer care</Link>
        </div>
      </footer>
    </div>
  );
}
