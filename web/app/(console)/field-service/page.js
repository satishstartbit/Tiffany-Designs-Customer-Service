import Link from 'next/link';
import { Truck, Wrench } from 'lucide-react';
import { Card, Empty, PageHeader, Problem, Status } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, dateTime } from '@/lib/format.js';

export const metadata = { title: 'Visits & shipments' };

export default async function FieldServicePage() {
  const { data, error } = await loadAdmin('field-service');

  return (
    <>
      <PageHeader
        eyebrow="Service"
        title="Visits & shipments"
        description="Technician visits for installations and repairs, and replacement parts on their way to customers."
      />
      {error ? <Problem message={error} /> : (
        <div className="grid">
          <Card title={`Technician visits (${data.visits.length})`} flush>
            {data.visits.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Visit</th><th>Case</th><th>Customer</th><th>Technician</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.visits.map((v) => (
                      <tr key={v.id}>
                        <td>{v.scheduledStart ? dateTime(v.scheduledStart) : 'Not scheduled'}<span className="cell-sub">{v.name}{v.city ? ` · ${v.city}` : ''}</span></td>
                        <td>{v.caseId ? <Link className="row-link" href={`/cases/${v.caseId}`}>{v.caseNumber}</Link> : '—'}</td>
                        <td>{v.customerName || '—'}</td>
                        <td>{v.technician || '—'}{v.remarks && <span className="cell-sub">{v.remarks}</span>}</td>
                        <td><Status value={v.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={Wrench} title="No technician visits" />}
          </Card>

          <Card title={`Replacement shipments (${data.shipments.length})`} flush>
            {data.shipments.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Part</th><th>Case</th><th>Courier</th><th>Dates</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.shipments.map((s) => (
                      <tr key={s.id}>
                        <td>{s.component || s.name}<span className="cell-sub mono">{s.partNumber || s.name}{s.quantity ? ` × ${s.quantity}` : ''}</span></td>
                        <td>{s.caseId ? <Link className="row-link" href={`/cases/${s.caseId}`}>{s.caseNumber}</Link> : '—'}<span className="cell-sub">{s.customerName}</span></td>
                        <td>
                          {s.courier || '—'}
                          {s.trackingNumber && <span className="cell-sub mono">{s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noreferrer">{s.trackingNumber}</a> : s.trackingNumber}</span>}
                        </td>
                        <td>
                          {s.dispatchDate ? `Sent ${date(s.dispatchDate)}` : 'Not sent'}
                          <span className="cell-sub">{s.deliveredDate ? `Delivered ${date(s.deliveredDate)}` : s.expectedDate ? `Expected ${date(s.expectedDate)}` : ''}</span>
                        </td>
                        <td><Status value={s.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={Truck} title="No replacement shipments" />}
          </Card>
        </div>
      )}
    </>
  );
}
