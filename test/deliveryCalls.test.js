const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryCalls, mobileToCall } = require('../src/deliveryCalls');
const { createDeliveredOrders, CALL_MARKER_SUBJECT } = require('../src/crm/deliveredOrders');
const { createScheduler, createMemoryJobStore } = require('../src/scheduler');
const { createApp } = require('../src/app');
const { testConfig, createFakeCrm, createFakeSarvam } = require('./helpers');

// Thursday 22 October 2026, 11:30 am in India.
const NOW = Date.parse('2026-10-22T06:00:00Z');
const quiet = { error() {}, warn() {}, log() {} };

function order(id, overrides = {}) {
  return {
    id,
    orderNumber: `0000${id}`,
    erpOrderId: `TD-ORD-${id}`,
    deliveryStatus: 'Delivered',
    deliveryDate: '2026-10-22',
    lastModified: '2026-10-22T04:00:00.000+0000',
    city: 'Delhi',
    customer: { id: '003A', name: 'Aarav Sharma', mobile: '98765 43210', phone: null },
    ...overrides,
  };
}

// An order of its own customer, with a mobile number of its own.
const ownCustomer = (id, overrides = {}) => order(id, {
  customer: { id: `003-${id}`, name: `Customer ${id}`, mobile: `98000 ${String(id).padStart(5, '0')}`, phone: null },
  ...overrides,
});

// Each marker notes how many calls had been placed when it was saved, to show it comes after the call.
function fakeOrders(list, sarvam, { called = [], open = [] } = {}) {
  const markers = [];
  return {
    markers,
    date: null,
    failMark: 0,
    async findDeliveredToday(date) {
      this.date = date;
      return list;
    },
    async productNames(ids) {
      return Object.fromEntries(ids.map((id) => [id, 'Demo Study Table, Demo Study Chair']));
    },
    async withOpenRequests() {
      return new Set(open);
    },
    async alreadyCalled() {
      return new Set([...called, ...markers.map((m) => m.orderId)]);
    },
    async markCalled(marker) {
      if (this.failMark > 0) {
        this.failMark -= 1;
        throw new Error('Salesforce request failed (503)');
      }
      markers.push({ ...marker, callsBefore: sarvam.started.length });
      return `00T${markers.length}`;
    },
  };
}

function setup(list, { called, open, serviceOpen = true, serviceHoursOnly = false, maxPerRun = 20, canStartCalls = true, jobs = [] } = {}) {
  const sarvam = createFakeSarvam({ canStartCalls });
  const orders = fakeOrders(list, sarvam, { called, open });
  const store = createMemoryJobStore();
  for (const job of jobs) store.create(job);
  const scheduler = createScheduler({ store, handlers: {}, now: () => NOW, logger: quiet });
  const crm = { getServiceHours: async () => ({ open: serviceOpen, opensAt: serviceOpen ? null : new Date('2026-10-23T03:30:00Z') }) };
  const config = testConfig({ deliveryCalls: { maxPerRun, serviceHoursOnly } });
  const deliveryCalls = createDeliveryCalls({ orders, crm, sarvam, scheduler, config, now: () => NOW, logger: quiet });
  return { orders, sarvam, deliveryCalls };
}

test('only an Indian mobile number is called; the mobile comes before the other phone', () => {
  assert.equal(mobileToCall({ mobile: '(987) 654-3210', phone: '+91 98200 11111' }), '+919876543210');
  assert.equal(mobileToCall({ mobile: null, phone: '+91 98200 11111' }), '+919820011111');
  assert.equal(mobileToCall({ mobile: '011 2345 6789', phone: null }), null, 'a landline is not called');
  assert.equal(mobileToCall({ mobile: '+1 415 555 0100', phone: null }), null);
  assert.equal(mobileToCall(null), null);
});

