import Link from 'next/link';
import {
  CalendarClock, ClipboardList, Clock, LifeBuoy, MapPin, PackageCheck, PhoneCall, Search, ShoppingBag, UserPlus, Wrench,
} from 'lucide-react';
import { Badge, Card, Fields, PageHeader, Problem } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { AGENT, AGENT_NAME } from '@/lib/agent.js';
import { dateTime, minutesOfDay, time } from '@/lib/format.js';

export const metadata = { title: 'AI voice agent' };

const SKILLS = [
  [Search, 'Finds the caller', 'By mobile number, or by full name with an order, invoice or request number, or a PIN code.'],
  [PackageCheck, 'Order status', 'Delivery status and dates for an order id, order number or invoice.'],
  [ShoppingBag, 'Products and orders', 'Searches the catalogue, quotes list prices and places phone orders as drafts.'],
  [LifeBuoy, 'Service requests', 'Registers installation, damage, replacement and general requests as cases.'],
  [Wrench, 'Parts and installation', 'Finds spare parts by product and books installation visits.'],
  [ClipboardList, 'Request status', 'Reads back a case, its technician visit and any replacement shipment.'],
  [PhoneCall, 'Call backs', 'Arranges a call back from the service team.'],
  [UserPlus, 'Customer details', 'Saves new customers; details for known customers go to the team to confirm.'],
  [MapPin, 'Service area', 'Tells whether our team or a service partner covers a city or PIN code.'],
  [Clock, 'Service hours', 'Knows whether support is open and when it opens next.'],
  [CalendarClock, 'Dates', 'Works out dates like next Monday without guessing.'],
];

export default async function VoiceAgentPage() {
  const { data, error } = await loadAdmin('service');
  const cities = data?.regions.filter((r) => r.type === 'City') || [];
  const prefixes = data?.regions.filter((r) => r.type === 'PIN Prefix') || [];
  const hours = data?.hours;

  return (
    <>
      <PageHeader
        eyebrow={AGENT_NAME}
        title="AI voice agent"
        description={`The ${AGENT_NAME} is the customer service voice agent. It works on the same Salesforce data as this console: what it creates on a call shows up here. Customers talk to it on the public customer care page, which needs no sign-in; open it to try a call.`}
        actions={<Link className="btn" href="/support" target="_blank">Open customer care page</Link>}
      />

      <div className="grid grid-main">
        <Card title="What the agent can do" flush>
          <div className="list">
            {SKILLS.map(([Icon, title, text]) => (
              <div className="list-item" key={title}>
                <div className="item-row">
                  <span className="list-icon"><Icon aria-hidden="true" /></span>
                  <div><strong style={{ fontWeight: 500 }}>{title}</strong><span className="cell-sub">{text}</span></div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Agent">
            <Fields one items={[
              ['Name', AGENT_NAME],
              ['Agent id', <span key="a" className="mono">{AGENT.appId}</span>],
              ['Customer page', <Link key="s" className="row-link" href="/support" target="_blank">/support</Link>],
              ['Web calls', 'Through this site; the voice service key stays on the server'],
              ['Limits', '5 calls per visitor every 10 minutes, 20 a day'],
            ]} />
          </Card>

          {error ? <Problem message={error} /> : (
            <Card title="Service hours">
              {hours?.configured ? (
                <>
                  <p style={{ marginTop: 0 }}>
                    {hours.open
                      ? <Badge tone="green">Open now · closes {time(hours.closesAt)}</Badge>
                      : <Badge tone="grey">Closed{hours.holidayName ? ` for ${hours.holidayName}` : ''} · opens {dateTime(hours.opensAt)}</Badge>}
                  </p>
                  <div className="week">
                    {hours.weekly.map((d) => (
                      <div className="week-row" key={d.day}>
                        <span>{d.day}</span>
                        <span className={d.window ? '' : 'muted'}>{d.window ? `${minutesOfDay(d.window.start)} – ${minutesOfDay(d.window.end)}` : 'Closed'}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p className="muted">Business hours are not set in Salesforce.</p>}
            </Card>
          )}
        </div>
      </div>

      {data && (
        <section className="section" id="coverage">
          <Card title="Service coverage">
            <p className="muted" style={{ marginTop: 0 }}>
              Requests from these places go to our own team (Delhi NCR); everywhere else goes to a service partner. Set in Salesforce (Service Region).
            </p>
            <div className="grid grid-2">
              <div>
                <div className="stat-label" style={{ marginBottom: 10 }}>Cities</div>
                <div className="chips">{cities.length ? cities.map((r) => <span className="tag" key={r.value}>{r.value}</span>) : <span className="muted">None</span>}</div>
              </div>
              <div>
                <div className="stat-label" style={{ marginBottom: 10 }}>PIN codes starting with</div>
                <div className="chips">{prefixes.length ? prefixes.map((r) => <span className="tag mono" key={r.value}>{r.value}…</span>) : <span className="muted">None</span>}</div>
              </div>
            </div>
          </Card>
        </section>
      )}
    </>
  );
}
