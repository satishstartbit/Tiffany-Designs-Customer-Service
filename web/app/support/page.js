import Link from 'next/link';
import { connection } from 'next/server';
import {
  CalendarCheck, ClipboardList, Hash, Mail, MapPin, Mic, PackageSearch, Phone, PhoneCall, Replace, ShieldCheck, ShoppingBag,
  Smartphone, Sofa, TriangleAlert, Wrench,
} from 'lucide-react';
import BrandMark from '@/components/BrandMark.js';
import { AGENT_NAME } from '@/lib/agent.js';
import StartCallButton from '@/components/StartCallButton.js';
import VoiceAgent from '@/components/VoiceAgent.js';
import { loadSupportHours } from '@/lib/api.js';
import { SUPPORT_EMAIL, SUPPORT_PHONE, telLink } from '@/lib/contact.js';
import { dateTime, minutesOfDay, time } from '@/lib/format.js';

export const metadata = {
  title: 'Customer care',
  description: 'Talk to the Tiffany Designs AI service assistant from your browser: order status, installation, damaged or missing parts, replacements and new orders.',
};

const HELP = [
  [PackageSearch, 'Track your order', 'Delivery status and dates, from your order id, order number or invoice number.'],
  [CalendarCheck, 'Book installation', 'Get a technician visit booked for your new furniture.'],
  [TriangleAlert, 'Report a problem', 'Damaged, defective, missing or wrong parts, registered for our service team.'],
  [Replace, 'Replacements and returns', 'Ask for a replacement part or a return.'],
  [ClipboardList, 'Check a request', 'The status of a request you already made, and any technician visit.'],
  [Sofa, 'Find furniture', 'Ask about our study tables, wardrobes, beds, bookcases and cabinets, and their prices.'],
  [ShoppingBag, 'Place an order', 'Order by voice; our sales team confirms the details with you.'],
  [PhoneCall, 'Ask for a call back', 'Someone from our service team calls you back.'],
];

const HANDY = [
  [Hash, 'Your order id or invoice number', 'From your invoice, or your Amazon, Flipkart or FirstCry order.'],
  [Smartphone, 'Your registered mobile number', 'The number you gave when you ordered. No mobile? Your full name works too.'],
  [MapPin, 'Your delivery PIN code', 'So the right team visits you.'],
];

// Public: no sign-in. Customers talk to the AI voice agent from here.
export default async function SupportPage() {
  await connection();
  const hours = await loadSupportHours();
  const openDays = hours?.weekly?.filter((d) => d.window) || [];

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
        <nav className="site-nav" aria-label="Customer care">
          <a href="#help">How we can help</a>
          <a href="#before">Before you call</a>
          <a href="#hours">Hours</a>
        </nav>
      </header>

      <main>
        <section className="site-hero">
          <div className="site-hero-text">
            <div className="eyebrow">Customer care</div>
            <h1>Talk to the {AGENT_NAME}</h1>
            <p>
              Track an order, book installation, report a damaged or missing part, or order furniture, by voice, right here in your browser.
              No app to install and no waiting on hold.
            </p>
            <div className="hero-actions">
              <StartCallButton />
              {/* <a className="btn btn-outline" href={telLink(SUPPORT_PHONE)}><Phone aria-hidden="true" /> Call {SUPPORT_PHONE}</a> */}
            </div>
            <p className="small muted" style={{ marginTop: 14 }}>
              The {AGENT_NAME} answers any time. Requests registered on the call go straight to our service team.
            </p>
          </div>
          <div className="call-art" aria-hidden="true">
            <div className="call-card">
              <div className="call-ring"><Mic /></div>
              <strong>AI service assistant</strong>
              <span>Tiffany Designs customer care</span>
              <div className="wave">{Array.from({ length: 13 }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 7) * 0.12}s` }} />)}</div>
              <span className="call-live"><span className="dot on" /> Ready to talk</span>
            </div>
          </div>
        </section>

        <section className="site-section" id="help">
          <h2 className="site-title">How we can help</h2>
          <div className="help-grid">
            {HELP.map(([Icon, title, text]) => (
              <div className="help-card" key={title}>
                <Icon aria-hidden="true" />
                <strong>{title}</strong>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="site-band" id="before">
          <div className="site-band-inner">
            <h2 className="site-title">Before you call, keep these handy</h2>
            <div className="handy-grid">
              {HANDY.map(([Icon, title, text]) => (
                <div className="promise" key={title}>
                  <Icon aria-hidden="true" />
                  <span><strong>{title}</strong><span>{text}</span></span>
                </div>
              ))}
            </div>
            <div className="safety">
              <ShieldCheck aria-hidden="true" />
              <span>We never ask for card, UPI, bank or OTP details on a call. Do not share them with anyone who asks.</span>
            </div>
          </div>
        </section>

        <section className="site-section">
          <h2 className="site-title">How it works</h2>
          <ol className="steps">
            <li><strong>Start the call</strong><span>Press Start a voice call, or the button at the bottom right. Enter your mobile number so the assistant finds your orders, then press Start call.</span></li>
            <li><strong>Allow the microphone</strong><span>Your browser asks once. Use a quiet place and your phone or computer&apos;s microphone.</span></li>
            <li><strong>Speak naturally</strong><span>Tell the assistant what you need. You get a request or order number before the call ends.</span></li>
          </ol>
          <div style={{ textAlign: 'center', marginTop: 28 }}>
            <StartCallButton />
          </div>
        </section>

        <section className="site-section" id="hours">
          <h2 className="site-title">Service team hours</h2>
          <div className="hours-card card">
            {hours ? (
              <>
                <p style={{ marginTop: 0, textAlign: 'center' }}>
                  {hours.open
                    ? <span className="open-pill"><span className="dot on" /> Our team is working now · until {time(hours.closesAt)}</span>
                    : <span className="open-pill"><span className="dot" /> Our team is away{hours.holidayName ? ` for ${hours.holidayName}` : ''} · back {dateTime(hours.opensAt)}</span>}
                </p>
                <div className="week">
                  {hours.weekly.map((d) => (
                    <div className="week-row" key={d.day}>
                      <span>{d.day}</span>
                      <span className={d.window ? '' : 'muted'}>{d.window ? `${minutesOfDay(d.window.start)} – ${minutesOfDay(d.window.end)}` : 'Closed'}</span>
                    </div>
                  ))}
                </div>
                <p className="small muted" style={{ marginBottom: 0 }}>
                  {openDays.length ? 'Times are India time. ' : ''}The AI service assistant takes your request at any hour; our team picks it up when they are back.
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
                The AI service assistant takes your request at any hour; our service team picks it up on working days.
              </p>
            )}
          </div>
          <p className="small muted" style={{ textAlign: 'center', marginTop: 16 }}>
            <Wrench size={14} aria-hidden="true" /> Service across India: our own technicians in Delhi NCR, and trusted service partners everywhere else.
          </p>
        </section>
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
          <Link href="/login">Staff sign in</Link>
        </div>
      </footer>

      <VoiceAgent />
    </div>
  );
}
