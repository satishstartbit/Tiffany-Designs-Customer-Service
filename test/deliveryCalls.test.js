const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryCalls, deliveredAt, mobileToCall } = require('../src/deliveryCalls');
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
    // Saved as delivered two hours ago.
    lastModified: '2026-10-22T04:00:00.000+0000',
    city: 'Delhi',
    customer: { id: '003A', name: 'Aarav Sharma', mobile: '98765 43210', phone: null },
    ...overrides,
  };
}

function fakeOrders(list, { called = [], open = [] } = {}) {
  const markers = new Map();
  let count = 0;
  return {
    markers,
    since: null,
    async findDelivered(since) {
      this.since = since;
      return list;
    },
    async productNames(ids) {
      return Object.fromEntries(ids.map((id) => [id, 'Demo Study Table, Demo Study Chair']));
    },
    async withOpenRequests() {
      return new Set(open);
    },
    async alreadyCalled() {
      return new Set([...called, ...[...markers.values()].map((m) => m.orderId)]);
    },
    async markCalled(marker) {
      count += 1;
      markers.set(`00T${count}`, marker);
      return `00T${count}`;
    },
    async unmark(id) {
      markers.delete(id);
    },
  };
}

function setup(list, { called, open, serviceOpen = true, maxPerRun = 5, canStartCalls = true, jobs = [] } = {}) {
  const orders = fakeOrders(list, { called, open });
  const sarvam = createFakeSarvam({ canStartCalls });
  const store = createMemoryJobStore();
  for (const job of jobs) store.create(job);
  const scheduler = createScheduler({ store, handlers: {}, now: () => NOW, logger: quiet });
  const crm = { getServiceHours: async () => ({ open: serviceOpen, opensAt: serviceOpen ? null : new Date('2026-10-23T03:30:00Z') }) };
  const config = testConfig({ deliveryCalls: { delayMinutes: 60, lookbackDays: 3, maxPerRun } });
  const deliveryCalls = createDeliveryCalls({ orders, crm, sarvam, scheduler, config, now: () => NOW, logger: quiet });
  return { orders, sarvam, deliveryCalls };
}

test('the delivery time is the later of the start of the delivery day in India and the last save', () => {
  assert.equal(deliveredAt(order('1')), Date.parse('2026-10-22T04:00:00Z'));
  assert.equal(
    deliveredAt(order('1', { deliveryDate: '2026-10-23', lastModified: '2026-10-22T04:00:00.000+0000' })),
    Date.parse('2026-10-22T18:30:00Z'),
    'a delivery date ahead of the last save counts from midnight that day',
  );
  assert.equal(deliveredAt(order('1', { deliveryDate: null, lastModified: null })), null);
});

test('only an Indian mobile number is called; the mobile comes before the other phone', () => {
  assert.equal(mobileToCall({ mobile: '(987) 654-3210', phone: '+91 98200 11111' }), '+919876543210');
  assert.equal(mobileToCall({ mobile: null, phone: '+91 98200 11111' }), '+919820011111');
  assert.equal(mobileToCall({ mobile: '011 2345 6789', phone: null }), null, 'a landline is not called');
  assert.equal(mobileToCall({ mobile: '+1 415 555 0100', phone: null }), null);
  assert.equal(mobileToCall(null), null);
});

test('a delivered order is called once, an hour after delivery, with the customer, order and products', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1001')]);
  const result = await deliveryCalls.run();

  assert.equal(orders.since, '2026-10-19', 'orders delivered more than three days ago are not fetched');
  assert.deepEqual(result.placed, [{ order: 'TD-ORD-1001', attemptId: 'attempt-1' }]);
  assert.deepEqual(result.failed, []);
  const [call] = sarvam.started;
  assert.equal(call.phone, '+919876543210');
  assert.deepEqual(call.variables, {
    customer_name: 'Aarav Sharma',
    customer_phone: '+919876543210',
    order_number: 'TD-ORD-1001',
    product_name: 'Demo Study Table, Demo Study Chair',
    delivery_city: 'Delhi',
    call_reason: 'delivery_check',
  });
  assert.match(call.overrides.initial_bot_message, /Am I speaking with Aarav Sharma\?$/);
  assert.equal(call.webhook.metadata.identifier, 'order:1001', 'the call log lands on the order');
  assert.deepEqual([...orders.markers.values()], [{ orderId: '1001', contactId: '003A' }]);

  const again = await deliveryCalls.run();
  assert.deepEqual(again.placed, []);
  assert.deepEqual(again.skipped, { already_called: ['TD-ORD-1001'] });
  assert.equal(sarvam.started.length, 1, 'the next run does not call the same order again');
});

