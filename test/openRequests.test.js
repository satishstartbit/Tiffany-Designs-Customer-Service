// An order has one open request of each kind: a new installation, damage or replacement request is added as an update
// to the open one of the same kind, and a new request is registered only when none is open (also when an earlier one
// is closed). The language a caller chose is saved on their contact.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrm, requestKind } = require('../src/crm/crm');
const { startTestServer } = require('./helpers');

// ---------- The server: getOpenRequests, createServiceCase and savePreferredLanguage ----------

function fakeSalesforce(answers) {
  const log = { queries: [], creates: [], updates: [] };
  return {
    log,
    async query(soql) {
      log.queries.push(soql);
      const hit = Object.entries(answers).find(([match]) => soql.includes(match));
      return hit ? hit[1](soql) : [];
    },
    async search() {
      return [{ Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '+91 98100 00001' }];
    },
    async create(sobject, fields) {
      log.creates.push({ sobject, fields });
      return { id: `${sobject}-${log.creates.length}`, success: true };
    },
    async update(sobject, id, fields) {
      log.updates.push({ sobject, id, fields });
      return null;
    },
  };
}

const ORDER = {
  Id: '801A', ERP_Order_Id__c: 'TD-ORD-1001', Invoice_Number__c: 'INV-2001', Order_Source__c: 'Website', AccountId: '001A',
  Account: { Name: 'Aarav Sharma' }, ShippingCity: 'Delhi', ShippingState: 'Delhi', ShippingPostalCode: '110001',
};

// Older cases in the org often have no sub type; they still count as the same kind.
const OPEN_ON_ORDER = [
  { Id: '500B', CaseNumber: '00001090', Service_Type__c: 'Damage or Defect', Service_Sub_Type__c: null, Status: 'New', CreatedDate: '2026-10-13T05:00:00.000Z' },
  { Id: '500A', CaseNumber: '00001087', Service_Type__c: 'Installation', Service_Sub_Type__c: null, Status: 'New', CreatedDate: '2026-10-12T05:00:00.000Z' },
  { Id: '500G', CaseNumber: '00001079', Service_Type__c: 'General Query', Service_Sub_Type__c: null, Status: 'Escalated', CreatedDate: '2026-10-11T05:00:00.000Z' },
];

function org(openCases = OPEN_ON_ORDER) {
  return {
    'FROM Order ': (soql) => (soql.includes("'TD-ORD-1001'") ? [ORDER] : []),
    "FROM Case WHERE Order__c = '801A' AND IsClosed = false": () => openCases,
    "FROM Contact WHERE AccountId = '001A'": () => [{ Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '+91 98100 00001' }],
    'FROM RecordType': () => [
      { Id: '012RT-INS', DeveloperName: 'Installation_Request' },
      { Id: '012RT-DMG', DeveloperName: 'Damage_Defect_Complaint' },
      { Id: '012RT-REP', DeveloperName: 'Replacement_Request' },
      { Id: '012RT-GEN', DeveloperName: 'General_Service_Query' },
    ],
    'SELECT CaseNumber, Service_Route__c FROM Case': () => [{ CaseNumber: '00001100', Service_Route__c: 'Internal' }],
    "Damaged_Component__c FROM Case WHERE Id = '500A'": () => [{ Description: 'Customer requested installation.\nPreferred slot: 2026-10-14 11 am', Damaged_Component__c: null }],
    "Damaged_Component__c FROM Case WHERE Id = '500B'": () => [{ Description: 'Door 9 cracked', Damaged_Component__c: 'a0C1' }],
    "SELECT Languages__c FROM Contact WHERE Id = '003A'": () => [{ Languages__c: 'English' }],
  };
}

const open = { isOpen: async () => true };
const crmWith = (answers = org()) => {
  const salesforce = fakeSalesforce(answers);
  return { salesforce, crm: createCrm({ salesforce, businessHours: open }) };
};
const caseCreates = (salesforce) => salesforce.log.creates.filter((c) => c.sobject === 'Case');

