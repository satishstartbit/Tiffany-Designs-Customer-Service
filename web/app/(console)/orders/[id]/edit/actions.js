'use server';

import { redirect } from 'next/navigation';
import { sendAdmin } from '@/lib/api.js';
import { readCustomerFields } from '@/lib/customerFields.js';

// A "use server" file may export only async functions, so the field list stays private.
const ORDER_FIELDS = [
  'status', 'deliveryStatus', 'deliveryDate', 'erpOrderId', 'invoiceNumber', 'source', 'fulfilment', 'orderDate', 'description',
  'shippingStreet', 'shippingCity', 'shippingState', 'shippingPostalCode',
];

// Sends the whole form, with the customer's details when the order has a customer; the Node server checks both, saves
// only what changed and notes it in the order's and the customer's history.
export async function saveOrder(orderId, previous, formData) {
  const values = Object.fromEntries(ORDER_FIELDS.map((name) => [name, String(formData.get(name) ?? '')]));
  const customer = readCustomerFields(formData, 'customer.');
  const body = Object.keys(customer).length ? { ...values, customer } : values;
  const { data, error, field } = await sendAdmin(`orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', body });
  if (error) return { error, field, values, customer };
  redirect(`/orders/${encodeURIComponent(orderId)}?saved=${data.updated ? data.changes.length : 0}`);
}
