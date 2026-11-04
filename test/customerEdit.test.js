// Editing a customer from the staff console: src/crm/customers.js, PATCH /api/admin/customers/:id, and the customer
// details saved with an order (updateOrder with `customer`, src/crm/console.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomerEdits } = require('../src/crm/customers');
const { createConsoleData } = require('../src/crm/console');
const { startTestServer } = require('./helpers');

const CONTACT_ID = '003gK00001Ag2iJQAR';
const ACCOUNT_ID = '001gK00001kAAUZQA4';
const ORDER_ID = '801gK00001kAn4TQAS';

const CONTACT_DESCRIBE = {
  fields: [
    { name: 'FirstName', type: 'string', length: 40, nillable: true },
    { name: 'LastName', type: 'string', length: 80, nillable: false },
    { name: 'MobilePhone', type: 'phone', length: 40, nillable: true },
    { name: 'Phone', type: 'phone', length: 40, nillable: true },
    { name: 'OtherPhone', type: 'phone', length: 40, nillable: true },
    { name: 'Email', type: 'email', length: 80, nillable: true },
    { name: 'MailingStreet', type: 'textarea', length: 255, nillable: true },
    { name: 'MailingCity', type: 'string', length: 40, nillable: true },
    {
      name: 'MailingStateCode',
      type: 'picklist',
      nillable: true,
      picklistValues: [{ value: 'UP', label: 'Uttar Pradesh', active: true, validFor: 'gA==' }, { value: 'CA', label: 'California', active: true, validFor: 'AA==' }],
    },
    { name: 'MailingPostalCode', type: 'string', length: 20, nillable: true },
    { name: 'MailingCountryCode', type: 'picklist', nillable: true, picklistValues: [{ value: 'IN', active: true }] },
    { name: 'Languages__c', type: 'string', length: 100, nillable: true },
    { name: 'Description', type: 'textarea', length: 32000, nillable: true },
  ],
};

const ORDER_DESCRIBE = {
  fields: [
    { name: 'Status', type: 'picklist', nillable: false, picklistValues: [{ value: 'Draft', active: true }, { value: 'Activated', active: true }] },
    { name: 'ShippingCity', type: 'string', length: 40, nillable: true },
  ],
};

const CONTACT = {
  Id: CONTACT_ID,
  Name: 'Khitiz Ji',
  AccountId: ACCOUNT_ID,
  Account: { Name: 'Khitiz Ji' },
  MailingCountryCode: null,
  FirstName: 'Khitiz',
  LastName: 'Ji',
  MobilePhone: '+919897206000',
  Phone: null,
  OtherPhone: null,
  Email: null,
  MailingStreet: null,
  MailingCity: null,
  MailingStateCode: null,
  MailingPostalCode: null,
  Languages__c: null,
  Description: null,
};

// An order whose customer is linked only through its account, like order 00000162.
const ORDER = {
  Id: ORDER_ID,
  OrderNumber: '00000162',
  AccountId: ACCOUNT_ID,
  Account: { Name: 'Khitiz Ji' },
  CustomerAuthorizedById: null,
  ShippingCountryCode: null,
  Status: 'Draft',
  ShippingCity: 'Agra',
};

function fakeSalesforce({ contact = CONTACT, others = [], updateError } = {}) {
  const log = { queries: [], updates: [], creates: [] };
  return {
    log,
    async query(soql) {
      log.queries.push(soql);
      if (soql.includes('FROM Contact WHERE Id !=')) return others;
      if (soql.includes('FROM Contact WHERE Id =')) return contact ? [contact] : [];
      if (soql.includes('FROM Contact WHERE AccountId')) return [{ Id: CONTACT_ID, Name: 'Khitiz Ji', MobilePhone: '+919897206000' }];
      if (soql.includes('FROM Order WHERE Id')) return [ORDER];
      return [];
    },
    describe: async (sobject) => (sobject === 'Contact' ? CONTACT_DESCRIBE : ORDER_DESCRIBE),
    async update(sobject, id, fields) {
      if (updateError) throw updateError;
      log.updates.push({ sobject, id, fields });
      return null;
    },
    async create(sobject, fields) {
      log.creates.push({ sobject, fields });
      return { id: '00T000000000001' };
    },
  };
}

