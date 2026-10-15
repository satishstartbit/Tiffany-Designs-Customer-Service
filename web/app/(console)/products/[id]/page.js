import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Package, Wrench } from 'lucide-react';
import { CategoryIcon } from '@/components/icons.js';
import { Badge, Card, Empty, PageHeader, Problem, Stat, Status } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money, number } from '@/lib/format.js';

export const metadata = { title: 'Product' };

export default async function ProductPage({ params }) {
  const { id } = await params;
  const { data: p, error } = await loadAdmin(`products/${encodeURIComponent(id)}`);
  if (error) return <Problem message={error} />;
  if (!p) notFound();

  return (
    <>
      <PageHeader back={{ href: '/products', label: 'Products' }} eyebrow={p.category} title={p.name} />
      <div className="product-hero">
        <div className="product-image">
          {p.imageUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={p.imageUrl} alt={p.name} />
            : <CategoryIcon category={p.category} />}
        </div>
        <div>
          <div className="chips">
            <span className="tag mono">{p.code}</span>
            <Badge tone={p.active ? 'green' : 'grey'}>{p.active ? 'Active' : 'Inactive'}</Badge>
          </div>
          <div className="big-price">{money(p.price)}</div>
          <p className="description">{p.description || 'No description in Salesforce yet.'}</p>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <Stat icon={Package} label="Units ordered" value={number(p.unitsOrdered)} />
            <Stat icon={Package} label="Order lines" value={number(p.orderLines)} />
            <Stat icon={Wrench} label="Spare parts" value={number(p.parts.length)} />
          </div>
        </div>
      </div>

      <div className="grid grid-2 section">
        <Card title="Spare parts" flush>
          {p.parts.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Part</th><th>Part number</th></tr></thead>
                <tbody>
                  {p.parts.map((part) => (
                    <tr key={part.id}><td>{part.name}</td><td className="mono">{part.partNumber || '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Wrench} title="No parts listed">Parts are kept as Product Components in Salesforce.</Empty>}
        </Card>

        <Card title="Recent orders" flush>
          {p.recentOrders.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Order</th><th>Customer</th><th className="num">Qty</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {p.recentOrders.map((o) => (
                    <tr key={`${o.orderId}-${o.quantity}-${o.total}`}>
                      <td>
                        <Link className="row-link" href={`/orders/${o.orderId}`}>{o.erpOrderId || `#${o.orderNumber}`}</Link>
                        <span className="cell-sub">{date(o.orderDate)} · <Status value={o.status} /></span>
                      </td>
                      <td>{o.customerName || '—'}</td>
                      <td className="num">{o.quantity}</td>
                      <td className="num price">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Package} title="Not ordered yet" />}
        </Card>
      </div>
    </>
  );
}
