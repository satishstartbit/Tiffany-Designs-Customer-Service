import Link from 'next/link';
import {
  ArrowRight, CalendarClock, IndianRupee, LifeBuoy, MapPin, Mic, Package, PhoneCall, ShieldCheck, TriangleAlert, Users,
} from 'lucide-react';
import { Card, Empty, Problem, Stat, Status } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, dateTime, money, number, time } from '@/lib/format.js';

export const metadata = { title: 'Dashboard' };

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function HoursPill({ hours }) {
  if (!hours?.configured) return <span className="open-pill"><span className="dot" /> Business hours are not set in Salesforce</span>;
  if (hours.open) {
    return <span className="open-pill"><span className="dot on" /> Support is open now · closes at {time(hours.closesAt)}</span>;
  }
  return (
    <span className="open-pill">
      <span className="dot" /> Support is closed{hours.holidayName ? ` for ${hours.holidayName}` : ''} · opens {dateTime(hours.opensAt)}
    </span>
  );
}

export default async function DashboardPage() {
  const { data, error } = await loadAdmin('summary');
  if (error) return <Problem message={error} />;
  const { counts, openCasesByType, recentOrders, recentCases, hours } = data;
  const biggest = Math.max(1, ...openCasesByType.map((t) => t.count));

  return (
    <>
      <section className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="eyebrow">Customer service</div>
          <h1>{greeting()}</h1>
          <p>{number(counts.openCases)} open cases, {number(counts.casesToday)} new today, and {number(counts.draftOrders)} phone orders waiting for confirmation.</p>
          <HoursPill hours={hours} />
        </div>
        <div className="hero-actions">
          <Link className="btn" href="/cases?state=open">Open cases <ArrowRight aria-hidden="true" /></Link>
          <Link className="btn btn-outline" href="/orders?status=Draft">Orders to confirm</Link>
        </div>
      </section>

      <div className="stats">
        <Stat icon={Package} label="Orders" value={number(counts.orders)} hint={`${number(counts.draftOrders)} drafts to confirm`} href="/orders" />
        <Stat icon={IndianRupee} label="Order value" value={money(counts.revenue)} hint="All orders in Salesforce" href="/orders" />
        <Stat icon={LifeBuoy} label="Open cases" value={number(counts.openCases)} hint={`${number(counts.escalatedCases)} escalated`} href="/cases?state=open" />
        <Stat icon={Users} label="Customers" value={number(counts.customers)} hint={`${number(counts.products)} products in the catalogue`} href="/customers" />
      </div>

      <div className="grid grid-main section">
        <Card title="Latest orders" action={<Link className="btn btn-ghost" href="/orders">View all</Link>} flush>
          {recentOrders.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Order</th><th>Customer</th><th>Status</th><th>Delivery</th><th className="num">Total</th></tr>
                </thead>
                <tbody>
                  {recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="nowrap">
                        <Link className="row-link" href={`/orders/${o.id}`}>{o.erpOrderId || `#${o.orderNumber}`}</Link>
                        <span className="cell-sub">{date(o.orderDate)}</span>
                      </td>
                      <td>{o.customerName || '—'}<span className="cell-sub">{o.products.slice(0, 2).join(', ') || 'No items'}</span></td>
                      <td><Status value={o.status} /></td>
                      <td><Status value={o.deliveryStatus} fallback="Not shipped" /></td>
                      <td className="num price">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Package} title="No orders yet" />}
        </Card>

        <Card title="Open cases by type">
          {openCasesByType.length ? (
            <div className="bars">
              {openCasesByType.map((t) => (
                <Link key={t.type} className="bar-row" href={t.type === 'Not set' ? '/cases?state=open' : `/cases?state=open&type=${encodeURIComponent(t.type)}`}>
                  <span className="bar-row-head"><span>{t.type}</span><strong>{t.count}</strong></span>
                  <span className="bar-track"><span className="bar-fill" style={{ width: `${(t.count / biggest) * 100}%`, display: 'block' }} /></span>
                </Link>
              ))}
            </div>
          ) : <Empty icon={ShieldCheck} title="No open cases" />}
        </Card>
      </div>

      <div className="section">
        <Card title="Newest open cases" action={<Link className="btn btn-ghost" href="/cases?state=open">View all</Link>} flush>
          {recentCases.length ? (
            <div className="list">
              {recentCases.map((c) => (
                <div className="list-item" key={c.id}>
                  <div className="item-row">
                    <span className="list-icon">{c.status === 'Escalated' ? <TriangleAlert aria-hidden="true" /> : <LifeBuoy aria-hidden="true" />}</span>
                    <div className="list-item-main">
                      <Link className="row-link" href={`/cases/${c.id}`}>Case {c.caseNumber}</Link>
                      <span className="cell-sub">
                        {[c.serviceType, c.subType].filter(Boolean).join(' · ') || c.subject || 'No type'} — {c.contactName || c.accountName || 'Unknown customer'}
                        {c.city ? `, ${c.city}` : ''}
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <Status value={c.status} />
                    <span className="cell-sub">{dateTime(c.createdDate)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty icon={ShieldCheck} title="No open cases" />}
        </Card>
      </div>

      <div className="promise-strip">
        <Link className="promise" href="/voice-agent"><Mic aria-hidden="true" /><span><strong>AI voice agent</strong><span>Test a call from the button at the bottom right</span></span></Link>
        <Link className="promise" href="/requests"><CalendarClock aria-hidden="true" /><span><strong>{number(counts.scheduledCalls)} scheduled calls</strong><span>Delivery follow-ups and case updates</span></span></Link>
        <Link className="promise" href="/voice-agent#coverage"><MapPin aria-hidden="true" /><span><strong>Service coverage</strong><span>Delhi NCR by our team, the rest by partners</span></span></Link>
        <Link className="promise" href="/activity?kind=call"><PhoneCall aria-hidden="true" /><span><strong>Call log</strong><span>Every voice agent call, saved in Salesforce</span></span></Link>      </div>
    </>
  );
}