const options = (salesforce) => ({ salesforce, now: () => Date.parse('2026-11-04T06:30:00Z'), logger: { error() {} } });
const editor = (salesforce) => createCustomerEdits(options(salesforce));

test('the customer edit form gets the current values, Indian states and the org\'s limits', async () => {
  const form = await editor(fakeSalesforce()).getCustomerForEdit(CONTACT_ID);
  assert.equal(form.values.mobile, '+919897206000');
  assert.equal(form.values.firstName, 'Khitiz');
  assert.deepEqual(form.options.states, [{ value: 'UP', label: 'Uttar Pradesh' }]);
  assert.equal(form.maxLengths.email, 80);
  assert.deepEqual(form.required, ['firstName', 'lastName'], 'a first name already there is kept');

  const oneName = await editor(fakeSalesforce({ contact: { ...CONTACT, FirstName: null } })).getCustomerForEdit(CONTACT_ID);
  assert.deepEqual(oneName.required, ['lastName']);
  assert.equal(await editor(fakeSalesforce()).getCustomerForEdit("x' OR Id != '"), null);
});

test('customer details are checked before anything is saved', async () => {
  const salesforce = fakeSalesforce();
  const refused = (changes) => editor(salesforce).updateCustomer(CONTACT_ID, changes, { editedBy: 'admin@tiffanydesigns.in' });

  assert.deepEqual(await refused({ mobile: '12345' }), { error: 'invalid', field: 'mobile', message: 'Mobile must be a ten digit mobile number.' });
  assert.equal((await refused({ email: 'khitiz@' })).message, 'Email must be an email address.');
  assert.equal((await refused({ phone: 'call me' })).message, 'Phone must be a phone number.');
  assert.equal((await refused({ mailingPostalCode: '28200' })).message, 'PIN code must be a six digit PIN code.');
  assert.equal((await refused({ mailingState: 'CA' })).message, 'State must be a state of India.');
  assert.equal((await refused({ lastName: ' ' })).message, 'Last name cannot be empty.');
  assert.deepEqual(await refused({ firstName: '' }), { error: 'invalid', field: 'firstName', message: 'A customer needs a first and a last name.' });
  assert.equal((await refused({ languages: 'X'.repeat(101) })).message, 'Language can be at most 100 characters.');
  assert.deepEqual(await refused({ AccountId: '001x', mobile: '9897206000' }), { error: 'invalid', field: 'AccountId', message: 'These cannot be changed here: AccountId.' });
  assert.equal((await refused('mobile')).error, 'invalid');
  assert.equal(salesforce.log.updates.length, 0);
});

test('a number another customer has is refused; one customer\'s family may share it', async () => {
  const taken = fakeSalesforce({ others: [{ Id: '003OTHER0000001AAA', Name: 'Meera Iyer', AccountId: '001OTHER0000001AAA' }] });
  const refused = await editor(taken).updateCustomer(CONTACT_ID, { mobile: '98290 12345' });
  assert.equal(refused.field, 'mobile');
  assert.match(refused.message, /^Meera Iyer already has this number\./);
  assert.match(taken.log.queries.find((q) => q.includes('Id !=')), /MobilePhone IN \('\+919829012345', '919829012345', '09829012345', '9829012345'\)/);
  assert.equal(taken.log.updates.length, 0);

  const family = fakeSalesforce({ others: [{ Id: '003OTHER0000001AAA', Name: 'Asha Ji', AccountId: ACCOUNT_ID }] });
  assert.equal((await editor(family).updateCustomer(CONTACT_ID, { phone: '9829012345' })).updated, true);
});

test('a stored value sent back unchanged is not checked again', async () => {
  const salesforce = fakeSalesforce({ contact: { ...CONTACT, MobilePhone: '98970-06000 (old)' } });
  const result = await editor(salesforce).updateCustomer(CONTACT_ID, { mobile: '98970-06000 (old)', mailingCity: 'Agra' });
  assert.equal(result.updated, true);
  assert.deepEqual(salesforce.log.updates, [{ sobject: 'Contact', id: CONTACT_ID, fields: { MailingCity: 'Agra' } }]);
});