test('an order delivered today is called once, without waiting, and marked as called after the call', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1001', { lastModified: '2026-10-22T06:00:00.000+0000' })]);
  const result = await deliveryCalls.run();

  assert.equal(orders.date, '2026-10-22', 'only orders delivered today are fetched');
  assert.deepEqual(result.placed, [{ order: 'TD-ORD-1001', attemptId: 'attempt-1' }]);
  assert.deepEqual(result.failed, []);
  const [call] = sarvam.started;
  assert.equal(call.phone, '+919876543210');
  const opening = 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। आपकी हाल की डिलीवरी के बारे में कॉल किया है। क्या मेरी बात Aarav Sharma जी से हो रही है?';
  assert.deepEqual(call.variables, {
    customer_name: 'Aarav Sharma',
    customer_phone: '+919876543210',
    order_number: 'TD-ORD-1001',
    product_name: 'Demo Study Table, Demo Study Chair',
    delivery_date: 'Thursday, 22 October',
    delivery_city: 'Delhi',
    call_reason: 'delivery_check',
    opening_line: opening,
  });
  assert.deepEqual(call.overrides, { initial_bot_message: opening, initial_language_name: 'Hindi' }, 'the agent greets with opening_line in Hindi');
  assert.equal(call.webhook.metadata.identifier, 'order:1001', 'the call log lands on the order');
  assert.deepEqual(orders.markers, [{ orderId: '1001', contactId: '003A', attemptId: 'attempt-1', callsBefore: 1 }]);

  const again = await deliveryCalls.run();
  assert.deepEqual(again.placed, []);
  assert.deepEqual(again.skipped, { already_called: ['TD-ORD-1001'] });
  assert.equal(sarvam.started.length, 1, 'the next run does not call the same order again');
});

test('orders that break a rule are skipped with the reason', async () => {
  const { sarvam, deliveryCalls } = setup(
    [
      order('1', { deliveryStatus: 'Shipped' }),
      ownCustomer('2', { lastModified: '2026-10-22T05:59:00.000+0000' }),
      order('3', { customer: null }),
      order('4', { customer: { id: '003D', name: 'Landline Only', mobile: null, phone: '011 2345 6789' } }),
      order('5'),
      order('6'),
      order('7'),
      order('8'),
    ],
    {
      called: ['5'],
      open: ['6'],
      jobs: [{ id: 'delivery_followup:7', type: 'delivery_followup', status: 'pending', payload: { orderId: '7' } }],
    },
  );
  const result = await deliveryCalls.run();
  assert.deepEqual(result.skipped, {
    not_delivered: ['TD-ORD-1'],
    no_phone: ['TD-ORD-3', 'TD-ORD-4'],
    already_called: ['TD-ORD-5'],
    open_request: ['TD-ORD-6'],
    followup_scheduled: ['TD-ORD-7'],
  });
  assert.deepEqual(result.placed.map((p) => p.order), ['TD-ORD-2', 'TD-ORD-8'], 'an order marked Delivered a minute ago is called too');
  assert.equal(sarvam.started.length, 2);
});

test('a run places all its calls at once, one to each number; a second order of the same customer is called next run', async () => {
  const { orders, sarvam, deliveryCalls } = setup([ownCustomer('1'), ownCustomer('2'), ownCustomer('3'), order('4'), order('5')]);
  const start = sarvam.startCall.bind(sarvam);
  let inFlight = 0;
  let most = 0;
  sarvam.startCall = async (call) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    inFlight -= 1;
    return start(call);
  };

  const first = await deliveryCalls.run();
  assert.equal(most, 4, 'every call is requested before the first one is answered');
  assert.deepEqual(first.placed.map((p) => p.order), ['TD-ORD-1', 'TD-ORD-2', 'TD-ORD-3', 'TD-ORD-4']);
  assert.deepEqual(first.deferred, ['TD-ORD-5'], 'orders 4 and 5 go to the same mobile');
  assert.deepEqual(orders.markers.map((m) => m.orderId).sort(), ['1', '2', '3', '4']);

  const second = await deliveryCalls.run();
  assert.deepEqual(second.placed.map((p) => p.order), ['TD-ORD-5']);
  assert.deepEqual(second.deferred, []);
  assert.equal(sarvam.started.length, 5);
});

test('calls go out outside service hours too, unless DELIVERY_CALLS_SERVICE_HOURS_ONLY is set', async () => {
  const anyTime = setup([order('1001')], { serviceOpen: false });
  const result = await anyTime.deliveryCalls.run();
  assert.equal(result.serviceOpen, false);
  assert.deepEqual(result.placed.map((p) => p.order), ['TD-ORD-1001']);

  const hoursOnly = setup([order('1001')], { serviceOpen: false, serviceHoursOnly: true });
  const held = await hoursOnly.deliveryCalls.run();
  assert.equal(held.skipped, 'outside_service_hours');
  assert.equal(held.opensAt.toISOString(), '2026-10-23T03:30:00.000Z');
  assert.equal(hoursOnly.orders.date, null, 'Salesforce is not even searched');
  assert.equal(hoursOnly.sarvam.started.length, 0);
});

