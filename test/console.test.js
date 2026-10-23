// The staff console's read-only views (src/crm/console.js) and their API (/api/admin, behind the internal key).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConsoleData, categoryOf } = require('../src/crm/console');
const { startTestServer } = require('./helpers');

const ORDER_ID = '801gK00000AbCdEQAV';
const CASE_ID = '500gK00000AbCdEQAV';

function fakeSalesforce(answers = {}) {
  const queries = [];
  return {
    queries,
    async query(soql) {
      queries.push(soql);
      const hit = Object.entries(answers).find(([match]) => soql.includes(match));
      return hit ? hit[1](soql) : [];
    },
  };
}

const orderRow = {
  Id: ORDER_ID,
  OrderNumber: '00000122',
  ERP_Order_Id__c: 'TD-ORD-1001',
  Status: 'Activated',
  Delivery_Status__c: 'Delivered',
  Order_Source__c: 'Flipkart',
  EffectiveDate: '2026-10-01',
  TotalAmount: 18990,
  CreatedDate: '2026-10-01T05:00:00.000+0000',
  AccountId: '001gK00000AbCdEQAV',
  Account: { Name: 'Meera Iyer' },
  ShippingCity: 'Gurugram',
  OrderItems: { records: [{ Quantity: 2, Product2: { Name: 'Demo Bookcase' } }, { Quantity: 1, Product2: { Name: 'Demo Study Chair' } }] },
};

test('products are grouped into the shop\'s categories by name', () => {
  assert.equal(categoryOf('XYLO Shoe Cabinet (Medium)'), 'Shoe Storage');
  assert.equal(categoryOf('360° Rotating Bookshelf - Teak Brown (2 Tier)'), 'Bookshelves');
  assert.equal(categoryOf('Demo TV Cabinet'), 'TV Cabinets');
  assert.equal(categoryOf('Stellar Multipurpose Storage Cabinet'), 'Storage Cabinets');
  assert.equal(categoryOf('Demo Study Chair'), 'Chairs');
  assert.equal(categoryOf('Something else'), 'Other');
});

