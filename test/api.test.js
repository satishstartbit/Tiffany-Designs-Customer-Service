const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, testConfig, createFakeCrm } = require('./helpers');

const HOUR = 60 * 60 * 1000;

test('liveness is public; the Salesforce check needs the internal key', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  assert.equal((await s.call('GET', '/health')).status, 200);
  assert.equal((await s.call('GET', '/health/salesforce')).status, 401, 'each check spends a Salesforce API call');
  const sf = await s.call('GET', '/health/salesforce', { headers: s.internal });
  assert.equal(sf.status, 200);
  assert.equal(sf.body.status, 'ok');
});

test('protected routes reject missing or wrong secrets', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  assert.equal((await s.call('POST', '/api/orders/delivered', { body: {} })).status, 401);
  assert.equal((await s.call('POST', '/api/orders/delivered', { body: {}, headers: { 'x-api-key': 'wrong' } })).status, 401);
  assert.equal((await s.call('POST', '/api/agent/cases', { body: {}, headers: s.internal })).status, 401, 'internal key is not an agent secret');
  assert.equal((await s.call('POST', '/api/webhooks/sarvam?token=nope', { body: {} })).status, 401);
});

test('routes report a missing server secret instead of allowing access', async (t) => {
  const s = await startTestServer({ config: testConfig({ internalApiKey: '' }) });
  t.after(s.close);
  const res = await s.call('POST', '/api/orders/delivered', { body: {}, headers: { 'x-api-key': '' } });
  assert.equal(res.status, 503);
});

test('invalid JSON gets a 400', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const res = await s.call('POST', '/api/orders/delivered', { body: '{bad', headers: s.internal });
  assert.equal(res.status, 400);
});

test.describe('delivery follow-up scheduling', () => {
  test('a delivered order schedules the agent call one hour after delivery', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const deliveredAt = '2026-10-14T06:00:00.000Z';

    const res = await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A', deliveredAt }, headers: s.internal });
    assert.equal(res.status, 202);
    assert.equal(res.body.jobId, 'delivery_followup:801A');
    assert.equal(res.body.runAt, new Date(Date.parse(deliveredAt) + HOUR).toISOString());
    assert.equal(res.body.alreadyScheduled, false);
  });

  test('the same delivery event twice does not schedule a second call', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const body = { erpOrderId: 'TD-ORD-1001', deliveredAt: '2026-10-14T06:00:00Z' };
    await s.call('POST', '/api/orders/delivered', { body, headers: s.internal });
    const again = await s.call('POST', '/api/orders/delivered', { body, headers: s.internal });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyScheduled, true);
    assert.equal((await s.scheduler.list()).length, 1);
  });

  test('the call is placed only after the hour has passed, with the order details', async (t) => {
    const s = await startTestServer({ nowMs: Date.parse('2026-10-14T06:00:00Z') });
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A' }, headers: s.internal });

    s.clock.now += 59 * 60 * 1000;
    await s.scheduler.tick();
    assert.equal(s.sarvam.calls.length, 0);

    s.clock.now += 60 * 1000;
    await s.scheduler.tick();
    assert.equal(s.sarvam.calls.length, 1);
    const [{ campaignId, label, users }] = s.sarvam.calls;
    assert.equal(campaignId, 'camp-followup');
    assert.equal(label, 'followup-TD-ORD-1001');
    assert.deepEqual(users, [{
      phone: '+919876543210',
      identifier: 'order:801A',
      variables: {
        customer_name: 'Aarav Sharma',
        customer_phone: '+919876543210',
        order_number: 'TD-ORD-1001',
        product_name: 'Demo 3-Door Wardrobe',
        delivery_city: 'Delhi',
        call_reason: 'delivery_followup',
        opening_line: 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। क्या मेरी बात Aarav Sharma जी से हो रही है?',
      },
      overrides: {
        initial_bot_message: 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। क्या मेरी बात Aarav Sharma जी से हो रही है?',
        initial_language_name: 'Hindi',
      },
    }]);
  });

  test('a Sarvam failure is retried on the next run', async (t) => {
    const s = await startTestServer({ nowMs: Date.parse('2026-10-14T06:00:00Z') });
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A' }, headers: s.internal });
    s.sarvam.failNext = 1;

    s.clock.now += HOUR;
    await s.scheduler.tick();
    assert.equal(s.sarvam.calls.length, 0);
    assert.equal((await s.scheduler.list())[0].status, 'pending');

    s.clock.now += 5 * 60 * 1000;
    await s.scheduler.tick();
    assert.equal(s.sarvam.calls.length, 1);
    assert.equal((await s.scheduler.list())[0].status, 'done');
  });

  test('a scheduled follow-up can be cancelled', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A' }, headers: s.internal });
    const res = await s.call('DELETE', '/api/orders/delivered/801A', { headers: s.internal });
    assert.equal(res.body.cancelled, true);
    s.clock.now += 2 * HOUR;
    await s.scheduler.tick();
    assert.equal(s.sarvam.calls.length, 0);
  });

  test('an order that is not delivered is refused', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/orders/delivered', { body: { erpOrderId: 'TD-ORD-1111' }, headers: s.internal });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Processing/);
    assert.equal((await s.scheduler.list()).length, 0);
  });

  test('bad delivery events are rejected with a reason', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await s.call('POST', '/api/orders/delivered', { body: {}, headers: s.internal })).status, 400);
    assert.equal((await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A', deliveredAt: 'yesterday' }, headers: s.internal })).status, 400);
    assert.equal((await s.call('POST', '/api/orders/delivered', { body: { orderId: 'nope' }, headers: s.internal })).status, 404);
    const noPhone = await s.call('POST', '/api/orders/delivered', { body: { orderId: '801C' }, headers: s.internal });
    assert.equal(noPhone.status, 422);
  });

  test('a phone number sent by Salesforce overrides the contact lookup', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801C', phone: '9123456789', customerName: 'Walk-in' }, headers: s.internal });
    assert.equal((await s.scheduler.list())[0].payload.phone, '+919123456789');
    assert.equal((await s.scheduler.list())[0].payload.customerName, 'Walk-in');
  });

  test('scheduled jobs can be listed', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A' }, headers: s.internal });
    const res = await s.call('GET', '/api/jobs', { headers: s.internal });
    assert.equal(res.body.jobs.length, 1);
  });

  test('the cron endpoint places due calls and needs the cron secret', async (t) => {
    const s = await startTestServer({ nowMs: Date.parse('2026-10-14T06:00:00Z') });
    t.after(s.close);
    await s.call('POST', '/api/orders/delivered', { body: { orderId: '801A' }, headers: s.internal });

    assert.equal((await s.call('GET', '/api/cron/jobs')).status, 401);
    assert.equal((await s.call('GET', '/api/cron/jobs', { headers: s.internal })).status, 401, 'the internal key is not the cron secret');

    const early = await s.call('GET', '/api/cron/jobs', { headers: s.cron });
    assert.deepEqual(early.body, { due: 0, done: 0, failed: 0 });

    s.clock.now += HOUR;
    const res = await s.call('GET', '/api/cron/jobs', { headers: s.cron });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { due: 1, done: 1, failed: 0 });
    assert.equal(s.sarvam.calls.length, 1);
  });

  test('the cron endpoint is closed until CRON_SECRET is set', async (t) => {
    const s = await startTestServer({ config: testConfig({ cronSecret: '' }) });
    t.after(s.close);
    assert.equal((await s.call('GET', '/api/cron/jobs', { headers: { authorization: 'Bearer ' } })).status, 503);
  });
});

