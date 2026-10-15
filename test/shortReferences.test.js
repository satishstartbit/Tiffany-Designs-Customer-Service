// Callers often say only the number at the end of an order id or invoice number: "1009" for TD-ORD-1009, "009" for
// INV-009. src/rules.js decides what matches; /api/agent/order-lookup finds the order or asks for more.
const test = require('node:test');
const assert = require('node:assert/strict');
const { trailingNumber, sameReference, joinDigits } = require('../src/rules');
const { startTestServer } = require('./helpers');

test('the number at the end of an id, without leading zeros', () => {
  assert.equal(trailingNumber('TD-ORD-1009'), 1009);
  assert.equal(trailingNumber('INV-009'), 9);
  assert.equal(trailingNumber('1 0 0 9'), 1009, 'said digit by digit');
  assert.equal(trailingNumber('order number 120'), 120);
  assert.equal(trailingNumber('TD-ORD-1009-A'), 1009);
  assert.equal(trailingNumber('no digits'), null);
  assert.equal(joinDigits(' 1 0 0 9 '), '1009');
});

test('what a caller says names an id when it is the id, or ends in its number with no other letters', () => {
  for (const said of ['TD-ORD-1009', 'td ord 1009', '1009', '1 0 0 9', 'ORD 1009', 'TD 1009', 'order number 1009', 'my order id is 1009']) {
    assert.equal(sameReference(said, 'TD-ORD-1009'), true, said);
  }
  for (const said of ['009', '9', 'INV 009', 'invoice 009', 'inv-9']) {
    assert.equal(sameReference(said, 'INV-009'), true, said);
  }
  assert.equal(sameReference('INV 1009', 'TD-ORD-1009'), false, 'letters of another kind of id');
  assert.equal(sameReference('100', 'TD-ORD-1009'), false, 'a different number');
  assert.equal(sameReference('10090', 'TD-ORD-1009'), false);
  assert.equal(sameReference('9876543210', 'INV-2001'), false, 'a mobile number is not an invoice number');
  assert.equal(sameReference('', 'INV-009'), false);
  assert.equal(sameReference('009', null), false);
});

test('find_order finds an order from the short number and an invoice from its digits', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const lookup = (body) => s.call('POST', '/api/agent/order-lookup', { body, headers: s.agent }).then((r) => r.body);

  assert.equal((await lookup({ order_number: '1111' })).order_id, 'TD-ORD-1111', 'the number at the end of the order id');
  assert.equal((await lookup({ order_id: '1 1 1 1' })).order_id, 'TD-ORD-1111');
  assert.equal((await lookup({ order_id: 'ORD 1008' })).order_id, 'TD-ORD-1008');
  assert.equal((await lookup({ order_number: '122' })).order_number, '00000122', 'a phone order by its order number');
  assert.equal((await lookup({ invoice_number: '1111' })).order_id, 'TD-ORD-1111', 'an invoice number by its digits');
  assert.equal((await lookup({ order_number: '2001' })).order_id, 'TD-ORD-1001', 'digits that name no order are tried as an invoice number');

  const shared = await lookup({ invoice_number: '7777' });
  assert.equal(shared.found, false);
  assert.match(shared.message, /More than one order has this invoice number/);
  assert.equal((await lookup({ invoice_number: '7777', phone: '9876543210' })).found, false, 'the caller is not on either order');

  assert.equal((await lookup({ order_number: '5555' })).found, false);
});

test('when a short number matches several orders, the agent is asked to get the full id or the invoice number', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const two = [
    { id: '801X', erpOrderId: 'TD-ORD-1009', accountId: '001A', accountName: 'Aarav Sharma' },
    { id: '801Y', erpOrderId: 'WEB-1009', accountId: '001B', accountName: 'Meera Iyer' },
  ];
  s.crm.findOrdersByReference = async () => two;
  s.crm.getOrderById = async (id) => ({ ...two.find((o) => o.id === id), orderNumber: '00000199', deliveryStatus: 'Shipped', productSummary: 'Demo Desk' });

  const ambiguous = await s.call('POST', '/api/agent/order-lookup', { body: { order_number: '1009' }, headers: s.agent });
  assert.equal(ambiguous.body.found, false);
  assert.equal(ambiguous.body.message, 'More than one order ends in these digits. Ask for the full order id or the invoice number.');

  const mine = await s.call('POST', '/api/agent/order-lookup', { body: { order_number: '1009', phone: '9876543210' }, headers: s.agent });
  assert.equal(mine.body.order_id, 'TD-ORD-1009', 'the caller\'s mobile picks their order');
});

test('the request status check accepts the short order id too', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const ask = (orderId) => s.call('POST', '/api/agent/case-status', { body: { case_number: '1063', order_id: orderId }, headers: s.agent }).then((r) => r.body);
  assert.equal((await ask('TD-ORD-1001')).found, true);
  assert.equal((await ask('1001')).found, true, 'the number at the end of the order id');
  assert.equal((await ask('1002')).found, false, 'another order does not unlock the request');
});
