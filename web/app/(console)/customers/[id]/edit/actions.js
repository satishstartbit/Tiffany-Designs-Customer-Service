'use server';

import { redirect } from 'next/navigation';
import { sendAdmin } from '@/lib/api.js';
import { readCustomerFields } from '@/lib/customerFields.js';

// Sends the whole form; the Node server saves only what changed and notes it in the customer's history.
export async function saveCustomer(customerId, previous, formData) {
  const values = readCustomerFields(formData);
  const { data, error, field } = await sendAdmin(`customers/${encodeURIComponent(customerId)}`, { method: 'PATCH', body: values });
  if (error) return { error, field, values };
  redirect(`/customers/${encodeURIComponent(customerId)}?saved=${data.updated ? data.changes.length : 0}`);
}
