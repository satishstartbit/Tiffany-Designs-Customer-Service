'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Save } from 'lucide-react';
import { Card, Problem } from '@/components/ui.js';
import { saveOrder } from './actions.js';

// One labelled control; shows the server's message under the field it is about.
function Field({ name, label, hint, error, children, wide = false }) {
  return (
    <div className={wide ? 'field wide' : 'field'}>
      <label htmlFor={`order-${name}`}>{label}</label>
      {children}
      {error ? <span className="field-error" id={`order-${name}-error`}>{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export default function OrderEditForm({ order }) {
  const [state, action, pending] = useActionState(saveOrder.bind(null, order.id), null);
  // After a refused save the form keeps what was typed; React resets the fields to these values.
  const values = state?.values || Object.fromEntries(Object.entries(order.values).map(([k, v]) => [k, v ?? '']));
  const { options, maxLengths, required } = order;
  const errorFor = (name) => (state?.field === name ? state.error : null);
  const control = (name) => ({
    id: `order-${name}`,
    name,
    defaultValue: values[name] ?? '',
    required: required.includes(name),
    'aria-invalid': state?.field === name || undefined,
    'aria-describedby': state?.field === name ? `order-${name}-error` : undefined,
  });
  const select = (name, choices, emptyLabel) => (
    <select className="select" {...control(name)}>
      {!required.includes(name) && <option value="">{emptyLabel}</option>}
      {choices.map((c) => {
        const [value, label] = typeof c === 'string' ? [c, c] : [c.value, c.label];
        return <option key={value} value={value}>{label}</option>;
      })}
    </select>
  );

  return (
    <form action={action} className="grid">
      {state?.error && <Problem title="Not saved" message={state.error} />}

      <div className="grid grid-2">
        <Card title="Status and delivery">
          <div className="form-grid">
            <Field name="status" label="Order status" hint="Activating needs at least one product on the order." error={errorFor('status')}>
              {select('status', options.statuses)}
            </Field>
            <Field name="deliveryStatus" label="Delivery status" error={errorFor('deliveryStatus')}>
              {select('deliveryStatus', options.deliveryStatuses, 'Not shipped yet')}
            </Field>
            <Field name="deliveryDate" label="Delivered on" error={errorFor('deliveryDate')}>
              <input className="input" type="date" {...control('deliveryDate')} />
            </Field>
            <Field name="orderDate" label="Order date" error={errorFor('orderDate')}>
              <input className="input" type="date" {...control('orderDate')} />
            </Field>
          </div>
        </Card>

        <Card title="References">
          <div className="form-grid">
            <Field name="erpOrderId" label="Order id" hint="Unique, as on the invoice or marketplace (e.g. TD-ORD-1001)." error={errorFor('erpOrderId')}>
              <input className="input mono" type="text" maxLength={maxLengths.erpOrderId} autoComplete="off" {...control('erpOrderId')} />
            </Field>
            <Field name="invoiceNumber" label="Invoice number" error={errorFor('invoiceNumber')}>
              <input className="input mono" type="text" maxLength={maxLengths.invoiceNumber} autoComplete="off" {...control('invoiceNumber')} />
            </Field>
            <Field name="source" label="Channel" error={errorFor('source')}>
              {select('source', options.sources, 'Not set')}
            </Field>
            <Field name="fulfilment" label="Fulfilment" error={errorFor('fulfilment')}>
              {select('fulfilment', options.fulfilmentTypes, 'Not set')}
            </Field>
          </div>
        </Card>
      </div>

      <Card title="Ship to">
        <div className="form-grid four">
          <Field name="shippingStreet" label="Street address" wide error={errorFor('shippingStreet')}>
            <input className="input" type="text" maxLength={maxLengths.shippingStreet} autoComplete="off" {...control('shippingStreet')} />
          </Field>
          <Field name="shippingCity" label="City" error={errorFor('shippingCity')}>
            <input className="input" type="text" maxLength={maxLengths.shippingCity} autoComplete="off" {...control('shippingCity')} />
          </Field>
          <Field name="shippingState" label="State" error={errorFor('shippingState')}>
            {select('shippingState', options.states, 'Not set')}
          </Field>
          <Field name="shippingPostalCode" label="PIN code" error={errorFor('shippingPostalCode')}>
            <input className="input mono" type="text" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} autoComplete="off" {...control('shippingPostalCode')} />
          </Field>
        </div>
      </Card>

      <Card title="Notes">
        <Field name="description" label="Notes for the team" wide error={errorFor('description')}>
          <textarea className="input textarea" rows={6} maxLength={maxLengths.description} {...control('description')} />
        </Field>
      </Card>

      <div className="form-actions">
        <button className="btn" type="submit" disabled={pending}>
          <Save aria-hidden="true" /> {pending ? 'Saving…' : 'Save changes'}
        </button>
        <Link className="btn btn-outline" href={`/orders/${order.id}`}>Cancel</Link>
      </div>
    </form>
  );
}
