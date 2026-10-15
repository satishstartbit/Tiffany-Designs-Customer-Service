// Editing an order from the staff console: src/crm/console.js (updateOrder, getOrderForEdit) and PATCH /api/admin/orders/:id.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConsoleData } = require('../src/crm/console');
const { startTestServer } = require('./helpers');

const ORDER_ID = '801gK00000AbCdEQAV';

// The org's rules for each editable field, as Salesforce describes them.
const ORDER_DESCRIBE = {
  fields: [
    { name: 'Status', type: 'picklist', nillable: false, picklistValues: [{ value: 'Draft', active: true }, { value: 'Activated', active: true }] },
    { name: 'Delivery_Status__c', type: 'picklist', nillable: true, picklistValues: ['Processing', 'Shipped', 'Delivered', 'Returned'].map((value) => ({ value, active: true })) },
    { name: 'Delivery_Date__c', type: 'date', nillable: true },
    { name: 'ERP_Order_Id__c', type: 'string', length: 50, nillable: true },
    { name: 'Invoice_Number__c', type: 'string', length: 50, nillable: true },
    { name: 'Order_Source__c', type: 'picklist', nillable: true, picklistValues: ['Amazon', 'Flipkart', 'Website', 'Other'].map((value) => ({ value, active: true })) },
    { name: 'Fulfilment_Type__c', type: 'picklist', nillable: true, picklistValues: [{ value: 'Self Ship', active: true }] },
    { name: 'EffectiveDate', type: 'date', nillable: false },
    { name: 'Description', type: 'textarea', length: 32000, nillable: true },
    { name: 'ShippingStreet', type: 'textarea', length: 255, nillable: true },
    { name: 'ShippingCity', type: 'string', length: 40, nillable: true },
    {
      name: 'ShippingStateCode',
      type: 'picklist',
      nillable: true,
      picklistValues: [{ value: 'RJ', label: 'Rajasthan', active: true, validFor: 'gA==' }, { value: 'CA', label: 'California', active: true, validFor: 'AA==' }],
    },
    { name: 'ShippingPostalCode', type: 'string', length: 20, nillable: true },
    { name: 'ShippingCountryCode', type: 'picklist', nillable: true, picklistValues: [{ value: 'IN', active: true }] },
  ],
};

const EDITABLE_ROW = {
  Id: ORDER_ID,
  OrderNumber: '00000122',
  Account: { Name: 'Meera Iyer' },
  CustomerAuthorizedById: '003gK00000AbCdEQAV',
  ShippingCountryCode: null,
  Status: 'Draft',
  Delivery_Status__c: null,
  Delivery_Date__c: null,
  ERP_Order_Id__c: 'TD-ORD-1001',
  Invoice_Number__c: null,
  Order_Source__c: 'Website',
  Fulfilment_Type__c: null,
  EffectiveDate: '2026-10-01',
  Description: null,
  ShippingStreet: null,
  ShippingCity: 'Jaipur',
  ShippingStateCode: null,
  ShippingPostalCode: '302021',
};

