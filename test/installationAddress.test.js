// For an installation the agent asks whether to install where the order was delivered or somewhere else
// (get_installation_address), and the server fills in that address when the caller chooses it (at_delivery_address).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrm } = require('../src/crm/crm');
const { startTestServer } = require('./helpers');

function fakeSalesforce(answers) {
  const log = { queries: [], creates: [] };
  return {
    log,
    async query(soql) {
      log.queries.push(soql);
      const hit = Object.entries(answers).find(([match]) => soql.includes(match));
      return hit ? hit[1](soql) : [];
    },
    async search() {
      return [];
    },
    async create(sobject, fields) {
      log.creates.push({ sobject, fields });
      return { id: `${sobject}-${log.creates.length}`, success: true };
    },
  };
}

const JAIPUR_ORDER = {
  Id: '801M',
  ERP_Order_Id__c: 'TD-ORD-2002',
  Invoice_Number__c: 'INV-2002',
  Order_Source__c: 'Website',
  Delivery_Status__c: 'Delivered',
  AccountId: '001M',
  Account: { Name: 'Kavya Rao' },
  CustomerAuthorizedById: '003M',
  ShippingStreet: '41B Pratapnagar',
  ShippingCity: 'Jaipur',
  ShippingState: 'Rajasthan',
  ShippingPostalCode: '302021',
};
const NO_SHIPPING = { ShippingStreet: null, ShippingCity: null, ShippingState: null, ShippingPostalCode: null };

function org({ order = JAIPUR_ORDER, account = {} } = {}) {
  const contact = { Id: '003M', FirstName: 'Kavya', LastName: 'Rao', AccountId: '001M', MobilePhone: '+91 78784 54578' };
  return {
    'FROM Order ': (soql) => (soql.includes("'TD-ORD-2002'") ? [order] : []),
    "FROM Contact WHERE Id = '003M'": () => [contact],
    "FROM Contact WHERE AccountId = '001M'": () => [contact],
    "FROM Account WHERE Id = '001M'": () => [account],
    'FROM RecordType': () => [{ Id: '012RT-INS', DeveloperName: 'Installation_Request' }],
    'SELECT CaseNumber, Service_Route__c FROM Case': () => [{ CaseNumber: '00001200', Service_Route__c: 'External Provider' }],
  };
}

const open = { isOpen: async () => true };
const crmWith = (answers = org()) => {
  const salesforce = fakeSalesforce(answers);
  return { salesforce, crm: createCrm({ salesforce, businessHours: open }) };
};
const savedCase = (salesforce) => salesforce.log.creates.find((c) => c.sobject === 'Case')?.fields;
const INSTALL = { issueType: 'installation', description: 'Customer requested installation.', erpOrderId: 'TD-ORD-2002', invoiceNumber: 'INV-2002' };

// ---------- The server: createServiceCase with atDeliveryAddress ----------

test('installing at the delivery address uses the full address on the order, whatever else was said', async () => {
  const { salesforce, crm } = crmWith();
  const result = await crm.createServiceCase({ ...INSTALL, atDeliveryAddress: true, city: 'Delhi', address: 'Somewhere else' });
  assert.equal(result.created, true);
  assert.equal(result.addressSource, 'delivery');
  const fields = savedCase(salesforce);
  assert.deepEqual([fields.Service_City__c, fields.Service_State__c, fields.Service_PIN__c], ['Jaipur', 'Rajasthan', '302021']);
  assert.match(fields.Description, /\nAddress: 41B Pratapnagar\n/);
  assert.match(fields.Description, /\nThe customer chose the delivery address of the order\.\n/);
});

test('an order without a delivery address uses the customer\'s address on file, and says so', async () => {
  const { salesforce, crm } = crmWith(org({
    order: { ...JAIPUR_ORDER, ...NO_SHIPPING },
    account: { BillingStreet: '12 MG Road', BillingCity: 'Gurugram', BillingState: 'Haryana', BillingPostalCode: '122002' },
  }));
  const result = await crm.createServiceCase({ ...INSTALL, atDeliveryAddress: true });
  assert.equal(result.addressSource, 'customer');
  const fields = savedCase(salesforce);
  assert.deepEqual([fields.Service_City__c, fields.Service_PIN__c], ['Gurugram', '122002']);
  assert.match(fields.Description, /Address: 12 MG Road/);
  assert.match(fields.Description, /The customer chose their address on file; the order has no delivery address\./);
});

test('with no address on record, or no order, the delivery address cannot be used', async () => {
  const none = crmWith(org({ order: { ...JAIPUR_ORDER, ...NO_SHIPPING } }));
  const refused = await none.crm.createServiceCase({ ...INSTALL, atDeliveryAddress: true });
  assert.deepEqual(refused, { created: false, error: 'No delivery address is on record for this order. Ask for the house, street and area, the city and the six digit PIN code.' });
  assert.equal(savedCase(none.salesforce), undefined);

  const noOrder = crmWith();
  const withoutOrder = await noOrder.crm.createServiceCase({ issueType: 'installation', description: 'x', phone: '+917878454578', atDeliveryAddress: true });
  assert.equal(withoutOrder.created, false);
  assert.match(withoutOrder.error, /The order is needed/);
});

