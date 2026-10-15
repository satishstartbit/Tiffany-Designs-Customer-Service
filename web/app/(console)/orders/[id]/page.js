import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CircleCheck, LifeBuoy, Mail, Pencil, Phone, User } from 'lucide-react';
import ActivityList from '@/components/ActivityList.js';
import CaseTable from '@/components/CaseTable.js';
import { Card, Empty, Fields, PageHeader, Problem, Status, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money } from '@/lib/format.js';

export const metadata = { title: 'Order' };

export default async function OrderPage({ params, searchParams }) {
  const { id } = await params;
  const { saved } = readParams(await searchParams, ['saved']);
  const { data: o, error } = await loadAdmin(`orders/${encodeURIComponent(id)}`);
  if (error) return <Problem message={error} />;
  if (!o) notFound();
  const savedCount = Number(saved);

  return (
    <>
      <PageHeader
        back={{ href: '/orders', label: 'Orders' }}
        eyebrow={o.erpOrderId ? `Order #${o.orderNumber}` : 'Order'}
        title={o.erpOrderId || `#${o.orderNumber}`}
        description={`Placed ${date(o.orderDate)}${o.source ? ` on ${o.source}` : ''} by ${o.customerName || 'an unknown customer'}.`}
        actions={(
          <>
            <Status value={o.status} />
            <Status value={o.deliveryStatus} fallback="Not shipped" />
            <Link className="btn" href={`/orders/${o.id}/edit`}><Pencil aria-hidden="true" /> Edit order</Link>
          </>
        )}
      />
      {saved !== '' && (
        <div className="notice" role="status">
          <CircleCheck aria-hidden="true" />
          {savedCount > 0
            ? `Saved ${savedCount} ${savedCount === 1 ? 'change' : 'changes'} to Salesforce. They are noted in the history below.`
            : 'Nothing was changed.'}
        </div>
      )}

      <div className="grid grid-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Items" flush>
            {o.items.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {o.items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.productId ? <Link className="row-link" href={`/products/${i.productId}`}>{i.name}</Link> : i.name}
                          <span className="cell-sub mono">{i.code}</span>
                        </td>
                        <td className="num">{i.quantity}</td>
                        <td className="num">{money(i.unitPrice)}</td>
                        <td className="num price">{money(i.total)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={3} className="num"><strong>Order total</strong></td>
                      <td className="num price"><strong>{money(o.total)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : <Empty title="No items on this order" />}
          </Card>

          {o.description && <Card title="Notes"><p className="description">{o.description}</p></Card>}

          <Card title={`Service cases (${o.cases.length})`} flush>
            {o.cases.length ? <CaseTable cases={o.cases} /> : <Empty icon={LifeBuoy} title="No cases for this order" />}
          </Card>

          <Card title="History: calls, emails and edits" flush>
            <ActivityList activities={o.activities} empty="No calls, emails or edits for this order yet" />
          </Card>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Customer">
            {o.contact ? (
              <div className="grid" style={{ gap: 12 }}>
                <div className="item-row">
                  <span className="list-icon"><User aria-hidden="true" /></span>
                  <div>
                    <Link className="row-link" href={`/customers/${o.contact.id}`}>{o.contact.name}</Link>
                    {o.customerName && o.customerName !== o.contact.name && <span className="cell-sub">{o.customerName}</span>}
                  </div>
                </div>
                {(o.contact.mobile || o.contact.phone) && (
                  <a className="item-row" href={`tel:${o.contact.mobile || o.contact.phone}`}>
                    <span className="list-icon"><Phone aria-hidden="true" /></span><span className="mono">{o.contact.mobile || o.contact.phone}</span>
                  </a>
                )}
                {o.contact.email && (
                  <a className="item-row" href={`mailto:${o.contact.email}`}>
                    <span className="list-icon"><Mail aria-hidden="true" /></span><span>{o.contact.email}</span>
                  </a>
                )}
              </div>
            ) : <Fields one items={[['Account', o.customerName]]} />}
          </Card>

          <Card title="Delivery">
            <Fields one items={[
              ['Delivery status', <Status key="d" value={o.deliveryStatus} fallback="Not shipped" />],
              o.deliveryDate && ['Delivered on', date(o.deliveryDate)],
              ['Ship to', o.shippingAddress],
              ['Fulfilment', o.fulfilment],
            ]} />
          </Card>

          <Card title="Order details">
            <Fields items={[
              ['Order id', o.erpOrderId],
              ['Order number', o.orderNumber],
              ['Invoice', o.invoiceNumber],
              ['Channel', o.source],
              ['Order date', date(o.orderDate)],
              ['Created', date(o.createdDate)],
              ['Bill to', o.billingAddress],
            ]} />
          </Card>
        </div>
      </div>
    </>
  );
}