function fakeSalesforce({ updateError } = {}) {
  const log = { queries: [], updates: [], creates: [] };
  return {
    log,
    async query(soql) {
      log.queries.push(soql);
      if (soql.includes('ShippingCountryCode, Status')) return [EDITABLE_ROW];
      if (soql.includes('FROM Order WHERE Id')) return [{ ...EDITABLE_ROW, Status: 'Activated' }];
      return [];
    },
    describe: async () => ORDER_DESCRIBE,
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

const editor = (salesforce) => createConsoleData({ salesforce, crm: {}, now: () => Date.parse('2026-10-15T06:30:00Z'), logger: { error() {} } });

test('the edit form gets the current values, the org\'s choices and its limits', async () => {
  const form = await editor(fakeSalesforce()).getOrderForEdit(ORDER_ID);
  assert.equal(form.values.erpOrderId, 'TD-ORD-1001');
  assert.equal(form.values.shippingCity, 'Jaipur');
  assert.deepEqual(form.options.statuses, ['Draft', 'Activated']);
  assert.deepEqual(form.options.states, [{ value: 'RJ', label: 'Rajasthan' }], 'only Indian states');
  assert.equal(form.maxLengths.erpOrderId, 50);
  assert.deepEqual(form.required, ['status', 'orderDate']);
});

test('an order edit is checked against the org\'s rules before anything is saved', async () => {
  const salesforce = fakeSalesforce();
  const data = editor(salesforce);
  const refused = (changes) => data.updateOrder(ORDER_ID, changes, { editedBy: 'admin@tiffanydesigns.in' });

  assert.deepEqual(await refused({ status: 'Shipped' }), { error: 'invalid', field: 'status', message: 'Status must be one of: Draft, Activated.' });
  assert.equal((await refused({ erpOrderId: 'X'.repeat(51) })).message, 'Order id can be at most 50 characters.');
  assert.equal((await refused({ orderDate: '  ' })).message, 'Order date cannot be empty.');
  assert.equal((await refused({ status: null })).message, 'Status cannot be empty.');
  assert.equal((await refused({ deliveryDate: '2026-02-30' })).message, 'Delivered on must be a date.');
  assert.equal((await refused({ shippingPostalCode: '1234' })).message, 'Ship to PIN code must be a six digit PIN code.');
  assert.equal((await refused({ shippingState: 'CA' })).message, 'Ship to state must be a state of India.');
  assert.equal((await refused({ invoiceNumber: 42 })).message, 'Invoice number must be text.');
  assert.deepEqual(await refused({ TotalAmount: 1, status: 'Activated' }), { error: 'invalid', field: 'TotalAmount', message: 'These cannot be changed here: TotalAmount.' });
  assert.equal((await refused([])).error, 'invalid');
  assert.equal(salesforce.log.updates.length, 0);
  assert.equal(await data.updateOrder("x' OR Id != '", { status: 'Activated' }), null);
});

test('only real changes are saved, with a history note naming who changed what', async () => {
  const salesforce = fakeSalesforce();
  const result = await editor(salesforce).updateOrder(ORDER_ID, {
    status: 'Activated',
    deliveryStatus: 'Delivered',
    deliveryDate: '2026-10-14',
    erpOrderId: 'TD-ORD-1001',
    invoiceNumber: ' INV-9 ',
    shippingState: 'RJ',
    shippingCity: 'Jaipur',
    description: 'Line one\r\nLine two',
  }, { editedBy: 'admin@tiffanydesigns.in' });

  assert.equal(result.updated, true);
  assert.deepEqual(salesforce.log.updates, [{
    sobject: 'Order',
    id: ORDER_ID,
    fields: {
      Status: 'Activated',
      Delivery_Status__c: 'Delivered',
      Delivery_Date__c: '2026-10-14',
      Invoice_Number__c: 'INV-9',
      ShippingStateCode: 'RJ',
      Description: 'Line one\nLine two',
      ShippingCountryCode: 'IN',
    },
  }]);
  assert.deepEqual(result.changes.map((c) => c.field), ['status', 'deliveryStatus', 'deliveryDate', 'invoiceNumber', 'shippingState', 'description']);
  assert.equal(result.order.id, ORDER_ID, 'the saved order comes back');

  const [note] = salesforce.log.creates;
  assert.equal(note.sobject, 'Task');
  assert.equal(note.fields.WhatId, ORDER_ID);
  assert.equal(note.fields.WhoId, '003gK00000AbCdEQAV');
  assert.equal(note.fields.Status, 'Completed');
  assert.equal(note.fields.ActivityDate, '2026-10-15');
  assert.match(note.fields.Description, /^admin@tiffanydesigns\.in changed:\n- Status: Draft → Activated\n- Delivery status: \(empty\) → Delivered/);
  assert.match(note.fields.Description, /- Ship to state: \(empty\) → Rajasthan/);
});

test('an edit that changes nothing saves nothing; clearing a field is a change', async () => {
  const salesforce = fakeSalesforce();
  const data = editor(salesforce);
  const same = await data.updateOrder(ORDER_ID, { status: 'Draft', erpOrderId: 'TD-ORD-1001', shippingCity: ' Jaipur ' });
  assert.equal(same.updated, false);
  assert.equal(salesforce.log.updates.length + salesforce.log.creates.length, 0);

  const cleared = await data.updateOrder(ORDER_ID, { shippingCity: '' });
  assert.deepEqual(salesforce.log.updates[0].fields, { ShippingCity: null });
  assert.equal(cleared.changes[0].to, null);
});

test('a change Salesforce refuses is explained, and nothing is noted', async () => {
  const duplicate = new Error('Salesforce request failed (400): [{"message":"duplicate value found: ERP_Order_Id__c duplicates value on record with id: 801gK00000ZZZZZ","errorCode":"DUPLICATE_VALUE","fields":[]}]');
  const salesforce = fakeSalesforce({ updateError: duplicate });
  assert.deepEqual(await editor(salesforce).updateOrder(ORDER_ID, { erpOrderId: 'TD-ORD-1002' }), {
    error: 'rejected', message: 'Another order already uses this order id.', field: 'erpOrderId',
  });
  assert.equal(salesforce.log.creates.length, 0);

  const rule = new Error('Salesforce request failed (400): [{"message":"You cannot activate an order without products.","errorCode":"FIELD_INTEGRITY_EXCEPTION","fields":[]}]');
  const refused = await editor(fakeSalesforce({ updateError: rule })).updateOrder(ORDER_ID, { status: 'Activated' });
  assert.deepEqual(refused, { error: 'rejected', message: 'You cannot activate an order without products.', field: null });

  const named = new Error('Salesforce request failed (400): [{"message":"Delivery date cannot be in the future.","errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION","fields":["Delivery_Date__c"]}]');
  assert.equal((await editor(fakeSalesforce({ updateError: named })).updateOrder(ORDER_ID, { deliveryDate: '2030-01-01' })).field, 'deliveryDate');

  await assert.rejects(editor(fakeSalesforce({ updateError: new Error('socket hang up') })).updateOrder(ORDER_ID, { status: 'Activated' }), /socket hang up/);
});

test('order edits through the API: internal key, the editor\'s name, and clear answers', async (t) => {
  const seen = [];
  const consoleData = {
    getOrderForEdit: async (id) => (id === ORDER_ID ? { id, values: {} } : null),
    updateOrder: async (id, changes, options) => {
      seen.push({ id, changes, options });
      if (id !== ORDER_ID) return null;
      if (changes.status === 'Shipped') return { error: 'invalid', field: 'status', message: 'Status must be one of: Draft, Activated.' };
      if (changes.erpOrderId === 'TAKEN') return { error: 'rejected', message: 'Another order already uses this order id.' };
      return { updated: true, changes: [{ field: 'status' }], order: { id } };
    },
  };
  const s = await startTestServer({ consoleData });
  t.after(s.close);
  const patch = (id, body, headers = s.internal) => s.call('PATCH', `/api/admin/orders/${id}`, { body, headers });

  assert.equal((await patch(ORDER_ID, { status: 'Activated' }, {})).status, 401);
  assert.equal((await patch(ORDER_ID, { status: 'Activated' }, s.site)).status, 401, 'the website key cannot edit orders');

  const saved = await patch(ORDER_ID, { status: 'Activated' }, { ...s.internal, 'x-console-user': 'admin@tiffanydesigns.in<script>' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.updated, true);
  assert.equal(seen.at(-1).options.editedBy, 'admin@tiffanydesigns.inscript', 'the name is reduced to plain characters');

  assert.equal((await patch(ORDER_ID, { status: 'Shipped' })).status, 400);
  assert.equal((await patch(ORDER_ID, { erpOrderId: 'TAKEN' })).status, 422);
  assert.equal((await patch('801gK00000ZZZZZQAV', { status: 'Activated' })).status, 404);
  assert.equal((await s.call('GET', `/api/admin/orders/${ORDER_ID}/edit`, { headers: s.internal })).status, 200);
});
