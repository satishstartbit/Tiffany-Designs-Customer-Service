'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Save } from 'lucide-react';
import CustomerFields from '@/components/CustomerFields.js';
import { Problem } from '@/components/ui.js';
import { saveCustomer } from './actions.js';

export default function CustomerEditForm({ customer }) {
  const [state, action, pending] = useActionState(saveCustomer.bind(null, customer.id), null);
  // After a refused save the form keeps what was typed; React resets the fields to these values.
  const values = state?.values || Object.fromEntries(Object.entries(customer.values).map(([k, v]) => [k, v ?? '']));

  return (
    <form action={action} className="grid">
      {state?.error && <Problem title="Not saved" message={state.error} />}
      <CustomerFields
        customer={customer}
        values={values}
        error={state?.field ? { field: state.field, message: state.error } : null}
        title="Name and numbers"
      />
      <div className="form-actions">
        <button className="btn" type="submit" disabled={pending}>
          <Save aria-hidden="true" /> {pending ? 'Saving…' : 'Save changes'}
        </button>
        <Link className="btn btn-outline" href={`/customers/${customer.id}`}>Cancel</Link>
      </div>
    </form>
  );
}