test.describe('customer callback requests (website "call me" panel)', () => {
  const request = (s, body, headers = s.site) => s.call('POST', '/api/calls/request', { body, headers });

  test('a consented request from the website starts a call now', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await request(s, { phone: '098765 43210', consent: true, name: 'Aarav', orderNumber: 'TD-ORD-1001', recordId: '003gK000015ycGjQAI', source: 'website' });
    assert.equal(res.status, 202);
    assert.equal(res.body.mode, 'instant');
    assert.equal(res.body.attemptId, 'attempt-1');
    assert.equal(res.body.phone, '+919876543210');

    const [call] = s.sarvam.started;
    assert.equal(call.phone, '+919876543210');
    const opening = 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। आपके कहने पर वापस कॉल किया है। क्या मेरी बात Aarav जी से हो रही है?';
    assert.deepEqual(call.variables, {
      customer_name: 'Aarav', customer_phone: '+919876543210', order_number: 'TD-ORD-1001', call_reason: 'callback_request', opening_line: opening,
    }, 'the agent greets with opening_line, not the customer care greeting');
    assert.equal(call.overrides.initial_bot_message, opening);
    assert.deepEqual(call.webhook, {
      url: 'https://voice.example.test/api/webhooks/sarvam?token=hook-token',
      metadata: { identifier: 'callback:+919876543210', source: 'website', record_id: '003gK000015ycGjQAI' },
    });
  });

  test('a registered number is greeted with the name on record', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await request(s, { phone: '9876543210', consent: true });
    assert.equal(s.sarvam.started[0].variables.customer_name, 'Aarav Sharma');
    assert.match(s.sarvam.started[0].overrides.initial_bot_message, /क्या मेरी बात Aarav Sharma जी से हो रही है\?$/);
  });

  test('an unknown number is asked who is speaking', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await request(s, { phone: '9000000001', consent: true });
    assert.match(s.sarvam.started[0].overrides.initial_bot_message, /क्या आप बता सकते हैं कि मेरी बात किससे हो रही है\?$/);
  });

  test('nothing is dialled without consent', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const consent of [undefined, false, 'true']) {
      const res = await request(s, { phone: '9876543210', consent });
      assert.equal(res.status, 400, String(consent));
      assert.equal(res.body.error, 'consent_required');
    }
    assert.equal(s.sarvam.started.length, 0);
  });

  test('only valid Indian mobile numbers are dialled', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const phone of ['12345', '1234567890', '+1 415 555 0100', '']) {
      const res = await request(s, { phone, consent: true });
      assert.equal(res.status, 422, phone);
      assert.equal(res.body.error, 'invalid_number');
    }
    assert.equal(s.sarvam.started.length, 0);
  });

  test('the same number cannot be called again within 15 minutes, nor more than 3 times a day', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const body = { phone: '9876543210', consent: true };
    assert.equal((await request(s, body)).status, 202);

    const tooSoon = await request(s, body);
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.body.error, 'rate_limited');
    assert.equal(tooSoon.body.retryAfterSeconds, 900);
    assert.match(tooSoon.body.message, /about 15 minutes/);

    s.clock.now += 15 * 60 * 1000;
    assert.equal((await request(s, body)).status, 202);
    s.clock.now += 15 * 60 * 1000;
    assert.equal((await request(s, body)).status, 202);
    s.clock.now += 15 * 60 * 1000;
    const fourth = await request(s, body);
    assert.equal(fourth.status, 429, 'three calls a day per number');
    assert.match(fourth.body.message, /hours/);
    assert.equal(s.sarvam.started.length, 3);

    assert.equal((await request(s, { phone: '9820011111', consent: true })).status, 202, 'other numbers are unaffected');
  });

  test('an overall hourly cap stops a flood of different numbers', async (t) => {
    const config = testConfig({ callbacks: { allowedNumbers: 'any', maxPerHour: 2, maxPerDay: 100 } });
    const s = await startTestServer({ config });
    t.after(s.close);
    assert.equal((await request(s, { phone: '9000000001', consent: true })).status, 202);
    assert.equal((await request(s, { phone: '9000000002', consent: true })).status, 202);
    assert.equal((await request(s, { phone: '9000000003', consent: true })).status, 429);
  });

  test('a failed call does not use up the customer allowance', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    s.sarvam.failNext = 1;
    assert.equal((await request(s, { phone: '9876543210', consent: true })).status, 502);
    assert.equal((await request(s, { phone: '9876543210', consent: true })).status, 202);
  });

  test('with the registered-only policy, unknown numbers are refused', async (t) => {
    const config = testConfig({ callbacks: { allowedNumbers: 'registered', maxPerHour: 20, maxPerDay: 100 } });
    const s = await startTestServer({ config });
    t.after(s.close);
    const unknown = await request(s, { phone: '9000000001', consent: true });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.error, 'not_registered');
    assert.equal((await request(s, { phone: '9876543210', consent: true })).status, 202);
  });

  test('without instant calls the callback campaign is used', async (t) => {
    const s = await startTestServer({ instantCalls: false });
    t.after(s.close);
    const res = await request(s, { phone: '9876543210', consent: true });
    assert.equal(res.body.mode, 'campaign');
    assert.equal(s.sarvam.calls[0].campaignId, 'camp-callback');
  });

  test('with neither instant calls nor a campaign the request is refused', async (t) => {
    const config = testConfig();
    config.sarvam = { ...config.sarvam, callbackCampaignId: '' };
    const s = await startTestServer({ config, instantCalls: false });
    t.after(s.close);
    assert.equal((await request(s, { phone: '9876543210', consent: true })).status, 503);
  });

  test('the website key can only request calls', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await request(s, { phone: '9876543210', consent: true }, s.internal)).status, 202, 'the internal key still works');
    assert.equal((await s.call('POST', '/api/calls/notify', { headers: s.site, body: { caseNumber: '1063', event: 'case_registered' } })).status, 401);
    assert.equal((await s.call('POST', '/api/orders/delivered', { headers: s.site, body: { orderId: '801A' } })).status, 401);
    assert.equal((await s.call('GET', '/api/jobs', { headers: s.site })).status, 401);
    assert.equal((await s.call('GET', '/health/salesforce', { headers: s.site })).status, 401);
    assert.equal((await request(s, { phone: '9820011111', consent: true }, { 'x-api-key': 'guess' })).status, 401);
  });
});

test.describe('service update calls (module 13)', () => {
  test('an appointment update is queued with the spoken update and dialled on the next run', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '1063', event: 'appointment_scheduled' } });
    assert.equal(res.status, 202);
    assert.equal(res.body.notice, 'The service visit for request 1063 is scheduled for Friday, 16 October at 11:00 am, with technician Vikram.');

    await s.scheduler.tick();
    const [{ campaignId, users }] = s.sarvam.calls;
    assert.equal(campaignId, 'camp-notify');
    assert.equal(users[0].phone, '+919876543210');
    assert.equal(users[0].identifier, 'case:500X');
    assert.equal(users[0].variables.call_reason, 'service_update');
    assert.equal(users[0].variables.notice_details, res.body.notice);
  });

  test('the same update twice is one call', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const body = { caseId: '500X', event: 'appointment_scheduled' };
    await s.call('POST', '/api/calls/notify', { headers: s.internal, body });
    const again = await s.call('POST', '/api/calls/notify', { headers: s.internal, body });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyQueued, true);
    assert.equal((await s.scheduler.list()).length, 1);
  });

  test('a dispatch update dials the customer number in E.164 form', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '1060', event: 'replacement_dispatched' } });
    assert.equal(res.status, 202);
    assert.match(res.body.notice, /replacement Side Panel for request 1060 has been dispatched by BlueDart/);
    assert.equal((await s.scheduler.list())[0].payload.phone, '+919820011111');
  });

  test('updates are refused with a reason when they cannot be sent', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '1063', event: 'party' } })).status, 400);
    assert.equal((await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { event: 'case_registered' } })).status, 400);
    assert.equal((await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '9', event: 'case_registered' } })).status, 404);
    const noShipment = await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '1063', event: 'replacement_dispatched' } });
    assert.equal(noShipment.status, 409);
    assert.equal((await s.scheduler.list()).length, 0);
  });

  test('notification calls stay off until a campaign is configured', async (t) => {
    const config = testConfig();
    config.sarvam = { ...config.sarvam, notifyCampaignId: '' };
    const s = await startTestServer({ config });
    t.after(s.close);
    const res = await s.call('POST', '/api/calls/notify', { headers: s.internal, body: { caseNumber: '1063', event: 'case_registered' } });
    assert.equal(res.status, 503);
  });
});

