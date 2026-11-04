// The customer details the console edits (CUSTOMER_EDITS in src/crm/customers.js), read from a form whose inputs are
// named `${prefix}${field}`. Only the fields the form has are sent, so a form that leaves one out never clears it.
export const CUSTOMER_FIELDS = [
  'firstName', 'lastName', 'mobile', 'phone', 'otherPhone', 'email',
  'mailingStreet', 'mailingCity', 'mailingState', 'mailingPostalCode', 'languages', 'description',
];

export function readCustomerFields(formData, prefix = '') {
  return Object.fromEntries(
    CUSTOMER_FIELDS.filter((name) => formData.has(`${prefix}${name}`)).map((name) => [name, String(formData.get(`${prefix}${name}`))]),
  );
}