test('orders that break a rule are skipped with the reason', async () => {
  const { sarvam, deliveryCalls } = setup(
    [
      order('1', { deliveryStatus: 'Shipped' }),
      order('2', { lastModified: '2026-10-22T05:30:00.000+0000' }),
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
    too_soon: ['TD-ORD-2'],
    no_phone: ['TD-ORD-3', 'TD-ORD-4'],
    already_called: ['TD-ORD-5'],
    open_request: ['TD-ORD-6'],
    followup_scheduled: ['TD-ORD-7'],
  });
  assert.deepEqual(result.placed.map((p) => p.order), ['TD-ORD-8']);
  assert.equal(sarvam.started.length, 1);
});

test('nobody is called outside service hours', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1001')], { serviceOpen: false });
  const result = await deliveryCalls.run();
  assert.equal(result.skipped, 'outside_service_hours');
  assert.equal(result.opensAt.toISOString(), '2026-10-23T03:30:00.000Z');
  assert.equal(orders.since, null, 'Salesforce is not even searched');
  assert.equal(sarvam.started.length, 0);
});

test('a run places at most the configured number of calls and leaves the rest for the next run', async () => {
  const { sarvam, deliveryCalls } = setup([order('1'), order('2'), order('3')], { maxPerRun: 2 });
  const first = await deliveryCalls.run();
  assert.deepEqual(first.placed.map((p) => p.order), ['TD-ORD-1', 'TD-ORD-2']);
  assert.equal(first.deferred, 1);
  const second = await deliveryCalls.run();
  assert.deepEqual(second.placed.map((p) => p.order), ['TD-ORD-3']);
  assert.equal(sarvam.started.length, 3);
});

test('a call Sarvam refuses is tried again on the next run; one with no answer is not', async () => {
  const refused = setup([order('1001')]);
  refused.sarvam.failNext = 1;
  const first = await refused.deliveryCalls.run();
  assert.deepEqual(first.failed, [{ order: 'TD-ORD-1001', error: 'Sarvam unavailable' }]);
  assert.equal(refused.orders.markers.size, 0, 'the marker is removed');
  const retry = await refused.deliveryCalls.run();
  assert.deepEqual(retry.placed.map((p) => p.order), ['TD-ORD-1001']);

  const lost = setup([order('1002')]);
  lost.sarvam.startCall = async () => { throw new TypeError('fetch failed'); };
  await lost.deliveryCalls.run();
  assert.equal(lost.orders.markers.size, 1, 'the call may have gone out, so the marker stays');
  const next = await lost.deliveryCalls.run();
  assert.deepEqual(next.skipped, { already_called: ['TD-ORD-1002'] });
});

test('a dry run lists who would be called and calls nobody, even outside service hours', async () => {
  const { orders, sarvam, deliveryCalls } = setup([order('1'), order('2', { customer: null })], { serviceOpen: false });
  const result = await deliveryCalls.run({ dryRun: true });
  assert.deepEqual(result.wouldCall, ['TD-ORD-1']);
  assert.deepEqual(result.skipped, { no_phone: ['TD-ORD-2'] });
  assert.equal(result.serviceOpen, false);
  assert.equal(sarvam.started.length, 0);
  assert.equal(orders.markers.size, 0);
});