test('request kinds: installation, installation follow-up, damage and replacement; general queries are not compared', () => {
  assert.equal(requestKind('Installation', 'Initial Installation'), 'installation');
  assert.equal(requestKind('Installation', 'Installation Rescheduling'), 'installation');
  assert.equal(requestKind('Installation', null), 'installation');
  assert.equal(requestKind('Installation', 'Installation Follow-up'), 'installation_followup');
  assert.equal(requestKind('Installation', 'Re-installation'), 'installation_followup');
  assert.equal(requestKind('Damage or Defect', 'Missing Component'), 'damage');
  assert.equal(requestKind('Damage or Defect', null), 'damage');
  assert.equal(requestKind('Replacement', null), 'replacement');
  assert.equal(requestKind('General Query', null), null);
});

test('getOpenRequests reads the open cases on the order and leaves out general queries', async () => {
  const { salesforce, crm } = crmWith();
  const requests = await crm.getOpenRequests('801A');
  assert.deepEqual(requests.map((r) => [r.caseNumber, r.kind]), [['00001090', 'damage'], ['00001087', 'installation']]);
  assert.match(salesforce.log.queries.at(-1), /WHERE Order__c = '801A' AND IsClosed = false ORDER BY CreatedDate DESC/);
  assert.deepEqual(await crm.getOpenRequests(null), []);
});

test('an installation request on an order with one open updates that one; no second request is made', async () => {
  const { salesforce, crm } = crmWith();
  const input = {
    issueType: 'installation', description: 'Customer requested installation.', phone: '+919810000001', erpOrderId: 'TD-ORD-1001',
    preferredDate: '2026-10-17', preferredTime: '3 pm', newRequest: true,
  };

  const result = await crm.createServiceCase(input);
  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.caseNumber, '00001087');
  assert.equal(result.kind, 'installation');
  assert.equal(result.registeredOn, '2026-10-12T05:00:00.000Z');
  assert.equal(result.contactNumberEnding, '0001');
  assert.equal(caseCreates(salesforce).length, 0, 'a new request is never asked for: new_request no longer makes a second one');
  const [update] = salesforce.log.updates;
  assert.equal(update.sobject, 'Case');
  assert.equal(update.id, '500A');
  assert.match(update.fields.Description, /^Customer requested installation\.\nPreferred slot: 2026-10-14 11 am\n\n\[Update, \d{1,2} \w{3} \d{4}, .+\]\nCustomer requested installation\.\n/);
  assert.match(update.fields.Description, /\nPreferred slot: 2026-10-17 3 pm\n/, 'the newest slot is the one a later call reads back');
  assert.equal(update.fields.Service_Sub_Type__c, undefined);

  await crm.createServiceCase({ ...input, issueType: 'installation_reschedule', description: 'Customer asked to reschedule installation.' });
  assert.equal(salesforce.log.updates.at(-1).fields.Service_Sub_Type__c, 'Installation Rescheduling', 'a reschedule moves the open request');
  assert.equal(caseCreates(salesforce).length, 0);
});

test('requests are compared by kind: the open damage request takes another damaged part, a different kind is new', async () => {
  const { salesforce, crm } = crmWith();
  const base = { phone: '+919810000001', erpOrderId: 'TD-ORD-1001' };

  const missing = await crm.createServiceCase({ ...base, issueType: 'missing_parts', description: 'Two shelf pins missing', partNumber: 'KIS-WALKY-HW', quantity: '2' });
  assert.equal(missing.updated, true);
  assert.equal(missing.caseNumber, '00001090', 'an open damage case without a sub type still counts');
  const update = salesforce.log.updates.at(-1);
  assert.match(update.fields.Description, /^Door 9 cracked\n\n\[Update, .+\]\nTwo shelf pins missing\nPart number: KIS-WALKY-HW\nQuantity: 2\n/);
  assert.equal(update.fields.Damaged_Component__c, undefined, 'the damaged component the request already has stays');

  for (const issueType of ['replacement', 'return', 'installation_followup', 'general', 'escalation']) {
    const result = await crm.createServiceCase({ ...base, issueType, description: 'x' });
    assert.equal(result.created, true, issueType);
  }
  assert.equal(caseCreates(salesforce).length, 5);
});

