import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CircleCheck, LifeBuoy, Package, Pencil } from 'lucide-react';
import ActivityList from '@/components/ActivityList.js';
import CaseTable from '@/components/CaseTable.js';
import OrderTable from '@/components/OrderTable.js';
import { Card, Empty, Fields, PageHeader, Problem, Stat, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money, number } from '@/lib/format.js';

export const metadata = { title: 'Customer' };

export default async function CustomerPage({ params, searchParams }) {
  const { id } = await params;
  const { saved } = readParams(await searchParams, ['saved']);
  const { data: c, error } = await loadAdmin(`customers/${encodeURIComponent(id)}`);
  if (error) return <Problem message={error} />;
  if (!c) notFound();
  const spent = c.orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const open = c.cases.filter((k) => !k.closed).length;
  const savedCount = Number(saved);

  return (
    <>
      <PageHeader
        back={{ href: '/customers', label: 'Customers' }}
        eyebrow="Customer"
        title={c.name}
        description={[c.accountName !== c.name ? c.accountName : null, c.city, `customer since ${date(c.createdDate)}`].filter(Boolean).join(' · ')}
        actions={<Link className="btn" href={`/customers/${c.id}/edit`}><Pencil aria-hidden="true" /> Edit customer</Link>}
      />
      {saved !== '' && (
        <div className="notice" role="status">
          <CircleCheck aria-hidden="true" />
          {savedCount > 0
            ? `Saved ${savedCount} ${savedCount === 1 ? 'change' : 'changes'} to Salesforce. They are noted in the history below.`
            : 'Nothing was changed.'}
        </div>
      )}
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
          <Card title="History: calls, emails and edits" flush>
            <ActivityList activities={c.activities} empty="No calls, emails or edits for this customer yet" />
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
