import Link from 'next/link';
import { Status } from './ui.js';
import { date, money } from '@/lib/format.js';

export default function OrderTable({ orders }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Order</th><th>Products</th><th>Status</th><th>Delivery</th><th className="num">Total</th></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="nowrap">
                <Link className="row-link" href={`/orders/${o.id}`}>{o.erpOrderId || `#${o.orderNumber}`}</Link>
                <span className="cell-sub">{date(o.orderDate)}{o.source ? ` · ${o.source}` : ''}</span>
              </td>
              <td>{o.products.slice(0, 2).join(', ') || '—'}<span className="cell-sub">{o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}</span></td>
              <td><Status value={o.status} /></td>
              <td><Status value={o.deliveryStatus} fallback="Not shipped" /></td>
              <td className="num price">{money(o.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
