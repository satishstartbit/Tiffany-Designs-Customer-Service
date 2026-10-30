const test = require('node:test');
const assert = require('node:assert/strict');
const { openingLine, welcomeLine, outboundOverrides, noticeFor, noticeJobId, createJobHandlers } = require('../src/callFlows');
const { createFakeSarvam } = require('./helpers');

test('outbound calls open in Hindi by confirming who answered, without mentioning the order', () => {
  assert.equal(openingLine('delivery_followup', 'Aarav Sharma'), 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। क्या मेरी बात Aarav Sharma जी से हो रही है?');
  assert.equal(openingLine('delivery_followup', null), 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। क्या आप बता सकते हैं कि मेरी बात किससे हो रही है?');
  assert.equal(openingLine('callback_request', 'Meera'), 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। आपके कहने पर वापस कॉल किया है। क्या मेरी बात Meera जी से हो रही है?');
  for (const reason of ['delivery_followup', 'callback_request', 'service_update']) {
    assert.doesNotMatch(openingLine(reason, 'X'), /order|delivery|case|request \d|ऑर्डर|डिलीवरी|रिक्वेस्ट/i, reason);
  }
  assert.deepEqual(outboundOverrides('delivery_followup', 'X'), { initial_bot_message: openingLine('delivery_followup', 'X'), initial_language_name: 'Hindi' });
});

test('inbound calls are welcomed in Hindi, by first name when the caller is a customer', () => {
  assert.equal(welcomeLine(), 'नमस्ते, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?');
  assert.equal(welcomeLine('Satish'), 'नमस्ते Satish जी, टिफ़नी डिज़ाइन्स में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?');
});

const notice = {
  id: '500X',
  caseNumber: '00001063',
  serviceType: 'Installation',
  visit: { status: 'Appointment Scheduled', scheduledStart: '2026-10-16T05:30:00.000Z', technician: 'Demo Tech - Vikram (Internal)' },
  shipment: { id: 'a01', status: 'Dispatched', expectedDate: '2026-10-18', courier: 'BlueDart', component: 'Demo Bookcase - Side Panel' },
};

test('service update wording for each event', () => {
  assert.equal(noticeFor('case_registered', notice), 'Service request 1063 for Installation is registered and the service team is reviewing it.');
  assert.equal(noticeFor('appointment_scheduled', notice), 'The service visit for request 1063 is scheduled for Friday, 16 October at 11:00 am, with technician Vikram.');
  assert.equal(noticeFor('replacement_dispatched', notice), 'The replacement Side Panel for request 1063 has been dispatched by BlueDart, expected by Sunday, 18 October.');
  assert.equal(noticeFor('appointment_scheduled', { ...notice, visit: null }), null);
  assert.equal(noticeFor('replacement_dispatched', { ...notice, shipment: null }), null);
  assert.equal(noticeFor('unknown', notice), null);
});

test('a rescheduled visit or a new shipment status is a new notification, a repeat is not', () => {
  const first = noticeJobId('appointment_scheduled', notice);
  assert.equal(first, noticeJobId('appointment_scheduled', { ...notice }));
  assert.notEqual(first, noticeJobId('appointment_scheduled', { ...notice, visit: { ...notice.visit, scheduledStart: '2026-10-17T05:30:00.000Z' } }));
  assert.notEqual(noticeJobId('replacement_dispatched', notice), noticeJobId('replacement_dispatched', { ...notice, shipment: { ...notice.shipment, status: 'Delivered' } }));
});

test('the service update job dials the notification campaign with the update text', async () => {
  const sarvam = createFakeSarvam();
  const handlers = createJobHandlers({ sarvam, config: { sarvam: { notifyCampaignId: 'camp-notify' } } });
  await handlers.service_update({ caseId: '500X', caseNumber: '00001063', phone: '+919876543210', customerName: 'Aarav Sharma', erpOrderId: 'TD-ORD-1001', notice: 'Update text.' });
  const [{ campaignId, label, users }] = sarvam.calls;
  assert.equal(campaignId, 'camp-notify');
  assert.equal(label, 'update-00001063');
  assert.equal(users[0].identifier, 'case:500X');
  assert.deepEqual(users[0].variables, {
    customer_name: 'Aarav Sharma',
    customer_phone: '+919876543210',
    order_number: 'TD-ORD-1001',
    call_reason: 'service_update',
    notice_details: 'Update text.',
    opening_line: 'नमस्ते, मैं टिफ़नी डिज़ाइन्स का AI सर्विस असिस्टेंट हूँ। क्या मेरी बात Aarav Sharma जी से हो रही है?',
  });
  assert.match(users[0].overrides.initial_bot_message, /क्या मेरी बात Aarav Sharma जी से हो रही है\?$/);
});
