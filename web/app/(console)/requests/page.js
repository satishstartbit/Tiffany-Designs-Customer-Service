import Link from 'next/link';
import { CalendarClock, PhoneCall } from 'lucide-react';
import ActivityList from '@/components/ActivityList.js';
import CaseTable from '@/components/CaseTable.js';
import { Card, Empty, PageHeader, Problem, Status } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { dateTime } from '@/lib/format.js';

export const metadata = { title: 'Requests' };

const JOB_TYPES = {
  delivery_followup: 'Delivery follow-up call',
  service_update: 'Case update call',
};

export default async function RequestsPage() {
  const { data, error } = await loadAdmin('requests');

  return (
    <>
      <PageHeader
        eyebrow="Service"
        title="Requests"
        description="What is waiting on the team: customers who asked for a call back, calls the server will place, and to-dos such as customer details to confirm."
      />
      {error ? <Problem message={error} /> : (
        <div className="grid">
          <Card title={`Call-back requests (${data.callbacks.length})`} action={<Link className="btn btn-ghost" href="/cases?status=Escalated">All escalated</Link>} flush>
            {data.callbacks.length
              ? <CaseTable cases={data.callbacks} />
              : <Empty icon={PhoneCall} title="No one is waiting for a call back" />}
          </Card>

          <Card title={`Scheduled calls (${data.scheduledCalls.length})`} flush>
            {data.scheduledCalls.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Call</th><th>Customer</th><th>About</th><th>When</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.scheduledCalls.map((j) => (
                      <tr key={j.id}>
                        <td>{JOB_TYPES[j.type] || j.type}<span className="cell-sub">{j.attempts ? `${j.attempts} ${j.attempts === 1 ? 'attempt' : 'attempts'}` : 'Not tried yet'}</span></td>
                        <td>{j.customerName || '—'}</td>
                        <td>
                          {j.caseId ? <Link className="row-link" href={`/cases/${j.caseId}`}>{j.reference}</Link>
                            : j.orderId ? <Link className="row-link" href={`/orders/${j.orderId}`}>{j.reference}</Link>
                              : j.reference || '—'}
                        </td>
                        <td>{dateTime(j.completedAt || j.runAt)}</td>
                        <td>
                          <Status value={j.status} />
                          {j.lastError && <span className="cell-sub" title={j.lastError}>{j.lastError.slice(0, 80)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon={CalendarClock} title="No scheduled calls">
                Delivery follow-ups and case updates appear here when the server schedules them.
              </Empty>
            )}
          </Card>

          <Card title={`To-dos (${data.todos.length})`} flush>
            <ActivityList activities={data.todos} empty="No open to-dos" />
          </Card>
        </div>
      )}
    </>
  );
}
