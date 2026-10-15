'use server';

import { redirect } from 'next/navigation';
import { sendAdmin } from '@/lib/api.js';

// A "use server" file may export only async functions, so the field list stays private.
const ORDER_FIELDS = [
  'status', 'deliveryStatus', 'deliveryDate', 'erpOrderId', 'invoiceNumber', 'source', 'fulfilment', 'orderDate', 'description',
  'shippingStreet', 'shippingCity', 'shippingState', 'shippingPostalCode',
];

// Sends the whole form; the Node server saves only what changed and notes it in the order's history.
export async function saveOrder(orderId, previous, formData) {
  const values = Object.fromEntries(ORDER_FIELDS.map((name) => [name, String(formData.get(name) ?? '')]));
  const { data, error, field } = await sendAdmin(`orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', body: values });
  if (error) return { error, field, values };
  redirect(`/orders/${encodeURIComponent(orderId)}?saved=${data.updated ? data.changes.length : 0}`);
}