test('without instant call settings a real run is refused with a 503; a dry run still works', async () => {
  const { deliveryCalls } = setup([order('1')], { canStartCalls: false });
  await assert.rejects(deliveryCalls.run(), (err) => err.status === 503 && /SARVAM_AGENT_PHONE/.test(err.message));
  assert.deepEqual((await deliveryCalls.run({ dryRun: true })).wouldCall, ['TD-ORD-1']);
});

test('/cron/run is open to anyone, at most once every two minutes', async (t) => {
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
  assert.equal(early.headers.get('retry-after'), '120');
  assert.deepEqual(await early.json(), { error: 'too_soon', retryAfterSeconds: 120 });

  clock.now += 2 * 60 * 1000;
  assert.equal((await call('POST', '/cron/run?dryRun=true')).status, 200);
  assert.deepEqual(runs, [{ dryRun: false }, { dryRun: true }]);
});

test('Salesforce: delivered orders come with the authorising contact, else the account contact with a number', async () => {
  const queries = [];
  const created = [];
  const removed = [];
  const salesforce = {
    async query(soql) {
      queries.push(soql);
      if (soql.includes('FROM Order ')) {
        return [
          { Id: '801A', OrderNumber: '00000101', ERP_Order_Id__c: 'TD-ORD-1001', Delivery_Status__c: 'Delivered', Delivery_Date__c: '2026-10-22', LastModifiedDate: '2026-10-22T04:00:00.000+0000', AccountId: '001A', ShippingCity: 'Delhi', CustomerAuthorizedById: '003A', CustomerAuthorizedBy: { FirstName: 'Aarav', LastName: 'Sharma', MobilePhone: '9876543210', Phone: null } },
          { Id: '801B', OrderNumber: '00000102', ERP_Order_Id__c: null, Delivery_Status__c: 'Delivered', Delivery_Date__c: '2026-10-21', LastModifiedDate: '2026-10-21T09:00:00.000+0000', AccountId: '001B', ShippingCity: 'Jaipur', CustomerAuthorizedById: '003X', CustomerAuthorizedBy: { FirstName: 'No', LastName: 'Number', MobilePhone: null, Phone: null } },
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
      return { id: '00T1' };
    },
    async remove(sobject, id) {
      removed.push({ sobject, id });
    },
  };
  const data = createDeliveredOrders({ salesforce, now: () => NOW });

  const found = await data.findDelivered('2026-10-19');
  assert.match(queries[0], /Delivery_Status__c = 'Delivered' AND Delivery_Date__c >= 2026-10-19/);
  assert.match(queries[1], /AccountId IN \('001B'\)/, 'only accounts without an authorising contact number are searched');
  assert.deepEqual(found.map((o) => o.customer), [
    { id: '003A', name: 'Aarav Sharma', mobile: '9876543210', phone: null },
    { id: '003B', name: 'Meera Iyer', mobile: null, phone: '+91 98200 11111' },
  ]);

  assert.deepEqual(await data.productNames(['801A', '801B']), { '801A': 'Demo Study Table, Demo Study Chair' });
  assert.deepEqual([...await data.withOpenRequests(['801A', '801B'])], ['801A'], 'a general query does not block the call');
  assert.deepEqual([...await data.alreadyCalled(['801A', '801B'])], ['801B']);
  assert.match(queries.at(-1), new RegExp(`Subject = '${CALL_MARKER_SUBJECT}'`));

  assert.equal(await data.markCalled({ orderId: '801A', contactId: '003A' }), '00T1');
  assert.equal(created[0].sobject, 'Task');
  assert.deepEqual(
    { ...created[0].fields, Description: undefined },
    { Subject: CALL_MARKER_SUBJECT, WhatId: '801A', WhoId: '003A', Status: 'Completed', Priority: 'Normal', ActivityDate: '2026-10-22', Description: undefined },
  );
  await data.unmark('00T1');
  assert.deepEqual(removed, [{ sobject: 'Task', id: '00T1' }]);

  const before = queries.length;
  assert.deepEqual([...await data.alreadyCalled([])], []);
  assert.equal(queries.length, before, 'no query for an empty list');
});
