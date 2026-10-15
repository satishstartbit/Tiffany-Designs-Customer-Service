// Requests use the mobile number and address already in Salesforce: the agent confirms them with the caller
// (get_details_on_file) instead of asking again, and the server fills them in (use_details_on_file).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrm } = require('../src/crm/crm');
const { startTestServer } = require('./helpers');

// ---------- The server: getDetailsOnFile and createServiceCase ----------

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
  AccountId: '001M',
  Account: { Name: 'Satish Chaudhary' },
  CustomerAuthorizedById: '003M',
  ShippingStreet: '41B Pratapnagar',
  ShippingCity: 'Jaipur',
  ShippingState: 'Rajasthan',
  ShippingPostalCode: '302021',
};

function org({ order = JAIPUR_ORDER, contact = { Id: '003M', FirstName: 'Satish', LastName: 'Chaudhary', AccountId: '001M', MobilePhone: '+91 78784 54578' }, account = {} } = {}) {
  return {
    'FROM Order ': (soql) => (soql.includes("'TD-ORD-2002'") ? [order] : []),
    "FROM Contact WHERE Id = '003M'": () => (contact ? [contact] : []),
    "FROM Contact WHERE AccountId = '001M'": () => (contact ? [contact] : []),
    "FROM Account WHERE Id = '001M'": () => [account],
    'FROM RecordType': () => [{ Id: '012RT-INS', DeveloperName: 'Installation_Request' }, { Id: '012RT-REP', DeveloperName: 'Replacement_Request' }],
    'SELECT CaseNumber, Service_Route__c FROM Case': () => [{ CaseNumber: '00001200', Service_Route__c: 'External Provider' }],
  };
}

const open = { isOpen: async () => true };
const crmWith = (answers) => {
  const salesforce = fakeSalesforce(answers);
  return { salesforce, crm: createCrm({ salesforce, businessHours: open }) };
};

test('the details on file are the order customer\'s mobile and the delivery address', async () => {
  const { crm } = crmWith(org());
  const order = await crm.findOrderByReference('TD-ORD-2002');
  assert.deepEqual(await crm.getDetailsOnFile({ order }), {
    contactId: '003M',
    accountId: '001M',
    name: 'Satish Chaudhary',
    mobile: '+917878454578',
    street: '41B Pratapnagar',
    city: 'Jaipur',
    state: 'Rajasthan',
    postalCode: '302021',
  });
});

test('an order without a delivery address falls back to the account\'s billing address', async () => {
  const { crm } = crmWith(org({
    order: { ...JAIPUR_ORDER, ShippingStreet: null, ShippingCity: null, ShippingState: null, ShippingPostalCode: null },
    account: { BillingStreet: '12 MG Road', BillingCity: 'Gurugram', BillingState: 'Haryana', BillingPostalCode: '122002' },
  }));
  const details = await crm.getDetailsOnFile({ order: await crm.findOrderByReference('TD-ORD-2002') });
  assert.deepEqual([details.street, details.city, details.postalCode], ['12 MG Road', 'Gurugram', '122002']);
});

test('a confirmed request uses the mobile and address on file, without asking again', async () => {
  const { crm, salesforce } = crmWith(org());
  const result = await crm.createServiceCase({
    issueType: 'installation', description: 'Customer requested installation.', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true, preferredDate: '2026-10-20',
  });
  assert.equal(result.created, true);
  assert.equal(result.usedDetailsOnFile, true);
  assert.deepEqual(salesforce.log.creates.map((c) => c.sobject), ['Case'], 'no new customer is created');
  const { fields } = salesforce.log.creates[0];
  assert.equal(fields.ContactId, '003M');
  assert.equal(fields.Customer_Mobile__c, '+917878454578');
  assert.deepEqual([fields.Service_City__c, fields.Service_State__c, fields.Service_PIN__c], ['Jaipur', 'Rajasthan', '302021']);
  assert.match(fields.Description, /Address: 41B Pratapnagar/);
  assert.match(fields.Description, /The customer confirmed the mobile number and address on file\./);
});

test('a new number or address for the request replaces the details on file, and the order customer stays', async () => {
  const { crm, salesforce } = crmWith(org());
  await crm.createServiceCase({
    issueType: 'return', description: 'Customer requests a return of the study table.', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true,
    phone: '+919999988888', address: 'House 5, Sector 50', city: 'Gurugram', postalCode: '122018',
  });
  const { fields } = salesforce.log.creates.at(-1);
  assert.deepEqual(salesforce.log.creates.map((c) => c.sobject), ['Case'], 'a different number does not make a new customer');
  assert.equal(fields.ContactId, '003M');
  assert.equal(fields.Customer_Mobile__c, '+919999988888');
  assert.deepEqual([fields.Service_City__c, fields.Service_PIN__c], ['Gurugram', '122018']);
  assert.match(fields.Description, /Address: House 5, Sector 50/);
  assert.match(fields.Description, /The customer gave a new mobile number and address for this request; the details on file are unchanged\./);

  // A new city and PIN code without a street: the old street is not kept.
  await crm.createServiceCase({
    issueType: 'installation', description: 'Install', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true, city: 'Delhi', postalCode: '110001',
  });
  const moved = salesforce.log.creates.at(-1).fields;
  assert.equal(moved.Customer_Mobile__c, '+917878454578', 'the mobile on file is still used');
  assert.doesNotMatch(moved.Description, /41B Pratapnagar/);
  assert.match(moved.Description, /new address/);
});

