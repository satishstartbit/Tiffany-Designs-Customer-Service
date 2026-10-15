import { notFound } from 'next/navigation';
import { LifeBuoy, Package } from 'lucide-react';
import ActivityList from '@/components/ActivityList.js';
import CaseTable from '@/components/CaseTable.js';
import OrderTable from '@/components/OrderTable.js';
import { Card, Empty, Fields, PageHeader, Problem, Stat } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money, number } from '@/lib/format.js';

export const metadata = { title: 'Customer' };

export default async function CustomerPage({ params }) {
  const { id } = await params;
  const { data: c, error } = await loadAdmin(`customers/${encodeURIComponent(id)}`);
  if (error) return <Problem message={error} />;
  if (!c) notFound();
  const spent = c.orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const open = c.cases.filter((k) => !k.closed).length;

  return (
    <>
      <PageHeader
        back={{ href: '/customers', label: 'Customers' }}
        eyebrow="Customer"
        title={c.name}
        description={[c.accountName !== c.name ? c.accountName : null, c.city, `customer since ${date(c.createdDate)}`].filter(Boolean).join(' · ')}
      />
      <div className="stats" style={{ marginTop: 0 }}>
        <Stat icon={Package} label="Orders" value={number(c.orders.length)} hint={money(spent)} />
        <Stat icon={LifeBuoy} label="Cases" value={number(c.cases.length)} hint={`${open} open`} />
      </div>

      <div className="grid grid-main section">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Orders" flush>
            {c.orders.length ? <OrderTable orders={c.orders} /> : <Empty icon={Package} title="No orders" />}
          </Card>
          <Card title="Cases" flush>
            {c.cases.length ? <CaseTable cases={c.cases} showCustomer={false} /> : <Empty icon={LifeBuoy} title="No cases" />}
          </Card>
          <Card title="Calls and emails" flush>
            <ActivityList activities={c.activities} empty="No calls or emails with this customer" />
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Contact details">
            <Fields one items={[
              ['Mobile', c.mobile ? <a className="mono" href={`tel:${c.mobile}`}>{c.mobile}</a> : null],
              ['Phone', c.phone],
              ['Other phone', c.otherPhone],
              ['Email', c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null],
              ['Address', c.address],
              ['Languages', c.languages],
              ['Account', c.accountName],
            ]} />
          </Card>
          {c.description && <Card title="Notes"><p className="description">{c.description}</p></Card>}
        </div>
      </div>
    </>
  );
}
