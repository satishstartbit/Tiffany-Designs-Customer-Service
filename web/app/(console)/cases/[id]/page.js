import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Mail, Phone, Truck, User, Wrench } from 'lucide-react';
import ActivityList from '@/components/ActivityList.js';
import { Badge, Card, Empty, Fields, PageHeader, Problem, Status } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, dateTime } from '@/lib/format.js';

export const metadata = { title: 'Case' };

export default async function CasePage({ params }) {
  const { id } = await params;
  const { data: c, error } = await loadAdmin(`cases/${encodeURIComponent(id)}`);
  if (error) return <Problem message={error} />;
  if (!c) notFound();

  return (
    <>
      <PageHeader
        back={{ href: '/cases', label: 'Cases' }}
        eyebrow={[c.serviceType, c.subType].filter(Boolean).join(' · ') || 'Case'}
        title={`Case ${c.caseNumber}`}
        description={c.subject || undefined}
        actions={<>{c.priority && <Status value={c.priority} />}<Status value={c.status} /></>}
      />

      <div className="grid grid-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="What the customer reported">
            <p className="description">{c.description || 'No description.'}</p>
          </Card>

          <Card title="Technician visits" flush>
            {c.visits.length ? (
              <div className="list">
                {c.visits.map((v) => (
                  <div className="list-item" key={v.id}>
                    <div className="item-row">
                      <span className="list-icon"><Wrench aria-hidden="true" /></span>
                      <div>
                        <strong style={{ fontWeight: 500 }}>{v.scheduledStart ? dateTime(v.scheduledStart) : 'Not scheduled yet'}</strong>
                        <span className="cell-sub">{v.technician ? `Technician: ${v.technician}` : 'No technician assigned'}{v.remarks ? ` · ${v.remarks}` : ''}</span>
                      </div>
                    </div>
                    <Status value={v.status} />
                  </div>
                ))}
              </div>
            ) : <Empty icon={Wrench} title="No visits booked" />}
          </Card>

          <Card title="Replacement shipments" flush>
            {c.shipments.length ? (
              <div className="list">
                {c.shipments.map((s) => (
                  <div className="list-item" key={s.id}>
                    <div className="item-row">
                      <span className="list-icon"><Truck aria-hidden="true" /></span>
                      <div>
                        <strong style={{ fontWeight: 500 }}>{s.component || s.name}{s.quantity ? ` × ${s.quantity}` : ''}</strong>
                        <span className="cell-sub">
                          {[s.courier, s.trackingNumber].filter(Boolean).join(' · ') || 'No courier yet'}
                          {s.expectedDate ? ` · expected ${date(s.expectedDate)}` : ''}
                        </span>
                        {s.trackingUrl && <a className="btn btn-ghost" href={s.trackingUrl} target="_blank" rel="noreferrer">Track</a>}
                      </div>
                    </div>
                    <Status value={s.status} />
                  </div>
                ))}
              </div>
            ) : <Empty icon={Truck} title="No replacement parts sent" />}
          </Card>

          <Card title="Calls and emails" flush>
            <ActivityList activities={c.activities} empty="No calls or emails linked to this case" />
          </Card>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Customer">
            <div className="grid" style={{ gap: 12 }}>
              <div className="item-row">
                <span className="list-icon"><User aria-hidden="true" /></span>
                <div>
                  {c.contactId ? <Link className="row-link" href={`/customers/${c.contactId}`}>{c.contactName || 'Contact'}</Link> : <strong>{c.accountName || 'Unknown'}</strong>}
                  {c.accountName && c.accountName !== c.contactName && <span className="cell-sub">{c.accountName}</span>}
                </div>
              </div>
              {c.mobile && <a className="item-row" href={`tel:${c.mobile}`}><span className="list-icon"><Phone aria-hidden="true" /></span><span className="mono">{c.mobile}</span></a>}
              {c.email && <a className="item-row" href={`mailto:${c.email}`}><span className="list-icon"><Mail aria-hidden="true" /></span><span>{c.email}</span></a>}
            </div>
          </Card>

          <Card title="Service">
            <Fields one items={[
              ['Handled by', c.route ? <Badge key="r" tone={c.route === 'Internal' ? 'teal' : 'maroon'}>{c.route === 'Internal' ? 'Our team (Delhi NCR)' : 'Service partner'}</Badge> : null],
              ['Location', [c.city, c.state, c.postalCode].filter(Boolean).join(', ')],
              ['Technician', c.technician],
              ['Service partner', c.serviceProvider],
              ['Part', c.component ? `${c.component.name}${c.component.partNumber ? ` (${c.component.partNumber})` : ''}` : null],
            ]} />
          </Card>

          <Card title="Case details">
            <Fields items={[
              ['Channel', c.origin],
              ['Opened', dateTime(c.createdDate)],
              ['Closed', c.closedDate ? dateTime(c.closedDate) : null],
              ['Order', c.orderId ? <Link key="o" className="row-link" href={`/orders/${c.orderId}`}>{c.orderReference || 'Order'}</Link> : null],
              ['Invoice', c.invoiceNumber],
              ['Sold on', c.orderSource],
            ]} />
          </Card>
        </div>
      </div>
    </>
  );
}