test('when nothing usable is on file, the agent is told what to ask for', async () => {
  const noMobile = crmWith(org({ contact: { Id: '003M', FirstName: 'Satish', LastName: 'Chaudhary', AccountId: '001M', MobilePhone: null } }));
  const refusedMobile = await noMobile.crm.createServiceCase({ issueType: 'installation', description: 'Install', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true });
  assert.deepEqual(refusedMobile, { created: false, error: 'No mobile number is on file for this order. Ask the customer for a mobile number to reach them on.' });

  const noAddress = crmWith(org({ order: { ...JAIPUR_ORDER, ShippingStreet: null, ShippingCity: null, ShippingState: null, ShippingPostalCode: null } }));
  const refusedAddress = await noAddress.crm.createServiceCase({ issueType: 'installation', description: 'Install', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true });
  assert.match(refusedAddress.error, /^No address is on file for this order\./);
  assert.equal(noAddress.salesforce.log.creates.length, 0);

  // A general question needs no address.
  const general = await noAddress.crm.createServiceCase({ issueType: 'general', description: 'Warranty?', erpOrderId: 'TD-ORD-2002', useDetailsOnFile: true });
  assert.equal(general.created, true);
});

test('without use_details_on_file nothing changes: the caller\'s number is used as before', async () => {
  const { crm, salesforce } = crmWith(org());
  await crm.createServiceCase({ issueType: 'installation', description: 'Install', erpOrderId: 'TD-ORD-2002', phone: '+917878454578', city: 'Jaipur', postalCode: '302021' });
  const { fields } = salesforce.log.creates.at(-1);
  assert.equal(fields.Customer_Mobile__c, '+917878454578');
  assert.doesNotMatch(fields.Description, /on file/);
});

// ---------- The agent tools: /api/agent/details-on-file and use_details_on_file ----------

test('get_details_on_file gives only what is needed to confirm: the last four digits, the city and the PIN code', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const ask = (body) => s.call('POST', '/api/agent/details-on-file', { body, headers: s.agent }).then((r) => r.body);

  const order = await ask({ order_id: 'td ord 1111' });
  assert.equal(order.found, true);
  assert.equal(order.source, 'order');
  assert.equal(order.mobile_ending, '1111');
  assert.equal(order.message, 'On file: the mobile number ending 1 1 1 1, and the delivery address in Jaipur, PIN code 3 0 2 0 1 2. Ask the customer whether to use these for the request.');
  assert.doesNotMatch(JSON.stringify(order), /98200/, 'the full mobile number is never sent to the agent');

  const byInvoice = await ask({ invoice_number: 'INV-1111' });
  assert.equal(byInvoice.mobile_ending, '1111');

  const nothing = await ask({ order_id: 'TD-ORD-3333' });
  assert.equal(nothing.message, 'No mobile number or address is on file. Ask the customer for both.');

  const caller = await ask({ phone: '9876543210' });
  assert.equal(caller.source, 'customer');
  assert.equal(caller.message, 'On file: the mobile number ending 3 2 1 0, and the address, PIN code 1 1 0 0 0 1. Ask the customer whether to use these for the request.');

  assert.equal((await ask({ order_id: 'TD-ORD-9999' })).found, false);
  assert.equal((await ask({})).found, false);
  assert.equal((await s.call('POST', '/api/agent/details-on-file', { body: { order_id: 'TD-ORD-1111' } })).status, 401, 'agent tools need the agent secret');
});

test('requests pass use_details_on_file to the server, so no mobile number is needed in the call', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const installation = await s.call('POST', '/api/agent/installation', {
    body: { order_id: 'TD-ORD-1111', preferred_date: '2026-10-20', preferred_time: 'morning', use_details_on_file: true },
    headers: s.agent,
  });
  assert.equal(installation.body.created, true);
  assert.equal(s.crm.created.at(-1).input.useDetailsOnFile, true);
  assert.equal(s.crm.created.at(-1).input.phone, null);

  const ret = await s.call('POST', '/api/agent/cases', {
    body: { issue_type: 'return', description: 'Customer wants to return the bookcase.', order_id: 'TD-ORD-1111', use_details_on_file: 'true' },
    headers: s.agent,
  });
  assert.equal(ret.body.created, true);
  assert.equal(s.crm.created.at(-1).input.useDetailsOnFile, true);

  await s.call('POST', '/api/agent/cases', { body: { issue_type: 'general', description: 'x', phone: '9876543210' }, headers: s.agent });
  assert.equal(s.crm.created.at(-1).input.useDetailsOnFile, false, 'off unless asked for');
});