test('without an order, or with nothing open on it (an earlier request closed), a new request is registered', async () => {
  const empty = crmWith(org([]));
  assert.equal((await empty.crm.createServiceCase({ issueType: 'installation', description: 'x', phone: '+919810000001', erpOrderId: 'TD-ORD-1001' })).created, true);

  const noOrder = crmWith();
  assert.equal((await noOrder.crm.createServiceCase({ issueType: 'general', description: 'x', phone: '+919810000001' })).created, true);
  assert.equal((await noOrder.crm.createServiceCase({ issueType: 'installation', description: 'x', phone: '+919810000001' })).created, false, 'an installation needs the order');
  assert.equal(noOrder.salesforce.log.queries.some((q) => q.includes('IsClosed = false')), false);
});

test('savePreferredLanguage keeps the language a caller chose on their contact', async () => {
  const { salesforce, crm } = crmWith();
  assert.deepEqual(await crm.savePreferredLanguage('003A', ' hindi '), { saved: true, language: 'Hindi' });
  assert.deepEqual(salesforce.log.updates, [{ sobject: 'Contact', id: '003A', fields: { Languages__c: 'Hindi' } }]);

  assert.deepEqual(await crm.savePreferredLanguage('003A', 'English'), { saved: false, language: 'English' }, 'unchanged');
  assert.deepEqual(await crm.savePreferredLanguage('003A', 'French'), { saved: false }, 'only a language the agent speaks');
  assert.deepEqual(await crm.savePreferredLanguage(null, 'Hindi'), { saved: false });
  assert.equal(salesforce.log.updates.length, 1);
});

// ---------- The agent tools ----------

test('find_order names the open requests on the order, without their numbers', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  s.crm.openRequests.push(
    { orderId: '801A', caseNumber: '00001090', kind: 'damage', createdDate: '2026-10-13T05:00:00.000Z' },
    { orderId: '801A', caseNumber: '00001087', kind: 'installation', createdDate: '2026-10-12T05:00:00.000Z' },
    { orderId: '801A', caseNumber: '00001080', kind: 'installation', createdDate: '2026-10-05T05:00:00.000Z' },
  );
  const res = await s.call('POST', '/api/agent/order-lookup', { body: { order_id: 'TD-ORD-1001', caller_phone: '9876543210' }, headers: s.agent });
  assert.deepEqual(res.body.open_requests, ['damage', 'installation']);
  assert.match(res.body.message, /^Order TD-ORD-1001 for Demo 3-Door Wardrobe was delivered on Wednesday, 14 October\. /);
  assert.match(res.body.message, /Open requests on this order: a request about a damaged, defective or missing part, registered on Tuesday, 13 October; an installation request, registered on Monday, 12 October\. /);
  assert.match(res.body.message, /A request of the same kind updates the open one: say that the open request will be updated with it; no new request is made\.$/);
  assert.doesNotMatch(res.body.message, /1090|1087|1080/, 'request numbers need the mobile number or the name');

  const none = await s.call('POST', '/api/agent/order-lookup', { body: { order_id: 'TD-ORD-1111', caller_phone: '9820011111' }, headers: s.agent });
  assert.deepEqual(none.body.open_requests, []);
  assert.doesNotMatch(none.body.message, /Open requests/);
});

test('book_installation updates the open installation request with the new slot, and says so', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  s.crm.openRequests.push({ orderId: '801A', caseNumber: '00001087', kind: 'installation', createdDate: '2026-10-12T05:00:00.000Z' });
  const body = { order_id: 'TD-ORD-1001', phone: '9876543210', contact_number_ending: '3210', preferred_date: '2026-10-17', preferred_time: '11 am' };

  const first = await s.call('POST', '/api/agent/installation', { body, headers: s.agent });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, false);
  assert.equal(first.body.updated, true);
  assert.equal(first.body.case_number, '00001087', 'saved to the case_number variable like a new request');
  assert.equal(first.body.message, 'An installation request for this order was already open, request 1087, registered on Monday, 12 October, so no new request is made: '
    + 'it is updated, and its preferred slot is now Saturday, 17 October, at 11 am, which the service team confirms. The service team will call the number ending 3 2 1 0. '
    + 'Tell the customer request 1087 is updated.');
  assert.equal(s.crm.created.length, 0);
  assert.equal(s.crm.updated.at(-1).input.preferredDate, '2026-10-17');

  const reschedule = await s.call('POST', '/api/agent/installation', { body: { ...body, reschedule: 'True' }, headers: s.agent });
  assert.equal(reschedule.body.updated, true, 'moving the date updates the open request too');
  assert.equal(s.crm.updated.at(-1).input.issueType, 'installation_reschedule');

  const closed = await s.call('POST', '/api/agent/installation', { body: { ...body, order_id: 'TD-ORD-1111', phone: '9820011111', contact_number_ending: '1111' }, headers: s.agent });
  assert.equal(closed.body.created, true, 'an order with nothing open gets a new request');
});

