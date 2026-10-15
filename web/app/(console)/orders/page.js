import Link from 'next/link';
import { Package } from 'lucide-react';
import { Card, Empty, Filters, PageHeader, Pagination, Problem, Status, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money } from '@/lib/format.js';

export const metadata = { title: 'Orders' };

const FILTERS = ['q', 'status', 'delivery', 'source', 'page'];

export default async function OrdersPage({ searchParams }) {
  const params = readParams(await searchParams, FILTERS);
  const { data, error } = await loadAdmin('orders', params);

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Orders"
        description="Every order in Salesforce, newest first. Phone orders from the voice agent arrive as drafts for the sales team to confirm."
      />
      {error ? <Problem message={error} /> : (
        <>
          <Filters
            action="/orders"
            search="Order id, order number, invoice or customer"
            params={params}
            selects={[
              { name: 'status', label: 'Status', options: data.filters.statuses },
              { name: 'delivery', label: 'Delivery', options: data.filters.deliveryStatuses },
              { name: 'source', label: 'Channel', options: data.filters.sources },
            ]}
          />
          <Card flush>
            {data.records.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th><th>Customer</th><th>Products</th><th>Channel</th><th>Status</th><th>Delivery</th><th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map((o) => (
                      <tr key={o.id}>
                        <td className="nowrap">
                          <Link className="row-link" href={`/orders/${o.id}`}>{o.erpOrderId || `#${o.orderNumber}`}</Link>
                          <span className="cell-sub">{o.erpOrderId ? `#${o.orderNumber} · ` : ''}{date(o.orderDate)}</span>
                        </td>
                        <td>
                          {o.customerName || '—'}
                          <span className="cell-sub">{[o.city, o.postalCode].filter(Boolean).join(' ') || 'No delivery city'}</span>
                        </td>
                        <td>
                          {o.products.length ? o.products.slice(0, 2).join(', ') : '—'}
                          <span className="cell-sub">{o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}{o.products.length > 2 ? ` · +${o.products.length - 2} more` : ''}</span>
                        </td>
                        <td>{o.source ? <span className="tag">{o.source}</span> : '—'}</td>
                        <td><Status value={o.status} /></td>
                        <td><Status value={o.deliveryStatus} fallback="Not shipped" /></td>
                        <td className="num price">{money(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={Package} title="No orders match">Change the filters or search for another order.</Empty>}
            <Pagination basePath="/orders" params={params} page={data.page} hasMore={data.hasMore} shown={data.records.length} />
          </Card>
        </>
      )}
    </>
  );
}