test('the order list pages, filters by known values only, and escapes the search', async () => {
  const salesforce = fakeSalesforce({ 'FROM Order': () => [orderRow, orderRow, orderRow] });
  const data = createConsoleData({ salesforce, crm: {} });
  const result = await data.listOrders({ q: "o'brien%", status: 'Activated', delivery: 'Lost', page: '2', pageSize: '2' });

  assert.equal(result.records.length, 2);
  assert.equal(result.hasMore, true, 'a third row means another page');
  assert.deepEqual({ ...result.records[0], createdDate: undefined }, {
    id: ORDER_ID,
    orderNumber: '00000122',
    erpOrderId: 'TD-ORD-1001',
    invoiceNumber: null,
    status: 'Activated',
    deliveryStatus: 'Delivered',
    source: 'Flipkart',
    orderDate: '2026-10-01',
    deliveryDate: null,
    total: 18990,
    createdDate: undefined,
    accountId: '001gK00000AbCdEQAV',
    customerName: 'Meera Iyer',
    contactId: null,
    contactName: null,
    city: 'Gurugram',
    postalCode: null,
    itemCount: 3,
    products: ['Demo Bookcase', 'Demo Study Chair'],
  });
  const [soql] = salesforce.queries;
  assert.match(soql, /Status = 'Activated'/);
  assert.doesNotMatch(soql, /Lost/, 'an unknown delivery status is ignored');
  assert.match(soql, /LIKE '%o\\'brien\\%%'/, 'quotes and wildcards in the search are escaped');
  assert.match(soql, /LIMIT 3 OFFSET 2$/);
});

test('a record id must look like a Salesforce id, so nothing else reaches a query', async () => {
  const salesforce = fakeSalesforce();
  const data = createConsoleData({ salesforce, crm: {} });
  for (const id of ["x' OR Id != '", '123', '']) {
    assert.equal(await data.getOrder(id), null);
    assert.equal(await data.getCase(id), null);
    assert.equal(await data.getCustomer(id), null);
    assert.equal(await data.getProduct(id), null);
  }
  assert.equal(salesforce.queries.length, 0);
});

test('a case shows its customer, part, visits, shipments and calls', async () => {
  const salesforce = fakeSalesforce({
    'FROM Case WHERE Id': () => [{
      Id: CASE_ID,
      CaseNumber: '00001042',
      Status: 'New',
      IsClosed: false,
      Service_Type__c: 'Damage or Defect',
      Service_Sub_Type__c: 'Damaged Component',
      Contact: { Name: 'Meera Iyer', MobilePhone: '+919820011111' },
      Damaged_Component__r: { Name: 'Door Hinge', Part_Number__c: 'HNG-01' },
      CreatedDate: '2026-10-14T06:00:00.000+0000',
    }],
    'FROM Service_Visit__c': () => [{ Id: 'a01', Name: 'SV-1', Status__c: 'Appointment Scheduled', Scheduled_Start__c: '2026-10-16T05:30:00.000+0000', Technician__r: { Name: 'Ravi' } }],
    'FROM Replacement_Shipment__c': () => [{ Id: 'a02', Name: 'RS-1', Shipment_Status__c: 'Dispatched', Tracking_URL__c: 'javascript:alert(1)' }],
    'FROM Task': () => [{ Id: '00T1', Subject: 'Call', TaskSubtype: 'Call', CallType: 'Inbound', CallDurationInSeconds: 95, CreatedDate: '2026-10-14T06:01:00.000+0000' }],
  });
  const data = createConsoleData({ salesforce, crm: {} });
  const found = await data.getCase(CASE_ID);
  assert.equal(found.caseNumber, '00001042');
  assert.equal(found.mobile, '+919820011111');
  assert.deepEqual(found.component, { name: 'Door Hinge', partNumber: 'HNG-01' });
  assert.equal(found.visits[0].technician, 'Ravi');
  assert.equal(found.shipments[0].trackingUrl, null, 'only web links are passed on');
  assert.deepEqual([found.activities[0].kind, found.activities[0].direction, found.activities[0].durationSeconds], ['call', 'Inbound', 95]);
});

test('requests list the scheduled calls, open to-dos and escalated cases', async () => {
  const salesforce = fakeSalesforce({ "Status = 'Escalated'": () => [{ Id: CASE_ID, CaseNumber: '00001043', Status: 'Escalated' }] });
  const scheduler = {
    list: async () => [
      { id: 'followup:1', type: 'delivery_followup', status: 'pending', runAt: '2026-10-15T07:00:00.000Z', attempts: 0, payload: { customerName: 'Asha', erpOrderId: 'TD-ORD-1001', phone: '+919876543210' } },
      { id: 'notice:2', type: 'service_update', status: 'done', runAt: '2026-10-14T07:00:00.000Z', attempts: 1, payload: { caseNumber: '00001042' } },
    ],
  };
  const data = createConsoleData({ salesforce, crm: {}, scheduler });
  const result = await data.listRequests();
  assert.deepEqual(result.scheduledCalls.map((j) => [j.id, j.reference, j.customerName]), [['followup:1', 'TD-ORD-1001', 'Asha'], ['notice:2', '00001042', null]]);
  assert.equal('phone' in result.scheduledCalls[0], false, 'phone numbers stay on the server');
  assert.equal(result.callbacks[0].caseNumber, '00001043');
});

test('a caller is named by first name only, and only for a mobile number that belongs to a customer', async (t) => {
  const contacts = { '+917357558134': { id: '003S', name: 'Satish Choudhary', firstName: 'Satish', mobile: '+917357558134', city: 'Jaipur' } };
  const asked = [];
  const crm = { async findContactByPhone(phone) { asked.push(phone); return contacts[phone] || null; } };
  const data = createConsoleData({ salesforce: fakeSalesforce(), crm });
  assert.deepEqual(await data.callerName('73575 58134'), { found: true, first_name: 'Satish' });
  assert.deepEqual(await data.callerName('9123456780'), { found: false, first_name: null });
  assert.deepEqual(await data.callerName('12345'), { found: false, first_name: null });
  assert.deepEqual(asked, ['+917357558134', '+919123456780'], 'no lookup for something that is not a mobile number');

  const s = await startTestServer({ consoleData: data });
  t.after(s.close);
  assert.equal((await s.call('GET', '/api/admin/caller?phone=7357558134')).status, 401, 'behind the internal key');
  assert.deepEqual((await s.call('GET', '/api/admin/caller?phone=7357558134', { headers: s.internal })).body, { found: true, first_name: 'Satish' });
});

test('the console API needs the internal key and answers 404 for an unknown record', async (t) => {
  const consoleData = {
    summary: async () => ({ counts: { orders: 20 } }),
    listOrders: async (filters) => ({ records: [], filters }),
    getOrder: async (id) => (id === ORDER_ID ? { id } : null),
  };
  const s = await startTestServer({ consoleData });
  t.after(s.close);

  assert.equal((await s.call('GET', '/api/admin/summary')).status, 401);
  assert.equal((await s.call('GET', '/api/admin/summary', { headers: s.site })).status, 401, 'the website key is not enough');

  const summary = await s.call('GET', '/api/admin/summary', { headers: s.internal });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.counts.orders, 20);
  assert.equal(summary.headers.get('cache-control'), 'no-store');

  const listed = await s.call('GET', '/api/admin/orders?q=TD&status=Draft&unknown=1', { headers: s.internal });
  assert.equal(listed.body.filters.q, 'TD');
  assert.equal(listed.body.filters.status, 'Draft');
  assert.equal('unknown' in listed.body.filters, false);

  assert.equal((await s.call('GET', `/api/admin/orders/${ORDER_ID}`, { headers: s.internal })).status, 200);
  assert.equal((await s.call('GET', '/api/admin/orders/801gK00000ZZZZZQAV', { headers: s.internal })).status, 404);
});