test('register_service_request adds a damaged part to the open damage request; another kind is new', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  s.crm.openRequests.push({ orderId: '801A', caseNumber: '00001090', kind: 'damage', createdDate: '2026-10-13T05:00:00.000Z' });
  const body = { issue_type: 'missing_parts', description: 'Two shelf pins missing.', order_id: '1001', phone: '9876543210', contact_number_ending: '3210', new_request: 'true' };

  const damage = await s.call('POST', '/api/agent/cases', { body, headers: s.agent });
  assert.equal(damage.body.updated, true);
  assert.match(damage.body.message, /^A request about a damaged, defective or missing part for this order was already open, request 1090, registered on Tuesday, 13 October, so no new request is made: it is updated, and the new details are added to it\./);
  assert.equal(s.crm.created.length, 0, 'new_request no longer makes a second one');

  const other = await s.call('POST', '/api/agent/cases', { body: { ...body, issue_type: 'return', description: 'Customer wants to return the wardrobe.' }, headers: s.agent });
  assert.equal(other.body.created, true, 'a different kind is registered at once');
});

// The voice platform can send a yes as text ("True"); only true and "true" used to be read as yes.
test('a yes the voice platform sends as text in any case still counts', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const body = { order_id: 'TD-ORD-1001', phone: '9876543210', preferred_date: '2026-10-17', preferred_time: 'morning' };
  for (const yes of ['True', 'TRUE', 'yes', '1']) {
    const moved = await s.call('POST', '/api/agent/installation', { body: { ...body, contact_number_ending: '3210', reschedule: yes }, headers: s.agent });
    assert.equal(s.crm.created.at(-1).input.issueType, 'installation_reschedule', `reschedule ${yes}`);
    assert.equal(moved.body.created, true);
  }
  const byCall = await s.call('POST', '/api/agent/orders', {
    headers: s.agent,
    body: { use_calling_number: 'True', caller_phone: '+919820011111', contact_number_ending: '1111', customer_name: 'Meera Iyer', items: 'TD-STD-01 x 1', address: '4 MI Road', city: 'Jaipur', postal_code: '302012' },
  });
  assert.equal(byCall.body.created, true);
  assert.equal(s.crm.placedOrders.at(-1).input.phone, '+919820011111', 'the number of the call, from use_calling_number "True"');
});

// ---------- The call-end webhook ----------

test('the language the caller chose is saved on their contact and noted on the call log', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const call = {
    deployment_id: 'dep-1',
    user_phone_number: '+919876543210',
    interaction_id: 'int-9',
    interaction_transcript: [{ role: 'agent', en_text: 'Which language would you like to talk in?' }, { role: 'user', en_text: 'Hindi' }],
  };
  const res = await s.call('POST', s.hookPath('/api/webhooks/sarvam'), { body: { ...call, output_agent_variables: { preferred_language: 'Hindi', call_outcome: 'information_given' } } });
  assert.equal(res.body.languageSaved, true);
  assert.deepEqual(s.crm.savedLanguages, [{ contactId: '003A', language: 'Hindi' }]);
  assert.match(s.crm.tasks[0].description, /\nLanguage: Hindi\n/);

  await s.call('POST', s.hookPath('/api/webhooks/sarvam'), { body: { ...call, user_phone_number: '+919000000099', output_agent_variables: { preferred_language: 'Hindi' } } });
  assert.equal(s.crm.savedLanguages.length, 1, 'an unknown caller has no contact to save it on');
});