test('a run places at most the configured number of calls and leaves the rest for the next run', async () => {
  const { sarvam, deliveryCalls } = setup([ownCustomer('1'), ownCustomer('2'), ownCustomer('3')], { maxPerRun: 2 });
  const first = await deliveryCalls.run();
  assert.deepEqual(first.placed.map((p) => p.order), ['TD-ORD-1', 'TD-ORD-2']);
  assert.deepEqual(first.deferred, ['TD-ORD-3']);
  const second = await deliveryCalls.run();
  assert.deepEqual(second.placed.map((p) => p.order), ['TD-ORD-3']);
  assert.equal(sarvam.started.length, 3);
});

test('a call Sarvam refuses is not marked and is tried again; one with no answer is marked and is not', async () => {
  const refused = setup([order('1001')]);
  refused.sarvam.failNext = 1;
  const first = await refused.deliveryCalls.run();
  assert.deepEqual(first.failed, [{ order: 'TD-ORD-1001', error: 'Sarvam unavailable' }]);
  assert.deepEqual(refused.orders.markers, []);
  const retry = await refused.deliveryCalls.run();
  assert.deepEqual(retry.placed.map((p) => p.order), ['TD-ORD-1001']);

  const lost = setup([order('1002')]);
  lost.sarvam.startCall = async () => { throw new TypeError('fetch failed'); };
  await lost.deliveryCalls.run();
  assert.deepEqual(lost.orders.markers, [{ orderId: '1002', contactId: '003A', attemptId: null, callsBefore: 0 }], 'the call may have gone out');
  const next = await lost.deliveryCalls.run();
  assert.deepEqual(next.skipped, { already_called: ['TD-ORD-1002'] });
});

test('when the marker cannot be saved after a call, the call still counts and is not placed again', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1001')]);
  orders.failMark = 1;
  const result = await deliveryCalls.run();
  assert.deepEqual(result.placed, [{ order: 'TD-ORD-1001', attemptId: 'attempt-1', markerError: 'Salesforce request failed (503)' }]);
  assert.deepEqual(orders.markers, []);
  const again = await deliveryCalls.run();
  assert.deepEqual(again.skipped, { already_called: ['TD-ORD-1001'] });
  assert.equal(sarvam.started.length, 1);
});

test('a dry run lists who would be called and calls nobody, even outside service hours', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1'), order('2', { customer: null })], { serviceOpen: false });
  const result = await deliveryCalls.run({ dryRun: true });
  assert.deepEqual(result.wouldCall, ['TD-ORD-1']);
  assert.deepEqual(result.skipped, { no_phone: ['TD-ORD-2'] });
  assert.equal(result.serviceOpen, false);
  assert.equal(sarvam.started.length, 0);
  assert.deepEqual(orders.markers, []);
});

test('without instant call settings a real run is refused with a 503; a dry run still works', async () => {
  const { deliveryCalls } = setup([order('1')], { canStartCalls: false });
  await assert.rejects(deliveryCalls.run(), (err) => err.status === 503 && /SARVAM_AGENT_PHONE/.test(err.message));
  assert.deepEqual((await deliveryCalls.run({ dryRun: true })).wouldCall, ['TD-ORD-1']);
});