test.describe('agent tools used during a call', () => {
  test('customer lookup finds a customer by any stored phone format', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/customer-lookup', { body: { phone: '+91 98765 43210' }, headers: s.agent });
    assert.equal(res.body.found, true);
    assert.equal(res.body.customer_name, 'Aarav Sharma');
    assert.equal(res.body.recent_orders, 'TD-ORD-1001 (Delivered)');
    assert.equal(res.body.latest_order_id, 'TD-ORD-1001');
  });

  test('at call start the number a phone caller rings from becomes customer_phone, with the greeting by name', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const start = (body) => s.call('POST', '/api/agent/call-start', { body, headers: s.agent }).then((r) => r.body);
    const defaults = { customer_phone: '', customer_name: '', call_reason: 'inbound', opening_line: 'नमस्ते, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?' };

    assert.deepEqual(await start({ ...defaults, caller_phone: '09876543210', caller_type: 'phone_number' }), {
      customer_phone: '+919876543210',
      customer_name: 'Aarav',
      opening_line: 'नमस्ते Aarav जी, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?',
      caller_details: 'The number for this call, ending 3 2 1 0, is registered to Aarav Sharma. Recent orders: TD-ORD-1001, delivered. '
        + 'Open requests: 1063 for Installation, Appointment Scheduled.',
      known_customer: true,
    });
    assert.deepEqual(await start({ ...defaults, caller_phone: '09000000000' }), {
      customer_phone: '+919000000000',
      customer_name: '',
      opening_line: defaults.opening_line,
      caller_details: 'The number for this call, ending 0 0 0 0, is not on record as a customer.',
      known_customer: false,
    }, 'an unknown caller keeps the plain greeting, but the agent still has the number');

    const web = await start({ ...defaults, customer_phone: '+919820011111', customer_name: 'Meera', caller_phone: 'web-visitor' });
    assert.equal(web.customer_phone, '+919820011111', 'the number typed on the website wins');
    assert.equal(web.customer_name, 'Meera');

    const outbound = { customer_phone: '+919876543210', customer_name: 'Aarav Sharma', call_reason: 'delivery_check', opening_line: 'Hello, this is…', caller_phone: '9876543210' };
    assert.deepEqual(await start(outbound), {
      customer_phone: '+919876543210', customer_name: 'Aarav Sharma', opening_line: 'Hello, this is…', caller_details: '', known_customer: false,
    }, 'outbound calls keep the variables the server set');

    assert.deepEqual(await start({ ...defaults, caller_phone: 'ravi@example.com', caller_type: 'email' }),
      { customer_phone: '', customer_name: '', opening_line: defaults.opening_line, caller_details: '', known_customer: false });
    assert.equal((await start({ ...defaults, caller_phone: '9876543210', caller_type: 'custom' })).customer_phone, '', 'only a phone identifier is a number');

    s.crm.findContactByPhone = async () => { throw new Error('Salesforce is down'); };
    const down = await start({ ...defaults, caller_phone: '9876543210' });
    assert.equal(down.customer_phone, '+919876543210', 'the number is kept even when the lookup fails');
    assert.equal(down.opening_line, defaults.opening_line);
    assert.equal(down.caller_details, '', 'nothing is claimed about the number when the lookup failed');
  });

  test('the greeting does not wait for a slow lookup at call start: what is late is left for the agent to look up', async (t) => {
    const s = await startTestServer({ config: testConfig({ callStartBudgetMs: 100 }) });
    t.after(s.close);
    const start = (body) => s.call('POST', '/api/agent/call-start', { body, headers: s.agent }).then((r) => r.body);
    const defaults = { customer_phone: '', customer_name: '', call_reason: 'inbound', opening_line: 'नमस्ते, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?' };
    const slow = (fn, ms) => (...args) => new Promise((resolve, reject) => setTimeout(() => fn(...args).then(resolve, reject), ms));
    const { findContactByPhone, findRecentOrdersForAccount } = s.crm;

    s.crm.findRecentOrdersForAccount = slow(findRecentOrdersForAccount, 400);
    let started = Date.now();
    const lateRecords = await start({ ...defaults, caller_phone: '09876543210' });
    assert.ok(Date.now() - started < 350, 'answered within the budget');
    assert.equal(lateRecords.customer_name, 'Aarav');
    assert.match(lateRecords.opening_line, /^नमस्ते Aarav जी/, 'the name came in time, so the greeting has it');
    assert.equal(lateRecords.caller_details, '', 'without the orders and requests, the agent looks the caller up on its first reply');

    s.crm.findRecentOrdersForAccount = findRecentOrdersForAccount;
    s.crm.findContactByPhone = slow(findContactByPhone, 400);
    started = Date.now();
    const lateContact = await start({ ...defaults, caller_phone: '09876543210' });
    assert.ok(Date.now() - started < 350, 'answered within the budget');
    assert.deepEqual(lateContact, {
      customer_phone: '+919876543210', customer_name: '', opening_line: defaults.opening_line, caller_details: '', known_customer: false,
    }, 'the number is still kept, and the plain greeting goes on time');

    s.crm.findContactByPhone = slow(async () => { throw new Error('Salesforce is down'); }, 400);
    assert.equal((await start({ ...defaults, caller_phone: '09876543210' })).customer_phone, '+919876543210');
    await new Promise((resolve) => setTimeout(resolve, 450));
  });

  test('customer lookup by the caller number gives the first name and the open requests', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/customer-lookup', { body: { phone: '9876543210' }, headers: s.agent });
    assert.equal(res.body.first_name, 'Aarav');
    assert.equal(res.body.open_requests, 1);
    assert.equal(res.body.message,
      'Customer Aarav Sharma found; first name Aarav. Recent orders: TD-ORD-1001, delivered. Open requests: 1063 for Installation, Appointment Scheduled.');
    const unknown = await s.call('POST', '/api/agent/customer-lookup', { body: { phone: '9000000000' }, headers: s.agent });
    assert.match(unknown.body.message, /^No customer record matches this number\. Carry on without saying so/);
  });

  test('a tool whose lookup or save fails still answers 200, with what to do next', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const down = async () => { throw new Error('Salesforce is down'); };
    s.crm.findContactByPhone = down;
    s.crm.createServiceCase = down;

    const lookup = await s.call('POST', '/api/agent/customer-lookup', { body: { phone: '9876543210' }, headers: s.agent });
    assert.equal(lookup.status, 200, 'a non-2xx makes the voice platform speak its generic failure line');
    assert.deepEqual(lookup.body, {
      found: false,
      error: 'unavailable',
      message: 'The service system did not answer. Apologise briefly and call this tool once more. When it fails again, carry on without this information.',
    });

    const booking = await s.call('POST', '/api/agent/installation', {
      headers: s.agent,
      body: { phone: '9876543210', contact_number_ending: '3210', preferred_date: '2026-10-17', preferred_time: '11 am' },
    });
    assert.equal(booking.status, 200);
    assert.equal(booking.body.created, false);
    assert.equal(booking.body.case_number, null, 'save_to_variables still finds the field');
    assert.equal(booking.body.message, 'The service system did not answer, so nothing is saved yet. Apologise briefly and call this tool once more. '
      + 'When it fails again, tell the customer the details are noted for the service team, who will follow up.');

    s.crm.createOrder = down;
    const order = await s.call('POST', '/api/agent/orders', { headers: s.agent, body: { phone: '9000000001', contact_number_ending: '0001', items: 'TD-STD-01' } });
    assert.equal(order.body.order_number, null);
    assert.match(order.body.message, /When it fails again, call tool:request_human_callback with the confirmed products/);
  });

  test('customer lookup reports an unknown number without failing', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/customer-lookup', { body: { phone: '9000000000' }, headers: s.agent });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
    assert.equal((await s.call('POST', '/api/agent/customer-lookup', { body: {}, headers: s.agent })).body.found, false);
  });

  test('an order is found by its order id, order number or invoice number, and its details are given once its number confirms it', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const lookup = (body) => s.call('POST', '/api/agent/order-lookup', { body, headers: s.agent }).then((r) => r.body);
    const AARAV = '9876543210';
    const MEERA = '9820011111';

    const byId = await lookup({ order_id: 'TD-ORD-1001', phone: AARAV });
    assert.equal(byId.found, true);
    assert.equal(byId.number_confirmed, true);
    assert.equal(byId.order_phone, '+919876543210', 'saved for the other tools');
    assert.equal(byId.delivery_status, 'Delivered');
    assert.equal(byId.products, 'Demo 3-Door Wardrobe');
    assert.equal(byId.message, 'Order TD-ORD-1001 for Demo 3-Door Wardrobe was delivered on Wednesday, 14 October.');

    assert.equal((await lookup({ order_id: 'td ord 1001', caller_phone: '+919876543210' })).order_id, 'TD-ORD-1001', 'spoken forms of the id work, and the number of the call confirms it');

    const byInvoice = await lookup({ invoice_number: 'INV-1111', phone: MEERA });
    assert.equal(byInvoice.order_id, 'TD-ORD-1111');
    assert.equal(byInvoice.message, 'Order TD-ORD-1111 for Demo Bookcase is processing.');
    assert.equal((await lookup({ order_id: 'INV-2001', phone: AARAV })).order_id, 'TD-ORD-1001', 'an invoice number said as the order id is read as the invoice');

    for (const said of ['ORD-00000122', '122', 'order number 122', '00000122']) {
      const phoneOrder = await lookup({ order_number: said, phone: MEERA });
      assert.equal(phoneOrder.found, true, said);
      assert.equal(phoneOrder.order_id, null);
      assert.equal(phoneOrder.order_number, '00000122');
      assert.equal(phoneOrder.message, 'Order 122 for Demo Kids Bed is being processed.');
    }
    assert.equal((await lookup({ order_id: '122', phone: MEERA })).order_number, '00000122', 'an order number said as the order id still works');
  });

  test('an order placed with another number is shared only after the caller says the number it was placed with', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const lookup = (body) => s.call('POST', '/api/agent/order-lookup', { body, headers: s.agent }).then((r) => r.body);

    const fromAnother = await lookup({ order_id: 'TD-ORD-1001', phone: '9820011111' });
    assert.deepEqual(fromAnother, {
      found: true,
      number_confirmed: false,
      mobile_on_order: true,
      address_on_order: null,
      details_missing: false,
      message: 'An order matches, but not with the number for this call. Before saying anything about the order, ask the customer which '
        + 'mobile number the order was placed with. Then call tool:find_order again with the same order reference and that number as order_phone.',
    }, 'nothing about the order: no products, status or order id');
    assert.match((await lookup({ order_id: 'TD-ORD-1001' })).message, /^An order matches\. Before saying anything/, 'no number known yet');

    const wrong = await lookup({ order_id: 'TD-ORD-1001', phone: '9820011111', order_phone: '9000000000' });
    assert.equal(wrong.number_confirmed, false);
    assert.match(wrong.message, /^The number the customer gave is not the mobile number this order was placed with.*offer a call back from the service team\.$/);

    const right = await lookup({ order_id: 'TD-ORD-1001', phone: '9820011111', order_phone: '98765 43210' });
    assert.equal(right.number_confirmed, true);
    assert.equal(right.order_phone, '+919876543210');
    assert.equal(right.products, 'Demo 3-Door Wardrobe');
  });

  test('an order without a mobile number cannot be confirmed, and one without a delivery address says so, so the agent offers the invoice upload link', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const lookup = (body) => s.call('POST', '/api/agent/order-lookup', { body, headers: s.agent }).then((r) => r.body);

    const complete = await lookup({ order_id: 'TD-ORD-1001', phone: '9876543210' });
    assert.equal(complete.mobile_on_order, true);
    assert.equal(complete.address_on_order, true);
    assert.equal(complete.details_missing, false);
    assert.doesNotMatch(complete.message, /WhatsApp/);

    const bare = await lookup({ order_id: 'TD-ORD-3333', phone: '9876543210' });
    assert.equal(bare.found, true);
    assert.equal(bare.number_confirmed, false);
    assert.equal(bare.mobile_on_order, false, 'its account has no contact with a number');
    assert.equal(bare.details_missing, true);
    assert.equal(bare.products, undefined, 'nothing about the order is shared');
    assert.match(bare.message, /^An order matches, but no mobile number is on record for it.*Offer to send the WhatsApp link to upload the invoice/);

    const getOrderById = s.crm.getOrderById.bind(s.crm);
    s.crm.getOrderById = async (id) => ({ ...(await getOrderById(id)), street: null });
    const noStreet = await lookup({ order_id: 'TD-ORD-1001', phone: '9876543210' });
    assert.equal(noStreet.address_on_order, false, 'a city and PIN code without a street is not an address to visit');
    assert.match(noStreet.message, /The order has no delivery address on record\. After answering what the customer asked, offer to send a WhatsApp link/);
  });

  test('a misheard order id falls back to the invoice number; an unknown reference says so and leads to the invoice upload link', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const lookup = (body) => s.call('POST', '/api/agent/order-lookup', { body, headers: s.agent }).then((r) => r.body);

    assert.equal((await lookup({ order_id: 'TD-ORD-1010', invoice_number: 'INV-1111', phone: '9820011111' })).order_id, 'TD-ORD-1111');

    const shared = await lookup({ invoice_number: 'INV-7777' });
    assert.equal(shared.found, false, 'an invoice number on two orders does not pick one at random');
    assert.match(shared.message, /More than one order has this invoice number/);
    assert.doesNotMatch(shared.message, /WhatsApp/);
    const settled = await lookup({ order_id: 'TD-ORD-1008', invoice_number: 'INV-7777' });
    assert.equal(settled.found, true, 'the order id settles it');
    assert.equal(settled.number_confirmed, false, 'an order with no number on record is not shared');

    const unknown = await lookup({ order_id: 'TD-ORD-9999' });
    assert.equal(unknown.found, false);
    assert.match(unknown.message, /^No order matches that number\..* When it finds nothing again, tell the customer the order could not be found and offer to send a link on WhatsApp/);
    const nothing = await lookup({});
    assert.equal(nothing.found, false);
    assert.match(nothing.message, /order id, order number or invoice number, or the registered mobile number/);
    const noOrders = await lookup({ phone: '9000000000' });
    assert.match(noOrders.message, /^No order is linked to this phone number\..*offer to send a link on WhatsApp to upload a photo, screenshot or PDF of the invoice\.$/);
  });
  test('part lookup lists parts with part numbers for the order or a product', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const byOrder = await s.call('POST', '/api/agent/part-lookup', { body: { order_id: 'TD-ORD-1001' }, headers: s.agent });
    assert.equal(byOrder.body.found, true);
    assert.deepEqual(byOrder.body.parts.map((p) => p.part_number), ['WRD-3D-HDW-001', 'WRD-3D-PNL-003']);
    assert.match(byOrder.body.message, /Hardware Kit of the Demo 3-Door Wardrobe, part number WRD-3D-HDW-001/);

    const byProduct = await s.call('POST', '/api/agent/part-lookup', { body: { product_name: 'bookcase' }, headers: s.agent });
    assert.equal(byProduct.body.parts[0].name, 'Side Panel');

    const none = await s.call('POST', '/api/agent/part-lookup', { body: { product_name: 'tv cabinet' }, headers: s.agent });
    assert.equal(none.body.found, false);
    assert.match(none.body.message, /as the customer describes it/);
    assert.equal((await s.call('POST', '/api/agent/part-lookup', { body: {}, headers: s.agent })).body.found, false);
  });

  test('without an order id the latest order on the caller number is used', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/order-lookup', { body: { phone: '9820011111' }, headers: s.agent });
    assert.equal(res.body.order_id, 'TD-ORD-1111');
    assert.equal(res.body.delivery_status, 'Processing');
    assert.equal(res.body.order_phone, '+919820011111', 'the number it was found by confirms it');
    const none = await s.call('POST', '/api/agent/order-lookup', { body: { phone: '9000000000' }, headers: s.agent });
    assert.equal(none.body.found, false);
    assert.equal((await s.call('POST', '/api/agent/order-lookup', { body: {}, headers: s.agent })).body.found, false);
  });

  test('without the mobile, a customer is found by full name and PIN code, with orders and open requests', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/customer-lookup', { headers: s.agent, body: { customer_name: 'Arav Sharma', postal_code: '110 001' } });
    assert.equal(res.body.found, true);
    assert.equal(res.body.verified_by, 'name_and_pin');
    assert.equal(res.body.latest_order_id, 'TD-ORD-1001');
    assert.equal(res.body.message,
      'Customer Aarav Sharma found by name and PIN code. Recent orders: TD-ORD-1001, delivered. Open requests: 1063 for Installation, Appointment Scheduled.');

    const wrongPin = await s.call('POST', '/api/agent/customer-lookup', { headers: s.agent, body: { customer_name: 'Aarav Sharma', postal_code: '560001' } });
    assert.equal(wrongPin.body.found, false);
    assert.match(wrongPin.body.message, /^No single customer matches this name and PIN code/);
    const firstNameOnly = await s.call('POST', '/api/agent/customer-lookup', { headers: s.agent, body: { customer_name: 'Aarav', postal_code: '110001' } });
    assert.match(firstNameOnly.body.message, /first and last name/);
    const nothing = await s.call('POST', '/api/agent/customer-lookup', { headers: s.agent, body: {} });
    assert.equal(nothing.body.message, 'The registered mobile number is needed, or the full name with the six digit PIN code.');
  });

  test('without the mobile, a request is shown with its number and the full name or the order id', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const byName = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { case_number: '1063', customer_name: 'Aarav Sharma' } });
    assert.equal(byName.body.found, true);
    assert.equal(byName.body.status, 'Appointment Scheduled');
    const byOrder = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { case_number: '1060', order_id: 'td-ord-1111' } });
    assert.equal(byOrder.body.found, true);
    assert.equal(byOrder.body.case_number, '00001060');

    const wrongName = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { case_number: '1063', customer_name: 'Meera Iyer' } });
    assert.deepEqual(wrongName.body, { found: false, message: 'No request matches these details.' });
    const otherOrder = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { case_number: '1063', order_id: 'TD-ORD-1111' } });
    assert.equal(otherOrder.body.found, false);
    const numberOnly = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { case_number: '1063' } });
    assert.equal(numberOnly.body.found, false);
    assert.match(numberOnly.body.message, /request number with the full name or the order id/);
  });

  test('product search reads out names, codes and list prices', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/products', { body: { query: 'study table' }, headers: s.agent });
    assert.equal(res.body.found, true);
    assert.deepEqual(res.body.products, [
      { name: 'Demo Study Table', product_code: 'TD-STD-01', price: 8999 },
      { name: 'Demo Premium Study Table', product_code: 'TD-STD-PR', price: 15999 },
    ]);
    assert.equal(res.body.message, 'Demo Study Table, code TD-STD-01, list price 8,999 rupees; Demo Premium Study Table, code TD-STD-PR, list price 15,999 rupees.');

    const all = await s.call('POST', '/api/agent/products', { body: {}, headers: s.agent });
    assert.equal(all.body.products.length, 7);
    assert.equal(all.body.message.match(/list price/g).length, 5, 'at most five products are read out');
    assert.match(all.body.message, /\. 2 more products match; ask the customer to be more specific\.$/);

    const none = await s.call('POST', '/api/agent/products', { body: { query: 'sofa' }, headers: s.agent });
    assert.equal(none.status, 200);
    assert.equal(none.body.found, false);
    assert.match(none.body.message, /^No Tiffany Designs product matches that/);
  });

  test('an order is placed with the caller name, mobile, products and delivery address', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/orders', {
      headers: s.agent,
      body: {
        customer_name: 'Ravi Kumar', phone: '90000 00001', contact_number_ending: '0001', items: 'TD-STD-01 x 1, TD-CHR-01 x 2',
        address: 'Flat 4, 12 MG Road', city: 'Gurugram', state: 'Haryana', postal_code: '122002', notes: 'Call before delivery',
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      created: true,
      order_id: '801N0',
      order_number: '00000120',
      spoken_order_number: '120',
      total: 18997,
      message: 'Order 120 is placed for 1 Demo Study Table, 2 Demo Study Chair, total list price 18,997 rupees. '
        + 'The sales team will call the number ending 0 0 0 1 to confirm the final price, delivery and payment.',
    });
    assert.deepEqual(s.crm.placedOrders[0].input, {
      customerName: 'Ravi Kumar', phone: '+919000000001', items: 'TD-STD-01 x 1, TD-CHR-01 x 2',
      address: 'Flat 4, 12 MG Road', city: 'Gurugram', state: 'Haryana', postalCode: '122002', notes: 'Call before delivery',
    });
  });

  test('an order needs a valid Indian mobile, and every refusal is spoken back', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const phone of [undefined, '12345', '+1 415 555 0100', '5000000001']) {
      const res = await s.call('POST', '/api/agent/orders', { headers: s.agent, body: { phone, items: 'TD-STD-01' } });
      assert.equal(res.status, 200, String(phone));
      assert.deepEqual(res.body, { created: false, order_number: null, message: 'A valid 10 digit Indian mobile number is needed to place the order.' });
    }
    const noItems = await s.call('POST', '/api/agent/orders', { headers: s.agent, body: { phone: '9000000001', contact_number_ending: '0001' } });
    assert.deepEqual(noItems.body, { created: false, order_number: null, message: 'No product was given. Ask which product and how many.' });
    assert.equal(s.crm.placedOrders.length, 0);
  });

  test('ordering is an agent tool only', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const body = { phone: '9000000001', items: 'TD-STD-01', address: 'x', city: 'Delhi', postal_code: '110001' };
    assert.equal((await s.call('POST', '/api/agent/orders', { headers: s.site, body })).status, 401, 'the public website key cannot place orders');
    assert.equal((await s.call('POST', '/api/agent/orders', { headers: s.internal, body })).status, 401);
    assert.equal((await s.call('POST', '/api/agent/products', { headers: s.site, body: {} })).status, 401);
    assert.equal(s.crm.placedOrders.length, 0);
  });

  test('missing parts on a Delhi order become an internal-team case', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/cases', {
      headers: s.agent,
      body: {
        issue_type: 'missing parts',
        description: 'Two shelf brackets missing from the wardrobe box',
        order_id: 'TD-ORD-1001',
        phone: '9876543210',
        contact_number_ending: '3210',
        part_number: 'WRD-3D-HDW-001',
        quantity: '2',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.service_route, 'Internal');
    assert.equal(res.body.order_verified, true);
    assert.equal(res.body.case_number, '00001100');
    assert.equal(res.body.spoken_case_number, '1100');
    assert.equal(res.body.contact_number_ending, '3210');
    assert.equal(res.body.message, 'Service request 1100 is registered. The service team will call the number ending 3 2 1 0.');
    const [created] = s.crm.created;
    assert.equal(created.input.issueType, 'missing_parts');
    assert.equal(created.input.phone, '+919876543210');
    assert.equal(created.input.partNumber, 'WRD-3D-HDW-001');
  });

  test('a case outside Delhi NCR goes to the external provider', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/cases', {
      headers: s.agent,
      body: { issue_type: 'damaged', description: 'Side panel cracked', order_id: 'TD-ORD-1111', phone: '9820011111', contact_number_ending: '1111', city: 'Jaipur' },
    });
    assert.equal(res.body.service_route, 'External Provider');
  });

  test('after hours the customer is told the team follows up next working day', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    s.crm.state.withinBusinessHours = false;
    const res = await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'general', description: 'Warranty question', phone: '9876543210', contact_number_ending: '3210' } });
    assert.equal(res.body.within_business_hours, false);
    assert.match(res.body.message, /next working day/);
  });

  test('returns, replacements and delivery damage are accepted', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const issue of ['return', 'replacement', 'delivery damage', 'wrong component', 'defective', 'quality_issue', 'installation_followup', 'reinstallation']) {
      const res = await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: issue, description: 'x', order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210' } });
      assert.equal(res.body.created, true, issue);
    }
    assert.deepEqual(s.crm.created.map((c) => c.input.issueType), ['return', 'replacement', 'delivery_damage', 'wrong_part', 'defective', 'quality_issue', 'installation_followup', 'reinstallation']);
  });

  test('a case needs a known issue type and a description', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'weather', description: 'x' } })).body.created, false);
    assert.equal((await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'damaged' } })).body.created, false);
    assert.equal(s.crm.created.length, 0);
  });

  test('a refusal from Salesforce is passed back so the agent can ask again', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'general', description: 'x' } });
    assert.equal(res.status, 200, 'a refusal is a 200 so Sarvam reads the message instead of its failure line');
    assert.equal(res.body.created, false);
    assert.equal(res.body.case_number, null, 'save_to_variables always finds the field');
    assert.match(res.body.message, /mobile number is needed/);
  });

  test('installation booking records the preferred slot', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/installation', {
      headers: s.agent,
      body: { order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210', preferred_date: '2026-10-17', preferred_time: '11:00' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Installation request 1100 is registered with a preferred slot of Saturday, 17 October, at 11 am. '
      + 'The service team confirms the appointment. The service team will call the number ending 3 2 1 0.');
    const [created] = s.crm.created;
    assert.equal(created.input.issueType, 'installation');
    assert.equal(created.input.preferredDate, '2026-10-17');
    assert.equal(created.input.preferredTime, '11 am');
    assert.equal(created.input.description, 'Customer requested installation.');
  });

  test('a reschedule request uses the rescheduling sub-type', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/agent/installation', {
      headers: s.agent,
      body: { order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210', preferred_date: '2026-10-20', preferred_time: '3 pm', reschedule: 'true', existing_case_number: '1062' },
    });
    assert.equal(s.crm.created[0].input.issueType, 'installation_reschedule');
    assert.equal(s.crm.created[0].input.description, 'Customer asked to reschedule installation for request 1062.');
  });

  test('resolve-date turns what the customer said into a date to read back', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const ok = await s.call('POST', '/api/agent/resolve-date', { headers: s.agent, body: { date_text: 'tomorrow' } });
    assert.deepEqual(ok.body, {
      valid: true,
      date: '2026-10-15',
      spoken_date: 'Thursday, 15 October',
      time: null,
      message: 'That is Thursday, 15 October. Installation visits are Monday to Saturday, 10 am to 6 pm. Use 2026-10-15 as the preferred date.',
    });

    const past = await s.call('POST', '/api/agent/resolve-date', { headers: s.agent, body: { date_text: '1 October 2026' } });
    assert.equal(past.status, 200);
    assert.equal(past.body.valid, false);
    assert.equal(past.body.message, 'Thursday, 1 October has already passed. Ask for a later date.');

    const unclear = await s.call('POST', '/api/agent/resolve-date', { headers: s.agent, body: { date_text: 'soon' } });
    assert.match(unclear.body.message, /not understood/);
  });

  test('installation booking resolves a spoken date and stores the calendar date', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/installation', {
      headers: s.agent, body: { order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210', preferred_date: 'tomorrow', preferred_time: 'morning' },
    });
    assert.equal(res.body.created, true);
    assert.equal(s.crm.created[0].input.preferredDate, '2026-10-15');
    assert.equal(s.crm.created[0].input.preferredTime, 'morning, 10 am to 12 pm');
    assert.match(res.body.message, /preferred slot of Thursday, 15 October, in the morning, between 10 am and 12 pm\./);
  });

  test('installation booking refuses a past date without creating a case', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/installation', { headers: s.agent, body: { phone: '9876543210', preferred_date: '2026-10-01' } });
    assert.equal(res.body.created, false);
    assert.match(res.body.message, /already passed/);
    assert.equal(s.crm.created.length, 0);
  });

  test('installation booking needs a date', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await s.call('POST', '/api/agent/installation', { headers: s.agent, body: { order_id: 'TD-ORD-1001' } })).body.created, false);
  });

  test('request tools find a phone order by its order number, and register nothing for installation or damage without an order', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const slot = { preferred_date: '2026-10-17', preferred_time: 'morning' };
    const byNumber = await s.call('POST', '/api/agent/installation', { headers: s.agent, body: { order_number: '00000122', phone: '9820011111', contact_number_ending: '1111', ...slot } });
    assert.equal(byNumber.body.created, true);
    assert.equal(s.crm.created.at(-1).input.orderNumber, '00000122');

    const without = await s.call('POST', '/api/agent/installation', { headers: s.agent, body: { phone: '9876543210', ...slot } });
    assert.equal(without.body.created, false);
    assert.match(without.body.message, /registered only for an order/);
    const damage = await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'damaged', description: 'x', phone: '9876543210' } });
    assert.equal(damage.body.created, false);
    assert.equal(s.crm.created.length, 1);
  });

  test('a number on record without a name is not greeted by a made-up name', async (t) => {
    const fake = createFakeCrm();
    const s = await startTestServer({ crm: { ...fake, findContactByPhone: async () => ({ id: '003U', name: null, firstName: null, accountId: '001U' }) } });
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/call-start', { headers: s.agent, body: { caller_phone: '09982939127', caller_type: 'phone_number' } });
    assert.equal(res.body.customer_name, '');
    assert.equal(res.body.known_customer, false);
    assert.doesNotMatch(res.body.opening_line, /Unknown/);
    assert.match(res.body.caller_details, /is on record with no name saved, so ask for the full name before registering anything\./);
    const lookup = await s.call('POST', '/api/agent/customer-lookup', { headers: s.agent, body: { phone: '9982939127' } });
    assert.equal(lookup.body.customer_name, null);
    assert.match(lookup.body.message, /^A customer record with no name saved is on this number; ask for the full name before registering anything\./);
  });

  test('the number of this call is used when the customer asks for it, and nothing is registered until its ending is confirmed', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    // As on a live call: the order was confirmed with the number it was placed with, the caller then asked to be reached
    // on the number they were calling from, and the agent sent the order's number as phone.
    const caller = '+919000000555';
    const body = {
      order_id: 'TD-ORD-1001', order_phone: '+919876543210', caller_phone: caller, phone: '9876543210', use_calling_number: true,
      customer_name: 'Ramesh Kumar', preferred_date: '2026-10-17', preferred_time: '11 am',
    };
    const book = (extra) => s.call('POST', '/api/agent/installation', { headers: s.agent, body: { ...body, ...extra } });

    const unconfirmed = await book({});
    assert.equal(unconfirmed.body.created, false);
    assert.equal(unconfirmed.body.case_number, null);
    assert.equal(unconfirmed.body.message, 'Nothing is saved yet: the customer has not confirmed the mobile number for this request. It would be the number '
      + 'of this call, ending 0 5 5 5. Say that back to the customer and ask whether to use it. When the customer agrees, call this tool again with '
      + 'the same details and contact_number_ending 0555. When the customer wants another number, ask for the 10 digit number, read it back in two '
      + 'groups of five digits, and call this tool again with it as phone, use_calling_number set to false and its last four digits as contact_number_ending.');
    const wrong = await book({ contact_number_ending: '3210' });
    assert.match(wrong.body.message, /It would be the number of this call, ending 0 5 5 5, not the number ending 3 2 1 0\./);
    assert.equal(s.crm.created.length, 0);

    const booked = await book({ contact_number_ending: '0555' });
    assert.equal(booked.body.created, true);
    assert.equal(s.crm.created[0].input.phone, caller, 'the number of the call, not the digits the agent sent');
    assert.match(booked.body.message, /The service team will call the number ending 0 5 5 5\./);

    // Without a number for the call, as in a chat test, the agent asks for the digits instead.
    const unknown = await book({ caller_phone: '', contact_number_ending: '0555' });
    assert.equal(unknown.body.created, false);
    assert.match(unknown.body.message, /^Nothing is saved yet: the number of this call is not known\. Ask the customer for the 10 digit mobile number/);

    // The number on file is said back too, with the number of this call offered instead.
    const onFile = await s.call('POST', '/api/agent/cases', {
      headers: s.agent,
      body: { issue_type: 'damaged', description: 'Door cracked', order_id: 'TD-ORD-1001', order_phone: '+919876543210', caller_phone: caller, use_details_on_file: true },
    });
    assert.equal(onFile.body.created, false);
    assert.match(onFile.body.message, /It would be the mobile number on file, ending 3 2 1 0\. .* When the customer wants the number of this call, call it again with use_calling_number set to true\./);
    const callBack = await s.call('POST', '/api/agent/escalate', { headers: s.agent, body: { reason: 'Wants a manager', use_calling_number: 'true', caller_phone: caller, contact_number_ending: '0555' } });
    assert.equal(callBack.body.created, true);
    assert.equal(s.crm.created.at(-1).input.phone, caller);
    assert.equal(s.crm.created.length, 2);
  });

  test('an order and customer details go on the number of this call when the customer asks for it, once its ending is confirmed', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const caller = '+919000000555';
    const order = {
      customer_name: 'Ravi Kumar', use_calling_number: 'true', phone: '9876543210', caller_phone: caller, items: 'TD-STD-01 x 1',
      address: 'Flat 4, 12 MG Road', city: 'Gurugram', state: 'Haryana', postal_code: '122002',
    };
    const first = await s.call('POST', '/api/agent/orders', { headers: s.agent, body: order });
    assert.deepEqual([first.body.created, first.body.order_number], [false, null]);
    assert.match(first.body.message, /^Nothing is saved yet: the customer has not confirmed the mobile number for this order\. It would be the number of this call, ending 0 5 5 5\./);
    assert.equal(s.crm.placedOrders.length, 0);
    const placed = await s.call('POST', '/api/agent/orders', { headers: s.agent, body: { ...order, contact_number_ending: '0555' } });
    assert.equal(placed.body.created, true);
    assert.equal(s.crm.placedOrders[0].input.phone, caller);
    assert.match(placed.body.message, /The sales team will call the number ending 0 5 5 5 to confirm/);

    const details = { customer_name: 'Ravi Kumar', use_calling_number: true, caller_phone: caller, email: 'ravi@example.com' };
    const unsaved = await s.call('POST', '/api/agent/customer', { headers: s.agent, body: details });
    assert.equal(unsaved.body.saved, false);
    assert.match(unsaved.body.message, /^Nothing is saved yet: the customer has not confirmed the mobile number for these details\./);
    const saved = await s.call('POST', '/api/agent/customer', { headers: s.agent, body: { ...details, contact_number_ending: '0555' } });
    assert.equal(saved.body.saved, true);
    assert.deepEqual(s.crm.savedCustomers.map((c) => c.input.phone), [caller]);
  });

  test('escalation registers a request for a human callback', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/escalate', { headers: s.agent, body: { reason: 'Customer wants a manager', phone: '9876543210', contact_number_ending: '3210' } });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /flagged for a service team member/);
    const [created] = s.crm.created;
    assert.equal(created.input.issueType, 'escalation');
    assert.match(created.input.description, /Customer wants a manager/);
  });

  test('case status lists the caller’s open requests with visit and shipment details', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const mine = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { phone: '9820011111' } });
    assert.equal(mine.body.found, true);
    assert.equal(mine.body.case_number, '00001060');
    assert.equal(mine.body.message, 'Request 1060 for Damage or Defect is Replacement Dispatched. Replacement part status: Dispatched, expected by Sunday, 18 October.');

    const byNumber = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { phone: '9876543210', case_number: '1063' } });
    assert.equal(byNumber.body.message, 'Request 1063 for Installation is Appointment Scheduled. A service visit is appointment scheduled for Friday, 16 October at 11:00 am with technician Vikram.');
  });

  test('a caller cannot read another customer’s case by number', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/case-status', { headers: s.agent, body: { phone: '9876543210', case_number: '1060' } });
    assert.equal(res.body.found, false);
    assert.equal(res.body.status, undefined);
  });

  test('service hours say the team is available now, until when, and the weekly hours', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/service-hours', { headers: s.agent, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.open, true);
    assert.equal(res.body.hours, 'Monday to Saturday, 9 am to 6 pm; closed on Sunday');
    assert.equal(res.body.message, 'The service team is available now, until 6 pm today. Service hours are Monday to Saturday, 9 am to 6 pm; closed on Sunday.');
  });

  test('after hours the caller hears when the team is back', async (t) => {
    const s = await startTestServer({ nowMs: Date.parse('2026-10-14T14:00:00Z') });
    t.after(s.close);
    s.crm.state.serviceHours = { ...s.crm.state.serviceHours, open: false, closesAt: null, opensAt: '2026-10-15T03:30:00.000Z' };
    const res = await s.call('POST', '/api/agent/service-hours', { headers: s.agent, body: {} });
    assert.equal(res.body.open, false);
    assert.equal(res.body.next_open, '2026-10-15T03:30:00.000Z');
    assert.match(res.body.message, /^The service team is closed now\. It opens again tomorrow at 9 am, and requests registered now are followed up then\./);

    s.crm.state.serviceHours = { ...s.crm.state.serviceHours, holidayName: 'Diwali', opensAt: '2026-10-19T03:30:00.000Z' };
    const holiday = await s.call('POST', '/api/agent/service-hours', { headers: s.agent, body: {} });
    assert.match(holiday.body.message, /^The service team is closed today for Diwali\. It opens again on Monday, 19 October at 9 am,/);
  });

  test('service area tells who handles a location, by the routing rules', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const ncr = await s.call('POST', '/api/agent/service-area', { headers: s.agent, body: { city: 'Gurugram', postal_code: '122002' } });
    assert.deepEqual(ncr.body, { valid: true, route: 'Internal', message: 'Gurugram, PIN 122002 is within the Delhi NCR service area, so the Tiffany Designs service team handles it.' });

    const partner = await s.call('POST', '/api/agent/service-area', { headers: s.agent, body: { city: 'Jaipur', postal_code: '302012' } });
    assert.equal(partner.body.route, 'External Provider');
    assert.match(partner.body.message, /authorised service partner/);

    const badPin = await s.call('POST', '/api/agent/service-area', { headers: s.agent, body: { city: 'Delhi', postal_code: '1100' } });
    assert.deepEqual(badPin.body, { valid: false, route: null, message: 'That PIN code is not valid. Ask for the six digit PIN code.' });
    assert.equal((await s.call('POST', '/api/agent/service-area', { headers: s.agent, body: {} })).body.message, 'The city or the six digit PIN code is needed.');
  });

  test('customer details are saved for a new caller and only noted for an existing customer', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const fresh = await s.call('POST', '/api/agent/customer', {
      headers: s.agent,
      body: {
        customer_name: 'Ravi Kumar', phone: '90000 00001', contact_number_ending: '0001', email: 'ravi@example.com', alternate_phone: '9811122233',
        address: '12 MG Road', city: 'Gurugram', state: 'Haryana', postal_code: '122002',
      },
    });
    assert.deepEqual(fresh.body, { saved: true, new_customer: true, message: 'The details are saved for Ravi Kumar.' });
    assert.deepEqual(s.crm.savedCustomers[0].input, {
      customerName: 'Ravi Kumar', phone: '+919000000001', email: 'ravi@example.com', alternatePhone: '9811122233',
      address: '12 MG Road', city: 'Gurugram', state: 'Haryana', postalCode: '122002',
    });

    const known = await s.call('POST', '/api/agent/customer', { headers: s.agent, body: { phone: '9876543210', contact_number_ending: '3210', address: 'New flat 9', city: 'Noida' } });
    assert.equal(known.body.new_customer, false);
    assert.equal(known.body.message, 'The details are noted for the service team, who will check them with the customer before updating the record.');
    assert.doesNotMatch(known.body.message, /Aarav/, 'the name on record is not revealed to the caller');
  });

  test('customer details need a valid Indian mobile, and refusals are spoken back', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const noPhone = await s.call('POST', '/api/agent/customer', { headers: s.agent, body: { customer_name: 'Ravi' } });
    assert.deepEqual(noPhone.body, { saved: false, new_customer: null, message: 'A valid 10 digit Indian mobile number is needed.' });
    const noName = await s.call('POST', '/api/agent/customer', { headers: s.agent, body: { phone: '9000000001', contact_number_ending: '0001' } });
    assert.equal(noName.status, 200);
    assert.equal(noName.body.message, "The customer's name is needed to save a new customer.");
    assert.equal(s.crm.savedCustomers.length, 0);
  });

  test('service history lists recent requests, closed ones included, and recent calls', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', '/api/agent/history', { headers: s.agent, body: { phone: '9876543210' } });
    assert.equal(res.body.found, true);
    assert.equal(res.body.open_requests, 1);
    assert.equal(res.body.message,
      'Recent requests: request 1063 for Installation, initial installation, opened Monday, 12 October, status Appointment Scheduled; '
      + 'request 1040 for Damage or Defect, missing component, opened Sunday, 20 September, closed. '
      + 'Recent calls: Tuesday, 13 October, outbound call, the delivery was confirmed; Saturday, 10 October, inbound call, not answered.');

    const nobody = await s.call('POST', '/api/agent/history', { headers: s.agent, body: { phone: '9000000009' } });
    assert.deepEqual(nobody.body, { found: false, message: 'No customer record matches this number. Ask the customer to check the registered mobile number.' });
    const noHistory = await s.call('POST', '/api/agent/history', { headers: s.agent, body: { phone: '9820011111' } });
    assert.deepEqual(noHistory.body, { found: false, message: 'No earlier requests or calls are on record for this number.' });
  });

  test('the new tools need the agent secret', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const path of ['/api/agent/service-hours', '/api/agent/service-area', '/api/agent/customer', '/api/agent/history']) {
      assert.equal((await s.call('POST', path, { headers: s.site, body: { phone: '9876543210' } })).status, 401, path);
    }
    assert.equal(s.crm.savedCustomers.length, 0);
  });
});

