import Link from 'next/link';
import { Boxes, LifeBuoy, Package, Search, Users } from 'lucide-react';
import CaseTable from '@/components/CaseTable.js';
import OrderTable from '@/components/OrderTable.js';
import { Card, Empty, PageHeader, Problem, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { money } from '@/lib/format.js';

export const metadata = { title: 'Search' };

export default async function SearchPage({ searchParams }) {
  const { q } = readParams(await searchParams, ['q']);
  const text = q.trim();
  if (!text) {
    return (
      <>
        <PageHeader eyebrow="Search" title="Search the console" />
        <Card><Empty icon={Search} title="Type an order id, case number, customer name, mobile or product in the search bar above" /></Card>
      </>
    );
  }

  const [orders, cases, customers, products] = await Promise.all([
    loadAdmin('orders', { q: text, pageSize: 5 }),
    loadAdmin('cases', { q: text, pageSize: 5 }),
    loadAdmin('customers', { q: text, pageSize: 5 }),
    loadAdmin('products', { q: text }),
  ]);
  const problem = [orders, cases, customers, products].find((r) => r.error);
  if (problem) return <Problem message={problem.error} />;
  const total = orders.data.records.length + cases.data.records.length + customers.data.records.length + products.data.products.length;
  const more = (href, label) => <Link className="btn btn-ghost" href={href}>{label}</Link>;
  const query = encodeURIComponent(text);

  return (
    <>
      <PageHeader eyebrow="Search" title={`Results for “${text}”`} description={total ? undefined : 'Nothing matched. Try part of a name, an order id such as TD-ORD-1001, or a case number.'} />
      <div className="grid">
        {orders.data.records.length > 0 && (
          <Card title="Orders" action={more(`/orders?q=${query}`, 'All matching orders')} flush><OrderTable orders={orders.data.records} /></Card>
        )}
        {cases.data.records.length > 0 && (
          <Card title="Cases" action={more(`/cases?q=${query}`, 'All matching cases')} flush><CaseTable cases={cases.data.records} /></Card>
        )}
        {customers.data.records.length > 0 && (
          <Card title="Customers" action={more(`/customers?q=${query}`, 'All matching customers')} flush>
            <div className="list">
              {customers.data.records.map((c) => (
                <div className="list-item" key={c.id}>
                  <div className="item-row">
                    <span className="list-icon"><Users aria-hidden="true" /></span>
                    <div>
                      <Link className="row-link" href={`/customers/${c.id}`}>{c.name}</Link>
                      <span className="cell-sub">{[c.mobile || c.phone, c.email, c.city].filter(Boolean).join(' · ')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        {products.data.products.length > 0 && (
          <Card title="Products" action={more(`/products?q=${query}`, 'All matching products')} flush>
            <div className="list">
              {products.data.products.slice(0, 6).map((p) => (
                <div className="list-item" key={p.id}>
                  <div className="item-row">
                    <span className="list-icon"><Boxes aria-hidden="true" /></span>
                    <div><Link className="row-link" href={`/products/${p.id}`}>{p.name}</Link><span className="cell-sub mono">{p.code}</span></div>
                  </div>
                  <span className="price">{money(p.price)}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
        {!total && (
          <Card>
            <Empty icon={Search} title="No results">
              <span className="chips" style={{ justifyContent: 'center', marginTop: 8 }}>
                <Link className="tag" href="/orders"><Package size={13} aria-hidden="true" />&nbsp;Orders</Link>
                <Link className="tag" href="/cases"><LifeBuoy size={13} aria-hidden="true" />&nbsp;Cases</Link>
                <Link className="tag" href="/customers"><Users size={13} aria-hidden="true" />&nbsp;Customers</Link>
              </span>
            </Empty>
          </Card>
        )}
      </div>
    </>
  );
}
