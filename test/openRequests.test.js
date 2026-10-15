// Before a second request of the same kind is registered on an order, the agent asks the caller whether they want an
// update on the open one or a new request (new_request). The language a caller chose is saved on their contact.
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

test('a second installation request on an order is not registered until the caller asks for a new one', async () => {
  const { salesforce, crm } = crmWith();
  const input = { issueType: 'installation', description: 'Customer requested installation.', phone: '+919810000001', erpOrderId: 'TD-ORD-1001' };

  const refused = await crm.createServiceCase(input);
  assert.equal(refused.created, false);
  assert.equal(refused.existingRequest.caseNumber, '00001087');
  assert.equal(refused.existingRequest.kind, 'installation');
  assert.match(refused.error, /already open/);
  assert.equal(caseCreates(salesforce).length, 0, 'nothing is saved');

  const second = await crm.createServiceCase({ ...input, newRequest: true });
  assert.equal(second.created, true);
  assert.equal(caseCreates(salesforce).length, 1);
});

test('the check compares kinds: another damage request is asked about, a different kind goes straight through', async () => {
  const { salesforce, crm } = crmWith();
  const base = { phone: '+919810000001', erpOrderId: 'TD-ORD-1001' };

  const missing = await crm.createServiceCase({ ...base, issueType: 'missing_parts', description: 'Two shelf pins missing' });
  assert.equal(missing.existingRequest?.caseNumber, '00001090', 'an open damage case without a sub type still counts');

  for (const issueType of ['replacement', 'return', 'installation_followup', 'general', 'escalation', 'installation_reschedule']) {
    const result = await crm.createServiceCase({ ...base, issueType, description: 'x' });
    assert.equal(result.created, true, issueType);
  }
  assert.equal(caseCreates(salesforce).length, 6);
});

test('without an order, or with nothing open on it, nothing is compared', async () => {
  const empty = crmWith(org([]));
  assert.equal((await empty.crm.createServiceCase({ issueType: 'installation', description: 'x', phone: '+919810000001', erpOrderId: 'TD-ORD-1001' })).created, true);

  const noOrder = crmWith();
  assert.equal((await noOrder.crm.createServiceCase({ issueType: 'installation', description: 'x', phone: '+919810000001' })).created, true);
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
  const res = await s.call('POST', '/api/agent/order-lookup', { body: { order_id: 'TD-ORD-1001' }, headers: s.agent });
  assert.deepEqual(res.body.open_requests, ['damage', 'installation']);
  assert.match(res.body.message, /^Order TD-ORD-1001 for Demo 3-Door Wardrobe was delivered on Wednesday, 14 October\. /);
  assert.match(res.body.message, /Open requests on this order: a request about a damaged, defective or missing part, registered on Tuesday, 13 October; an installation request, registered on Monday, 12 October\. /);
  assert.match(res.body.message, /ask whether the customer wants an update on it or a new request\.$/);
  assert.doesNotMatch(res.body.message, /1090|1087|1080/, 'request numbers need the mobile number or the name');

  const none = await s.call('POST', '/api/agent/order-lookup', { body: { order_id: 'TD-ORD-1111' }, headers: s.agent });
  assert.deepEqual(none.body.open_requests, []);
  assert.doesNotMatch(none.body.message, /Open requests/);
});

test('book_installation asks before a second installation request, and registers it with new_request', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  s.crm.openRequests.push({ orderId: '801A', caseNumber: '00001087', kind: 'installation', createdDate: '2026-10-12T05:00:00.000Z' });
  const body = { order_id: 'TD-ORD-1001', phone: '9876543210', preferred_date: '2026-10-17', preferred_time: 'morning' };

  const first = await s.call('POST', '/api/agent/installation', { body, headers: s.agent });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, false);
  assert.equal(first.body.existing_request, true);
  assert.equal(first.body.message, 'An installation request for this order is already open, registered on Monday, 12 October. '
    + 'Ask the customer whether they want an update on that request or a new request. For a new request, call this tool again with new_request set to true.');
  assert.equal(s.crm.created.length, 0);

  const second = await s.call('POST', '/api/agent/installation', { body: { ...body, new_request: true }, headers: s.agent });
  assert.equal(second.body.created, true);
  assert.equal(s.crm.created.at(-1).input.newRequest, true);

  const reschedule = await s.call('POST', '/api/agent/installation', { body: { ...body, reschedule: 'true' }, headers: s.agent });
  assert.equal(reschedule.body.created, true, 'moving the date of the open request is not a second request');
});

test('register_service_request asks before a second request of the same kind', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  s.crm.openRequests.push({ orderId: '801A', caseNumber: '00001081', kind: 'replacement', createdDate: '2026-10-13T05:00:00.000Z' });
  const body = { issue_type: 'return', description: 'Customer wants to return the wardrobe.', order_id: '1001', phone: '9876543210' };

  const first = await s.call('POST', '/api/agent/cases', { body, headers: s.agent });
  assert.equal(first.body.existing_request, true);
  assert.match(first.body.message, /^A replacement or return request for this order is already open, registered on Tuesday, 13 October\./);

  const second = await s.call('POST', '/api/agent/cases', { body: { ...body, new_request: 'true' }, headers: s.agent });
  assert.equal(second.body.created, true);

  const other = await s.call('POST', '/api/agent/cases', { body: { ...body, issue_type: 'missing_parts', description: 'Shelf pins missing' }, headers: s.agent });
  assert.equal(other.body.created, true, 'a different kind is registered at once');
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