test.describe('Sarvam call-end webhook', () => {
  const outbound = {
    app_id: 'Tiffany-Des-0db8e21d-e099',
    app_version: 1,
    attempt_id: 'a1',
    campaign_id: 'camp-followup',
    cohort_id: 'c1',
    completion_status: 'completed',
    connectivity_status: 'connected',
    user_identifier: 'order:801A',
    user_phone_number: '+919876543210',
    duration: 84,
    interaction_id: 'int-1',
    recording_url: 'https://rec/1.mp3',
    interaction_transcript: [
      { role: 'agent', en_text: 'Hello, is this Aarav?' },
      { role: 'user', en_text: 'Yes' },
    ],
  };

  test('a connected call is logged as a Task on the customer and order', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, output_agent_variables: { call_summary: 'Delivered fine; installation booked', delivery_status: 'delivered_ok', case_number: '00001100' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.logged, true);
    assert.equal(res.body.fallbackCaseNumber, null);
    const [task] = s.crm.tasks;
    assert.equal(task.contactId, '003A');
    assert.equal(task.relatedId, '801A');
    assert.equal(task.direction, 'outbound');
    assert.equal(task.disposition, 'delivered_ok');
    assert.equal(task.callId, 'int-1');
    assert.match(task.description, /Summary: Delivered fine/);
    assert.match(task.description, /Agent: Hello, is this Aarav\?\nCustomer: Yes/);
    assert.match(task.description, /Recording: https:\/\/rec\/1\.mp3/);
  });

  test('a case the agent registered during the call is linked, not duplicated', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const callStart = new Date(s.clock.now).toISOString();
    s.clock.now += 60 * 1000;
    await s.call('POST', '/api/agent/cases', {
      headers: s.agent, body: { issue_type: 'missing_parts', description: 'Drawer handles missing', order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210' },
    });

    s.clock.now += 60 * 1000;
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, start_datetime: callStart, final_agent_variables: { issue_type: 'missing_parts', issue_description: 'Drawer handles missing' } },
    });
    assert.equal(res.body.fallbackCaseNumber, null, 'no second case');
    assert.equal(res.body.caseNumber, '00001100');
    assert.equal(s.crm.created.length, 1);
    assert.equal(s.crm.tasks[0].relatedId, '5000', 'the call is logged against the case');
  });

  test('a case from an earlier call does not stop a fallback for this one', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/agent/cases', { headers: s.agent, body: { issue_type: 'general', description: 'Earlier call', phone: '9876543210', contact_number_ending: '3210' } });
    s.clock.now += 3 * 60 * 60 * 1000;
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, start_datetime: new Date(s.clock.now - 5 * 60 * 1000).toISOString(), final_agent_variables: { issue_type: 'damaged', issue_description: 'Door hinge broken', order_number: 'TD-ORD-1001' } },
    });
    assert.ok(res.body.fallbackCaseNumber);
    assert.equal(s.crm.created.length, 2);
  });

  test('an order placed during the call is linked to the call log', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const callStart = new Date(s.clock.now).toISOString();
    s.clock.now += 60 * 1000;
    await s.call('POST', '/api/agent/orders', {
      headers: s.agent,
      body: { customer_name: 'Aarav Sharma', phone: '9876543210', contact_number_ending: '3210', items: 'TD-STD-01 x 1', address: '12 MG Road', city: 'Delhi', postal_code: '110001' },
    });
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, user_identifier: 'callback:+919876543210', start_datetime: callStart, output_agent_variables: { call_outcome: 'order_placed', placed_order_number: '120' } },
    });
    assert.equal(res.body.orderNumber, '00000120');
    const [task] = s.crm.tasks;
    assert.equal(task.relatedId, '801N0');
    assert.equal(task.disposition, 'order_placed');
    assert.match(task.description, /Outcome: order_placed\nOrder placed: 00000120\n/);
    assert.equal(s.crm.created.length, 0, 'an order is not a service case');
  });

  test('the placed order is found from the caller even when the agent did not note its number', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const callStart = new Date(s.clock.now).toISOString();
    await s.call('POST', '/api/agent/orders', {
      headers: s.agent,
      body: { phone: '9876543210', contact_number_ending: '3210', items: 'TD-BKC-01', address: '12 MG Road', city: 'Delhi', postal_code: '110001' },
    });
    await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, user_identifier: 'callback:+919876543210', start_datetime: callStart, output_agent_variables: { call_outcome: 'order_placed', placed_order_number: '999' } },
    });
    assert.equal(s.crm.tasks[0].relatedId, '801N0', 'a misheard number falls back to the caller order');
  });

  test('an order from before the call is not linked', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', '/api/agent/orders', {
      headers: s.agent,
      body: { phone: '9876543210', contact_number_ending: '3210', items: 'TD-BKC-01', address: '12 MG Road', city: 'Delhi', postal_code: '110001' },
    });
    assert.equal(s.crm.placedOrders.length, 1);
    s.clock.now += 3 * HOUR;
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, start_datetime: new Date(s.clock.now - 5 * 60 * 1000).toISOString(), output_agent_variables: { placed_order_number: '120' } },
    });
    assert.equal(res.body.orderNumber, null);
    assert.equal(s.crm.tasks[0].relatedId, '801A', 'the call keeps its own order');
  });

  test('a service update call is logged against its case', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, campaign_id: 'camp-notify', user_identifier: 'case:500X', output_agent_variables: { call_outcome: 'information_given' } },
    });
    assert.equal(s.crm.tasks[0].relatedId, '500X');
    assert.equal(s.crm.tasks[0].disposition, 'information_given');
  });

  test('an issue reported without a case gets a fallback case', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, final_agent_variables: { issue_type: 'missing_parts', issue_description: 'Drawer handles missing', order_number: 'TD-ORD-1001' } },
    });
    assert.ok(res.body.fallbackCaseNumber);
    const [created] = s.crm.created;
    assert.equal(created.input.issueType, 'missing_parts');
    assert.equal(created.input.erpOrderId, 'TD-ORD-1001');
    assert.match(created.input.description, /Drawer handles missing \(registered after the call; voice call int-1\)/);
  });

  test('an unanswered attempt that will be retried is not logged yet', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, connectivity_status: 'no_answer', next_action_status: 'retry', interaction_transcript: null },
    });
    assert.equal(res.body.logged, false);
    assert.equal(s.crm.tasks.length, 0);
  });

  test('the final unanswered attempt is logged as not connected, with no case', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { ...outbound, connectivity_status: 'busy', next_action_status: null, final_agent_variables: { issue_type: 'damaged' } },
    });
    assert.match(s.crm.tasks[0].subject, /not connected/);
    assert.match(s.crm.tasks[0].description, /Not connected: busy/);
    assert.equal(s.crm.created.length, 0);
  });

  test('an inbound call is logged as inbound', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: { app_id: 'x', app_version: 1, deployment_id: 'dep1', interaction_id: 'int-2', user_phone_number: '+919820011111', agent_phone_number: '+917965851546', duration: 40 },
    });
    assert.equal(s.crm.tasks[0].direction, 'inbound');
    assert.equal(s.crm.tasks[0].contactId, '003B');
  });

  test('an instant call from the website panel is logged with its metadata', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), {
      body: {
        app_id: 'Tiffany-Des-0db8e21d-e099',
        app_version: 1,
        attempt_id: 'attempt-9',
        completion_status: 'completed',
        connectivity_status: 'connected',
        user_phone_number: '+919000000001',
        interaction_id: 'int-9',
        duration: 61,
        metadata: { identifier: 'callback:+919000000001', source: 'website', record_id: '00QgK000001AbCdUAK' },
        output_agent_variables: { call_outcome: 'information_given' },
      },
    });
    assert.equal(res.status, 200);
    const [task] = s.crm.tasks;
    assert.equal(task.direction, 'outbound');
    assert.equal(task.contactId, '00QgK000001AbCdUAK', 'a Lead started from its page becomes the WhoId');
    assert.equal(task.callId, 'int-9');
  });

  test('a payload that is not from Sarvam is rejected', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    assert.equal((await s.call('POST', s.hookPath('/api/webhooks/sarvam'), { body: { hello: 1 } })).status, 400);
  });
});