test('with the details on file too, the mobile comes from the record and the address from the delivery', async () => {
  const { salesforce, crm } = crmWith();
  await crm.createServiceCase({ ...INSTALL, invoiceNumber: undefined, useDetailsOnFile: true, atDeliveryAddress: true });
  const fields = savedCase(salesforce);
  assert.equal(fields.Customer_Mobile__c, '+917878454578');
  assert.equal(fields.Service_PIN__c, '302021');
  assert.match(fields.Description, /The customer chose the delivery address of the order\.\nThe customer confirmed the mobile number and address on file\./);
});

test('another address the caller gives is used as before when the delivery address is not chosen', async () => {
  const { salesforce, crm } = crmWith();
  await crm.createServiceCase({ ...INSTALL, address: '7 Lake View', city: 'Udaipur', postalCode: '313001' });
  const fields = savedCase(salesforce);
  assert.deepEqual([fields.Service_City__c, fields.Service_PIN__c], ['Udaipur', '313001']);
  assert.match(fields.Description, /Address: 7 Lake View/);
  assert.doesNotMatch(fields.Description, /chose/);
});

// ---------- The agent tools ----------

async function serverWith(answers) {
  const { salesforce, crm } = crmWith(answers);
  const s = await startTestServer({ crm });
  return { s, salesforce };
}

test('get_installation_address gives the delivery address to confirm, then the mobile on file', async (t) => {
  const { s } = await serverWith(org());
  t.after(s.close);
  const res = await s.call('POST', '/api/agent/installation-address', { body: { order_id: 'TD-ORD-2002' }, headers: s.agent });
  assert.deepEqual(res.body, {
    found: true,
    order_id: 'TD-ORD-2002',
    delivered: true,
    address_source: 'delivery',
    city: 'Jaipur',
    state: 'Rajasthan',
    postal_code: '302021',
    mobile_on_file: true,
    mobile_ending: '4578',
    message: 'Order TD-ORD-2002 was delivered to the address in Jaipur, Rajasthan, PIN code 3 0 2 0 2 1. '
      + 'Ask the customer whether the installation should be at this address or somewhere else. '
      + 'After that, ask whether to use the mobile number ending 4 5 7 8.',
  });
  assert.doesNotMatch(JSON.stringify(res.body), /Pratapnagar|7878454578/, 'the street and the full number stay on the server');
});

test('get_installation_address offers the customer\'s address when the order has none, or asks for one', async (t) => {
  const billing = await serverWith(org({
    order: { ...JAIPUR_ORDER, ...NO_SHIPPING, Delivery_Status__c: 'Shipped' },
    account: { BillingCity: 'Delhi', BillingState: 'Delhi', BillingPostalCode: '110001' },
  }));
  t.after(billing.s.close);
  const fallback = await billing.s.call('POST', '/api/agent/installation-address', { body: { order_id: 'TD-ORD-2002' }, headers: billing.s.agent });
  assert.equal(fallback.body.address_source, 'customer');
  assert.equal(fallback.body.delivered, false);
  assert.match(fallback.body.message, /^Order TD-ORD-2002 has no delivery address on record\. The customer's address on file is in Delhi, PIN code 1 1 0 0 0 1\. Ask the customer whether/);

  const empty = await serverWith(org({ order: { ...JAIPUR_ORDER, ...NO_SHIPPING } }));
  t.after(empty.s.close);
  const nothing = await empty.s.call('POST', '/api/agent/installation-address', { body: { order_id: 'TD-ORD-2002' }, headers: empty.s.agent });
  assert.equal(nothing.body.address_source, null);
  assert.match(nothing.body.message, /^No address is on record for order TD-ORD-2002\. Ask where the installation should be: the house, street and area, then the city, then the six digit PIN code\./);

  const unknown = await empty.s.call('POST', '/api/agent/installation-address', { body: { order_id: 'TD-ORD-9999' }, headers: empty.s.agent });
  assert.equal(unknown.body.found, false);
  const noReference = await empty.s.call('POST', '/api/agent/installation-address', { body: {}, headers: empty.s.agent });
  assert.match(noReference.body.message, /order id, order number or invoice number is needed/);
  assert.equal((await empty.s.call('POST', '/api/agent/installation-address', { body: { order_id: 'TD-ORD-2002' } })).status, 401, 'agent tools need the agent secret');
});

test('book_installation with at_delivery_address registers the request at the delivery address', async (t) => {
  const { s, salesforce } = await serverWith(org());
  t.after(s.close);
  const res = await s.call('POST', '/api/agent/installation', {
    body: { order_id: 'TD-ORD-2002', preferred_date: '2026-10-17', preferred_time: 'morning', use_details_on_file: true, at_delivery_address: true },
    headers: s.agent,
  });
  assert.equal(res.body.created, true);
  assert.match(res.body.message, /^Installation request 1200 is registered at the delivery address with a preferred slot of Saturday, 17 October, in the morning, between 10 am and 12 pm\./);
  assert.equal(savedCase(salesforce).Service_City__c, 'Jaipur');
});