test('/cron/run is open to anyone, at most once a second', async (t) => {
  const runs = [];
  const clock = { now: NOW };
  const deliveryCalls = { run: async (options) => { runs.push(options); return { placed: [] }; } };
  const app = createApp({
    crm: createFakeCrm(),
    sarvam: createFakeSarvam(),
    scheduler: createScheduler({ store: createMemoryJobStore(), handlers: {}, logger: quiet }),
    config: testConfig(),
    now: () => clock.now,
    logger: quiet,
    deliveryCalls,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (method, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });

  assert.equal((await call('GET', '/cron/run')).status, 200, 'no key is needed');
  const early = await call('GET', '/cron/run');
  assert.equal(early.status, 429);
  assert.equal(early.headers.get('retry-after'), '1');
  assert.deepEqual(await early.json(), { error: 'too_soon', retryAfterSeconds: 1 });

  clock.now += 1000;
  assert.equal((await call('POST', '/cron/run?dryRun=true')).status, 200);
  assert.deepEqual(runs, [{ dryRun: false }, { dryRun: true }]);
});

test('Salesforce: delivered orders come with the authorising contact, else the account contact with a number', async () => {
  const queries = [];
  const created = [];
  const salesforce = {
    async query(soql) {
      queries.push(soql);
      if (soql.includes('FROM Order ')) {
        return [
          { Id: '801A', OrderNumber: '00000101', ERP_Order_Id__c: 'TD-ORD-1001', Delivery_Status__c: 'Delivered', Delivery_Date__c: '2026-10-22', LastModifiedDate: '2026-10-22T04:00:00.000+0000', AccountId: '001A', ShippingCity: 'Delhi', CustomerAuthorizedById: '003A', CustomerAuthorizedBy: { FirstName: 'Aarav', LastName: 'Sharma', MobilePhone: '9876543210', Phone: null } },
          { Id: '801B', OrderNumber: '00000102', ERP_Order_Id__c: null, Delivery_Status__c: 'Delivered', Delivery_Date__c: '2026-10-22', LastModifiedDate: '2026-10-22T03:00:00.000+0000', AccountId: '001B', ShippingCity: 'Jaipur', CustomerAuthorizedById: '003X', CustomerAuthorizedBy: { FirstName: 'No', LastName: 'Number', MobilePhone: null, Phone: null } },
        ];
      }
      if (soql.includes('FROM Contact ')) {
        return [
          { Id: '003B', FirstName: 'Meera', LastName: 'Iyer', AccountId: '001B', MobilePhone: null, Phone: '+91 98200 11111' },
          { Id: '003C', FirstName: 'Later', LastName: 'Contact', AccountId: '001B', MobilePhone: '9000000000', Phone: null },
        ];
      }
      if (soql.includes('FROM OrderItem ')) return [{ OrderId: '801A', Product2: { Name: 'Demo Study Table' } }, { OrderId: '801A', Product2: { Name: 'Demo Study Chair' } }];
      if (soql.includes('FROM Case ')) {
        return [
          { Order__c: '801A', Service_Type__c: 'Installation', Service_Sub_Type__c: 'Initial Installation' },
          { Order__c: '801B', Service_Type__c: 'General Query', Service_Sub_Type__c: null },
        ];
      }
      if (soql.includes('FROM Task ')) return [{ WhatId: '801B' }];
      return [];
    },
    async create(sobject, fields) {
      created.push({ sobject, fields });
      return { id: `00T${created.length}` };
    },
  };
  const data = createDeliveredOrders({ salesforce, now: () => NOW });

  const found = await data.findDeliveredToday('2026-10-22');
  assert.match(
    queries[0],
    /Delivery_Status__c = 'Delivered' AND \(Delivery_Date__c = 2026-10-22 OR \(Delivery_Date__c = 2026-10-21 AND LastModifiedDate >= 2026-10-21T18:30:00Z\)\)/,
    'delivered today, or dated yesterday and marked Delivered today (from midnight in India)',
  );
  assert.match(queries[1], /AccountId IN \('001B'\)/, 'only accounts without an authorising contact number are searched');
  assert.deepEqual(found.map((o) => o.customer), [
    { id: '003A', name: 'Aarav Sharma', mobile: '9876543210', phone: null },
    { id: '003B', name: 'Meera Iyer', mobile: null, phone: '+91 98200 11111' },
  ]);

  assert.deepEqual(await data.productNames(['801A', '801B']), { '801A': 'Demo Study Table, Demo Study Chair' });
  assert.deepEqual([...await data.withOpenRequests(['801A', '801B'])], ['801A'], 'a general query does not block the call');
  assert.deepEqual([...await data.alreadyCalled(['801A', '801B'])], ['801B']);
  assert.match(queries.at(-1), new RegExp(`Subject = '${CALL_MARKER_SUBJECT}'`));

  assert.equal(await data.markCalled({ orderId: '801A', contactId: '003A', attemptId: 'att-9' }), '00T1');
  assert.equal(created[0].sobject, 'Task');
  assert.deepEqual(
    { ...created[0].fields, Description: undefined },
    { Subject: CALL_MARKER_SUBJECT, WhatId: '801A', WhoId: '003A', Status: 'Completed', Priority: 'Normal', ActivityDate: '2026-10-22', Description: undefined },
  );
  assert.match(created[0].fields.Description, /Sarvam call attempt: att-9\./);
  await data.markCalled({ orderId: '801B', contactId: null, attemptId: null });
  assert.equal(created[1].fields.WhoId, undefined);
  assert.match(created[1].fields.Description, /may not have gone out/);

  const before = queries.length;
  assert.deepEqual([...await data.alreadyCalled([])], []);
  assert.equal(queries.length, before, 'no query for an empty list');
});
