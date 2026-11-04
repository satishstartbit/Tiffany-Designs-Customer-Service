import Link from 'next/link';
import { Card } from '@/components/ui.js';

// One labelled control; shows the server's message under the field it is about.
function Field({ name, label, hint, error, children, wide = false }) {
  return (
    <div className={wide ? 'field wide' : 'field'}>
      <label htmlFor={`customer-${name}`}>{label}</label>
      {children}
      {error ? <span className="field-error" id={`customer-${name}-error`}>{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// The customer details staff can edit, for the customer's own edit form and the order edit form. `customer` is the
// edit data from the Node server (values, options, maxLengths, required); `values` what the form shows; `error` the
// last refused save ({ field, message }). `prefix` names the inputs: customer. on the order form, which has fields of
// the same names.
export default function CustomerFields({
  customer, values, error, prefix = '', title = 'Customer', addressTitle = 'Address', link = false, notes = true,
}) {
  const { options, maxLengths, required } = customer;
  const errorFor = (key) => (error?.field === key ? error.message : null);
  const control = (key) => ({
    id: `customer-${key}`,
    name: `${prefix}${key}`,
    defaultValue: values[key] ?? '',
    required: required.includes(key),
    maxLength: maxLengths[key],
    autoComplete: 'off',
    'aria-invalid': error?.field === key || undefined,
    'aria-describedby': error?.field === key ? `customer-${key}-error` : undefined,
  });
  const input = (key, type = 'text', className = 'input') => <input className={className} type={type} {...control(key)} />;

  return (
    <>
      <Card title={title} action={link && <Link className="btn btn-ghost" href={`/customers/${customer.id}`}>Open customer</Link>}>
        <div className="form-grid four">
          <Field name="firstName" label="First name" error={errorFor('firstName')}>{input('firstName')}</Field>
          <Field name="lastName" label="Last name" error={errorFor('lastName')}>{input('lastName')}</Field>
          <Field name="mobile" label="Mobile" hint="The voice agent finds the customer by this number." error={errorFor('mobile')}>
            {input('mobile', 'tel', 'input mono')}
          </Field>
          <Field name="email" label="Email" error={errorFor('email')}>{input('email', 'email')}</Field>
          <Field name="phone" label="Phone" error={errorFor('phone')}>{input('phone', 'tel', 'input mono')}</Field>
          <Field name="otherPhone" label="Other phone" error={errorFor('otherPhone')}>{input('otherPhone', 'tel', 'input mono')}</Field>
          <Field name="languages" label="Language" hint="For example Hindi." error={errorFor('languages')}>{input('languages')}</Field>
        </div>
      </Card>

      <Card title={addressTitle}>
        <div className="form-grid four">
          <Field name="mailingStreet" label="Street address" wide error={errorFor('mailingStreet')}>{input('mailingStreet')}</Field>
          <Field name="mailingCity" label="City" error={errorFor('mailingCity')}>{input('mailingCity')}</Field>
          <Field name="mailingState" label="State" error={errorFor('mailingState')}>
            <select className="select" {...control('mailingState')} maxLength={undefined}>
              <option value="">Not set</option>
              {options.states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field name="mailingPostalCode" label="PIN code" error={errorFor('mailingPostalCode')}>
            <input className="input mono" type="text" inputMode="numeric" pattern="[1-9][0-9]{5}" {...control('mailingPostalCode')} maxLength={6} />
          </Field>
        </div>
      </Card>

      {notes && (
        <Card title="Notes">
          <Field name="description" label="Notes about the customer" wide error={errorFor('description')}>
            <textarea className="input textarea" rows={5} {...control('description')} />
          </Field>
        </Card>
      )}
    </>
  );
}