test.describe('website call widget', () => {
  const sessionPath = '/api/sarvam/orgs/org-1/workspaces/ws-1/apps/Tiffany-Test-Agent/url';

  test('the widget gets Sarvam’s signed URL without ever seeing the API key', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const res = await s.call('GET', `${sessionPath}?interaction_type=call&version=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { url: 'wss://apps.sarvam.test/session?token=t1', reference_id: 'ref-1', expires_at: '2026-10-14T07:00:00Z' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(s.sarvam.webSessions, [{ interaction_type: 'call', version: 3 }], 'the server picks the agent version, not the browser');
  });

  test('with the number the customer typed, the call link also names the customer’s first name', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const link = { url: 'wss://apps.sarvam.test/session?token=t1', reference_id: 'ref-1', expires_at: '2026-10-14T07:00:00Z' };
    const known = await s.call('GET', `${sessionPath}?interaction_type=call`, { headers: { 'X-Caller-Phone': '98765 43210' } });
    assert.deepEqual(known.body, { ...link, caller: { phone: '+919876543210', first_name: 'Aarav' } });
    const unknown = await s.call('GET', `${sessionPath}?interaction_type=call`, { headers: { 'X-Caller-Phone': '9123456780' } });
    assert.deepEqual(unknown.body.caller, { phone: '+919123456780', first_name: null });
    const none = await s.call('GET', `${sessionPath}?interaction_type=call`);
    assert.deepEqual(none.body, link, 'without a number the answer is Sarvam’s as it is');

    s.sarvam.webResponse = { status: 429, body: '{"detail":"slow down"}', retryAfter: '30' };
    const limited = await s.call('GET', `${sessionPath}?interaction_type=call`, { headers: { 'X-Caller-Phone': '98765 43210' } });
    assert.deepEqual([limited.status, limited.body], [429, { detail: 'slow down' }], 'no call link, no name');
  });

  test('only this project’s agent can be reached through the endpoint', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const path of [
      '/api/sarvam/orgs/org-1/workspaces/ws-1/apps/Arogaya-Hos-ec23d46a-0bcc/url',
      '/api/sarvam/orgs/org-2/workspaces/ws-1/apps/Tiffany-Test-Agent/url',
      '/api/sarvam/orgs/org-1/workspaces/ws-2/apps/Tiffany-Test-Agent/url',
    ]) {
      assert.equal((await s.call('GET', path)).status, 404, path);
    }
    assert.equal(s.sarvam.webSessions.length, 0);
  });

  test('a visitor can start 5 calls in 10 minutes', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (let i = 0; i < 5; i += 1) assert.equal((await s.call('GET', sessionPath)).status, 200);
    const blocked = await s.call('GET', sessionPath);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await s.call('GET', sessionPath, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 200, 'another visitor is not affected');
    s.clock.now += 10 * 60 * 1000 + 1;
    assert.equal((await s.call('GET', sessionPath)).status, 200, 'allowed again after ten minutes');
  });

  test('attempts that get no call link do not count toward the limits', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    s.sarvam.webResponse = { status: 401, body: '{"error":"invalid key"}', retryAfter: null };
    for (let i = 0; i < 6; i += 1) assert.equal((await s.call('GET', sessionPath)).status, 503);
    s.sarvam.failNext = 1;
    assert.equal((await s.call('GET', sessionPath)).status, 502);

    s.sarvam.webResponse = { status: 200, body: '{"url":"wss://apps.sarvam.test/session?token=t2","reference_id":"ref-2"}', retryAfter: null };
    for (let i = 0; i < 5; i += 1) assert.equal((await s.call('GET', sessionPath)).status, 200, 'the failed attempts were not counted');
    assert.equal((await s.call('GET', sessionPath)).status, 429);
  });

  test('an overall hourly cap stops a flood from many addresses', async (t) => {
    const s = await startTestServer({ config: testConfig({ webCalls: { maxPerHour: 2, maxPerDay: 200 } }) });
    t.after(s.close);
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      assert.equal((await s.call('GET', sessionPath, { headers: { 'x-forwarded-for': ip } })).status, 200);
    }
    assert.equal((await s.call('GET', sessionPath, { headers: { 'x-forwarded-for': '203.0.113.3' } })).status, 429);
    assert.equal(s.sarvam.webSessions.length, 2);
  });

  test('a refused server key becomes a plain "not available", other refusals reach the widget, and an outage is a 502', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    for (const status of [401, 403]) {
      s.sarvam.webResponse = { status, body: '{"error":{"data":{"details":"Invalid API key format."}}}', retryAfter: null };
      const refused = await s.call('GET', sessionPath);
      assert.equal(refused.status, 503);
      assert.deepEqual(refused.body, { error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
    }

    s.sarvam.webResponse = { status: 429, body: '{"detail":"slow down"}', retryAfter: '30' };
    const limited = await s.call('GET', sessionPath);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '30');

    s.sarvam.failNext = 1;
    const down = await s.call('GET', sessionPath);
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'upstream_failed');
  });

  test('without an API key the endpoint says so instead of failing in the browser', async (t) => {
    const s = await startTestServer({ webCalls: false });
    t.after(s.close);
    const res = await s.call('GET', sessionPath);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'not_configured');
  });

  test('a page on another site may ask for a session (CORS), including the browser preflight', async (t) => {
    const s = await startTestServer();
    t.after(s.close);
    const preflight = await s.call('OPTIONS', sessionPath, {
      headers: { origin: 'https://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-API-Key/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Caller-Phone/);
    assert.equal(s.sarvam.webSessions.length, 0, 'the preflight starts nothing');

    const fromOtherSite = await s.call('GET', sessionPath, { headers: { origin: 'https://localhost', 'x-api-key': '' } });
    assert.equal(fromOtherSite.status, 200);
    assert.equal(fromOtherSite.headers.get('access-control-allow-origin'), '*');
    assert.equal(fromOtherSite.headers.get('access-control-expose-headers'), 'Retry-After');

    const fromFile = await s.call('GET', sessionPath, { headers: { origin: 'null' } });
    assert.equal(fromFile.status, 200, 'a page opened from disk works too');
  });

  test('with an allowed-sites list, other websites are refused', async (t) => {
    const s = await startTestServer({ config: testConfig({ webCalls: { maxPerHour: 30, maxPerDay: 200, allowedOrigins: 'https://www.tiffany.example, https://shop.tiffany.example/' } }) });
    t.after(s.close);
    const ours = await s.call('GET', sessionPath, { headers: { origin: 'https://shop.tiffany.example' } });
    assert.equal(ours.status, 200);
    assert.equal(ours.headers.get('access-control-allow-origin'), 'https://shop.tiffany.example');
    assert.match(ours.headers.get('vary'), /Origin/);

    const other = await s.call('GET', sessionPath, { headers: { origin: 'https://copycat.example' } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await s.call('OPTIONS', sessionPath, { headers: { origin: 'https://copycat.example' } })).status, 403);

    assert.equal((await s.call('GET', sessionPath)).status, 200, 'pages on this server send no Origin and still work');
    assert.equal(s.sarvam.webSessions.length, 2);
  });
});