test('only real changes are saved: mobiles in +91 form, the account renamed with the customer, a note naming the editor', async () => {
  const salesforce = fakeSalesforce();
  const result = await editor(salesforce).updateCustomer(CONTACT_ID, {
    firstName: 'Khitiz',
    lastName: 'Sharma',
    mobile: '098970 06001',
    phone: '0562 252 0000',
    email: ' khitiz@example.com ',
    mailingState: 'UP',
    mailingPostalCode: '282001',
    description: 'Line one\r\nLine two',
  }, { editedBy: 'admin@tiffanydesigns.in' });

  assert.equal(result.updated, true);
  assert.deepEqual(salesforce.log.updates, [
    {
      sobject: 'Contact',
      id: CONTACT_ID,
      fields: {
        LastName: 'Sharma',
        MobilePhone: '+919897006001',
        Phone: '0562 252 0000',
        Email: 'khitiz@example.com',
        MailingStateCode: 'UP',
        MailingPostalCode: '282001',
        Description: 'Line one\nLine two',
        MailingCountryCode: 'IN',
      },
    },
    { sobject: 'Account', id: ACCOUNT_ID, fields: { Name: 'Khitiz Sharma' } },
  ]);
  assert.deepEqual(result.changes.map((c) => c.field), ['lastName', 'mobile', 'phone', 'email', 'mailingState', 'mailingPostalCode', 'description', 'accountName']);

  const [note] = salesforce.log.creates;
  assert.equal(note.sobject, 'Task');
  assert.equal(note.fields.WhoId, CONTACT_ID);
  assert.equal(note.fields.WhatId, ACCOUNT_ID);
  assert.equal(note.fields.ActivityDate, '2026-11-04');
  assert.match(note.fields.Description, /^admin@tiffanydesigns\.in changed Khitiz Ji's details:\n- Last name: Ji → Sharma\n- Mobile: \+919897206000 → \+919897006001/);
  assert.match(note.fields.Description, /- State: \(empty\) → Uttar Pradesh/);
  assert.match(note.fields.Description, /- Account name: Khitiz Ji → Khitiz Sharma/);
});

test('an account with another name keeps it; nothing changed saves nothing', async () => {
  const company = fakeSalesforce({ contact: { ...CONTACT, Account: { Name: 'Ji Interiors' } } });
  await editor(company).updateCustomer(CONTACT_ID, { lastName: 'Sharma' });
  assert.deepEqual(company.log.updates.map((u) => u.sobject), ['Contact']);

  const same = fakeSalesforce();
  const result = await editor(same).updateCustomer(CONTACT_ID, { firstName: 'Khitiz', mobile: '+919897206000', email: '' });
  assert.equal(result.updated, false);
  assert.equal(same.log.updates.length + same.log.creates.length, 0);
});

test('a change Salesforce refuses is explained, and nothing is noted', async () => {
  const duplicate = new Error('Salesforce request failed (400): [{"message":"Use one of these records?","errorCode":"DUPLICATES_DETECTED","fields":[]}]');
  const salesforce = fakeSalesforce({ updateError: duplicate });
  assert.deepEqual(await editor(salesforce).updateCustomer(CONTACT_ID, { email: 'khitiz@example.com' }), {
    error: 'rejected', message: 'Salesforce\'s duplicate rules found another customer with these details.', field: null,
  });
  assert.equal(salesforce.log.creates.length, 0);

  const email = new Error('Salesforce request failed (400): [{"message":"Email: invalid email address","errorCode":"INVALID_EMAIL_ADDRESS","fields":["Email"]}]');
  assert.equal((await editor(fakeSalesforce({ updateError: email })).updateCustomer(CONTACT_ID, { email: 'a@b.co' })).field, 'email');
});

test('the order edit form carries the order\'s customer, found through the account when no contact authorised it', async () => {
  const salesforce = fakeSalesforce();
  const data = createConsoleData({ ...options(salesforce), crm: {}, customers: editor(salesforce) });
  const form = await data.getOrderForEdit(ORDER_ID);
  assert.equal(form.customer.id, CONTACT_ID);
  assert.equal(form.customer.values.mobile, '+919897206000');

  const order = await data.getOrder(ORDER_ID);
  assert.equal(order.contact.id, CONTACT_ID, 'the order page shows the account\'s customer');
});

test('customer details saved with an order are checked with it, and noted on the order and the customer', async () => {
  const salesforce = fakeSalesforce();
  const data = createConsoleData({ ...options(salesforce), crm: {}, customers: editor(salesforce) });

  const refused = await data.updateOrder(ORDER_ID, { status: 'Activated', customer: { mobile: '123' } });
  assert.deepEqual(refused, { error: 'invalid', field: 'customer.mobile', message: 'Mobile must be a ten digit mobile number.' });
  assert.equal(salesforce.log.updates.length, 0, 'a refused customer detail saves nothing on the order either');

  const result = await data.updateOrder(ORDER_ID, { status: 'Activated', customer: { mobile: '9897206001', mailingCity: 'Agra' } }, { editedBy: 'admin@tiffanydesigns.in' });
  assert.equal(result.updated, true);
  assert.deepEqual(salesforce.log.updates, [
    { sobject: 'Order', id: ORDER_ID, fields: { Status: 'Activated' } },
    { sobject: 'Contact', id: CONTACT_ID, fields: { MobilePhone: '+919897206001', MailingCity: 'Agra' } },
  ]);
  assert.deepEqual(result.changes.map((c) => c.field), ['status', 'customer.mobile', 'customer.mailingCity']);
  const [orderNote, customerNote] = salesforce.log.creates;
  assert.equal(orderNote.fields.Subject, 'Order edited in the service console');
  assert.equal(customerNote.fields.Subject, 'Customer details edited in the service console');
  assert.equal(customerNote.fields.WhatId, ORDER_ID, 'shown in the order\'s history');
  assert.equal(customerNote.fields.WhoId, CONTACT_ID, 'and in the customer\'s');

  const onlyCustomer = fakeSalesforce();
  const consoleOnly = createConsoleData({ ...options(onlyCustomer), crm: {}, customers: editor(onlyCustomer) });
  await consoleOnly.updateOrder(ORDER_ID, { status: 'Draft', customer: { email: 'k@example.com' } });
  assert.deepEqual(onlyCustomer.log.updates.map((u) => u.sobject), ['Contact']);

  const withoutCustomers = createConsoleData({ ...options(fakeSalesforce()), crm: {} });
  assert.equal((await withoutCustomers.updateOrder(ORDER_ID, { customer: {} })).field, 'customer');
});

test('customer edits through the API: internal key, the editor\'s name, and clear answers', async (t) => {
  const seen = [];
  const customers = {
    getCustomerForEdit: async (id) => (id === CONTACT_ID ? { id, values: {} } : null),
    updateCustomer: async (id, changes, opts) => {
      seen.push({ id, changes, opts });
      if (id !== CONTACT_ID) return null;
      if (changes.mobile === '1') return { error: 'invalid', field: 'mobile', message: 'Mobile must be a ten digit mobile number.' };
      if (changes.email === 'dup@example.com') return { error: 'rejected', message: 'Salesforce\'s duplicate rules found another customer with these details.' };
      return { updated: true, changes: [{ field: 'mobile' }] };
    },
  };
  const s = await startTestServer({ consoleData: {}, customers });
  t.after(s.close);
  const patch = (id, body, headers = s.internal) => s.call('PATCH', `/api/admin/customers/${id}`, { body, headers });

  assert.equal((await patch(CONTACT_ID, { mobile: '9897206001' }, {})).status, 401);
  assert.equal((await patch(CONTACT_ID, { mobile: '9897206001' }, s.site)).status, 401, 'the website key cannot edit customers');

  const saved = await patch(CONTACT_ID, { mobile: '9897206001' }, { ...s.internal, 'x-console-user': 'admin@tiffanydesigns.in' });
  assert.equal(saved.status, 200);
  assert.equal(seen.at(-1).opts.editedBy, 'admin@tiffanydesigns.in');
  assert.equal((await patch(CONTACT_ID, { mobile: '1' })).status, 400);
  assert.equal((await patch(CONTACT_ID, { email: 'dup@example.com' })).status, 422);
  assert.equal((await patch('003gK00000ZZZZZQAV', { mobile: '9897206001' })).status, 404);
  assert.equal((await s.call('GET', `/api/admin/customers/${CONTACT_ID}/edit`, { headers: s.internal })).status, 200);
});
