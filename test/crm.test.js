const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrm, SERVICE_TYPES, escapeSoql, escapeSosl } = require('../src/crm/crm');

function fakeSalesforce({ queries = {}, search = [], describe = {} } = {}) {
  const log = { queries: [], searches: [], creates: [], updates: [], batches: [], deletes: [], describes: [] };
  return {
    log,
    async query(soql) {
      log.queries.push(soql);
      const hit = Object.entries(queries).find(([match]) => soql.includes(match));
      return hit ? hit[1](soql) : [];
    },
    async search(sosl) {
      log.searches.push(sosl);
      return search;
    },
    async describe(sobject) {
      log.describes.push(sobject);
      if (!describe[sobject]) throw new Error(`Salesforce request failed (404): NOT_FOUND ${sobject}`);
      return describe[sobject];
    },
    async create(sobject, fields) {
      log.creates.push({ sobject, fields });
      return { id: `${sobject}-${log.creates.length}`, success: true };
    },
    async createMany(sobject, records) {
      log.batches.push({ sobject, records });
      return records.map((_, i) => `${sobject}-B${i + 1}`);
    },
    async update(sobject, id, fields) {
      log.updates.push({ sobject, id, fields });
      return null;
    },
    async remove(sobject, id) {
      log.deletes.push({ sobject, id });
      return null;
    },
  };
}

const open = { isOpen: async () => true };
const closed = { isOpen: async () => false };

// The org's data for one delivered order on Aarav's account, as the REST API returns it.
const ORG = {
  'FROM Order ': (soql) => (soql.includes("'TD-ORD-1001'")
    ? [{ Id: '801A', ERP_Order_Id__c: 'TD-ORD-1001', Invoice_Number__c: 'INV-2001', Order_Source__c: 'Website', Delivery_Status__c: 'Delivered', Delivery_Date__c: '2026-10-14', AccountId: '001A', Account: { Name: 'Demo Customer - Aarav Sharma' }, ShippingCity: null, ShippingPostalCode: null }]
    : []),
  "FROM Contact WHERE AccountId = '001A'": () => [{ Id: '003Z', FirstName: 'Other', LastName: 'Family', AccountId: '001A', MobilePhone: null }, { Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '+91 98100 00001' }],
  "FROM Account WHERE Id = '001A'": () => [{ BillingCity: 'Delhi', BillingState: 'Delhi', BillingPostalCode: '110001' }],
  'FROM RecordType': () => [
    { Id: '012RT-DMG', DeveloperName: 'Damage_Defect_Complaint' },
    { Id: '012RT-GEN', DeveloperName: 'General_Service_Query' },
    { Id: '012RT-INS', DeveloperName: 'Installation_Request' },
    { Id: '012RT-REP', DeveloperName: 'Replacement_Request' },
  ],
  "Part_Number__c = 'S01-PNL-002'": () => [{ Id: 'a0PART' }],
  'SELECT CaseNumber, Service_Route__c FROM Case': () => [{ CaseNumber: '00001100', Service_Route__c: 'Internal' }],
};

test('every issue type maps to the org restricted Service Type and Sub-Type values', () => {
  const serviceTypes = ['Installation', 'Damage or Defect', 'Replacement', 'General Query'];
  const subTypes = [
    'Initial Installation', 'Installation After Replacement Part', 'Re-installation', 'Installation Rescheduling',
    'Installation Follow-up', 'Damaged Component', 'Defective Component', 'Missing Component', 'Wrong Component',
    'Damage During Delivery', 'Product Quality Issue', 'Other Product Issue',
  ];
  for (const [issue, m] of Object.entries(SERVICE_TYPES)) {
    assert.ok(serviceTypes.includes(m.serviceType), `${issue} service type`);
    assert.ok(m.subType === null || subTypes.includes(m.subType), `${issue} sub-type`);
  }
  assert.deepEqual(SERVICE_TYPES.missing_parts, { serviceType: 'Damage or Defect', subType: 'Missing Component' });
});

test('escaping keeps quotes and SOSL operators from breaking queries', () => {
  assert.equal(escapeSoql("O'Brien\\x"), "O\\'Brien\\\\x");
  assert.equal(escapeSosl('98765-43210'), '98765\\-43210');
});

test('findContactByPhone matches on the last ten digits, whatever the stored format', async () => {
  const sf = fakeSalesforce({
    search: [
      { Id: '003X', FirstName: 'Other', LastName: 'Person', MobilePhone: '(111) 654-3210' },
      { Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '(987) 654-3210' },
    ],
  });
  const crm = createCrm({ salesforce: sf });
  const contact = await crm.findContactByPhone('+91 98765 43210');
  assert.match(sf.log.searches[0], /^FIND \{9876543210\} IN PHONE FIELDS RETURNING Contact\(/);
  assert.equal(contact.id, '003A');
  assert.equal(contact.name, 'Aarav Sharma');
  assert.equal(contact.accountId, '001A');

  assert.equal(await crm.findContactByPhone('123'), null);
  assert.equal(sf.log.searches.length, 1, 'an unusable number never reaches Salesforce');
  assert.equal(sf.log.queries.length, 0, 'a search hit needs no second lookup');
});

test('findContactByPhone finds a contact created moments ago, before search has indexed it', async () => {
  const sf = fakeSalesforce({
    search: [],
    queries: { 'FROM Contact WHERE MobilePhone IN': () => [{ Id: '003NEW', FirstName: 'Voice', LastName: 'Caller', AccountId: '001NEW', MobilePhone: '+919000000099' }] },
  });
  const contact = await createCrm({ salesforce: sf }).findContactByPhone('090000 00099');
  assert.equal(contact.id, '003NEW');
  assert.match(sf.log.queries[0], /WHERE MobilePhone IN \('\+919000000099', '9000000099'\) OR Phone IN \('\+919000000099', '9000000099'\) ORDER BY CreatedDate LIMIT 1$/);
});

test('getOrderByErpId reads the org order fields and line items', async () => {
  const sf = fakeSalesforce({
    queries: {
      'FROM Order ': () => [{ Id: '801A', OrderNumber: '00000101', ERP_Order_Id__c: "TD-ORD-'1", Invoice_Number__c: 'INV-2001', Delivery_Status__c: 'Delivered', AccountId: '001A', Account: { Name: 'Aarav' }, CustomerAuthorizedById: '003A', ShippingCity: 'Delhi' }],
      'FROM OrderItem': () => [{ Product2: { Name: 'Demo 3-Door Wardrobe', ProductCode: 'TD-WRD-3D' }, Quantity: 1 }, { Product2: { Name: 'Demo Shoe Cabinet' }, Quantity: 2 }],
    },
  });
  const order = await createCrm({ salesforce: sf }).getOrderByErpId("TD-ORD-'1");
  assert.match(sf.log.queries[0], /WHERE ERP_Order_Id__c = 'TD-ORD-\\'1'/);
  assert.equal(order.erpOrderId, "TD-ORD-'1");
  assert.equal(order.deliveryStatus, 'Delivered');
  assert.equal(order.contactId, '003A');
  assert.equal(order.productSummary, 'Demo 3-Door Wardrobe, Demo Shoe Cabinet');
});

test('getOrderContact falls back to the account contact when the authorising contact has no number', async () => {
  const sf = fakeSalesforce({
    queries: {
      "WHERE Id = '003A'": () => [{ Id: '003A', FirstName: 'No', LastName: 'Phone' }],
      "WHERE AccountId = '001A'": () => [{ Id: '003B', FirstName: 'Has', LastName: 'Mobile', MobilePhone: '9876543210' }],
    },
  });
  const contact = await createCrm({ salesforce: sf }).getOrderContact({ contactId: '003A', accountId: '001A' });
  assert.equal(contact.id, '003B');
});

test('verifyOrder accepts the invoice number as the second factor', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  const result = await createCrm({ salesforce: sf, businessHours: open }).verifyOrder(' TD-ORD-1001 ', 'inv-2001');
  assert.match(sf.log.queries[0], /WHERE ERP_Order_Id__c = 'TD-ORD-1001'/);
  assert.equal(result.found, true);
  assert.equal(result.customerName, 'Demo Customer - Aarav Sharma');
  assert.equal(result.deliveryStatus, 'Delivered');
  assert.equal(result.contactId, '003Z', 'without a matching mobile the first contact on the account is used');
});

test('verifyOrder accepts any mobile on the order account, whatever its format', async () => {
  const result = await createCrm({ salesforce: fakeSalesforce({ queries: ORG }), businessHours: open }).verifyOrder('TD-ORD-1001', '9810000001');
  assert.equal(result.found, true);
  assert.equal(result.contactId, '003A');
});

test('verifyOrder gives the same answer for a wrong factor and an unknown order', async () => {
  const crm = createCrm({ salesforce: fakeSalesforce({ queries: ORG }), businessHours: open });
  assert.deepEqual(await crm.verifyOrder('TD-ORD-1001', 'INV-9999'), { found: false });
  assert.deepEqual(await crm.verifyOrder('TD-ORD-1001', '9820011111'), { found: false });
  const unknown = createCrm({ salesforce: fakeSalesforce(), businessHours: open });
  assert.deepEqual(await unknown.verifyOrder('TD-ORD-9999', 'INV-2001'), { found: false });
});

test('verifyOrder does not touch Salesforce without a second factor', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  assert.deepEqual(await createCrm({ salesforce: sf, businessHours: open }).verifyOrder('TD-ORD-1001', ''), { found: false });
  assert.equal(sf.log.queries.length, 0);
});

test('createServiceCase saves a classified phone case linked to the verified order, contact and part', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  const result = await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({
    issueType: 'delivery_damage',
    description: 'Side panel cracked when the box was opened',
    phone: '+919810000001',
    erpOrderId: 'TD-ORD-1001',
    partNumber: 'S01-PNL-002',
    partName: 'Side Panel',
    quantity: 1,
  });

  assert.deepEqual(result, { created: true, caseId: 'Case-1', caseNumber: '00001100', serviceRoute: 'Internal', withinBusinessHours: true, orderVerified: true });
  assert.equal(sf.log.creates.length, 1, 'no account or contact is created for a known customer');
  const { sobject, fields } = sf.log.creates[0];
  assert.equal(sobject, 'Case');
  assert.deepEqual({ ...fields, Description: undefined }, {
    RecordTypeId: '012RT-DMG',
    Subject: 'Damage or Defect - TD-ORD-1001',
    Description: undefined,
    Origin: 'Phone',
    ContactId: '003A',
    Service_Type__c: 'Damage or Defect',
    Service_Sub_Type__c: 'Damage During Delivery',
    Order__c: '801A',
    Invoice_Number__c: 'INV-2001',
    Order_Source__c: 'Website',
    Customer_Mobile__c: '+919810000001',
    Damaged_Component__c: 'a0PART',
    Service_City__c: 'Delhi',
    Service_State__c: 'Delhi',
    Service_PIN__c: '110001',
  });
  assert.match(fields.Description, /^Side panel cracked when the box was opened\nPart \/ component: Side Panel\nPart number: S01-PNL-002\nQuantity: 1\nOrder id given: TD-ORD-1001\nCaptured by the Sarvam AI voice agent\.$/);
  assert.equal('Status' in fields, false, 'new cases keep the default status');
  assert.equal(sf.log.updates.length, 0, 'everything is set when the case is created');
});

test('a location the customer gives wins over the order account address', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({
    issueType: 'installation', description: 'Install', phone: '+919810000001', erpOrderId: 'TD-ORD-1001', city: 'Gurugram', postalCode: '122002',
  });
  const { fields } = sf.log.creates[0];
  assert.equal(fields.Service_City__c, 'Gurugram');
  assert.equal(fields.Service_PIN__c, '122002');
  assert.equal(fields.RecordTypeId, '012RT-INS');
  assert.equal(sf.log.queries.some((q) => q.includes('FROM Account')), false);
});

test('an unknown caller gets an account and contact before the case is saved', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  const result = await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({
    issueType: 'general', description: 'Warranty question', phone: '+919000000001', customerName: 'Ravi Kumar Verma', city: 'Pune',
  });
  assert.equal(result.orderVerified, false);
  assert.deepEqual(sf.log.creates.map((c) => c.sobject), ['Account', 'Contact', 'Case']);
  assert.deepEqual(sf.log.creates[0].fields, { Name: 'Ravi Kumar Verma' });
  assert.deepEqual(sf.log.creates[1].fields, { AccountId: 'Account-1', FirstName: 'Ravi', LastName: 'Kumar Verma', MobilePhone: '+919000000001' });
  assert.equal(sf.log.creates[2].fields.ContactId, 'Contact-2');
  assert.equal(sf.log.creates[2].fields.Subject, 'General Query');
});

test('new caller accounts use the configured customer record type', async () => {
  const sf = fakeSalesforce({ queries: { "DeveloperName = 'Customer'": () => [{ Id: '012CUST' }], ...ORG } });
  const crm = createCrm({ salesforce: sf, businessHours: open, customerAccountRecordType: 'Customer' });
  await crm.createServiceCase({ issueType: 'general', description: 'x', phone: '+919000000001', customerName: 'Ravi Kumar' });
  await crm.createServiceCase({ issueType: 'general', description: 'y', phone: '+919000000002', customerName: 'Asha Rao' });
  const accounts = sf.log.creates.filter((c) => c.sobject === 'Account');
  assert.deepEqual(accounts.map((a) => a.fields.RecordTypeId), ['012CUST', '012CUST']);
  assert.equal(sf.log.queries.filter((q) => q.includes("SobjectType = 'Account'")).length, 1, 'looked up once');
});

test('an existing contact is reused when the order cannot be verified', async () => {
  const sf = fakeSalesforce({ queries: ORG, search: [{ Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '+919810000001' }] });
  await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({ issueType: 'damaged', description: 'Door scratched', phone: '+919810000001', erpOrderId: 'TD-ORD-9999' });
  assert.deepEqual(sf.log.creates.map((c) => c.sobject), ['Case']);
  assert.equal(sf.log.creates[0].fields.ContactId, '003A');
  assert.equal('Order__c' in sf.log.creates[0].fields, false);
  assert.match(sf.log.creates[0].fields.Description, /Order id given: TD-ORD-9999/);
});

test('escalations are created as Escalated general queries', async () => {
  const sf = fakeSalesforce({ queries: ORG, search: [{ Id: '003A', AccountId: '001A', MobilePhone: '+919810000001' }] });
  await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({ issueType: 'escalation', description: 'Wants a manager', phone: '+919810000001' });
  const { fields } = sf.log.creates[0];
  assert.equal(fields.Status, 'Escalated');
  assert.equal(fields.RecordTypeId, '012RT-GEN');
  assert.match(fields.Description, /^Customer asked for a service team member to call back\.\nWants a manager/);
});

test('a request outside business hours is marked for the team', async () => {
  const sf = fakeSalesforce({ queries: ORG, search: [{ Id: '003A', AccountId: '001A', MobilePhone: '+919810000001' }] });
  const result = await createCrm({ salesforce: sf, businessHours: closed }).createServiceCase({ issueType: 'general', description: 'Late question', phone: '+919810000001' });
  assert.equal(result.withinBusinessHours, false);
  assert.match(sf.log.creates[0].fields.Description, /^\[Received outside business hours\]\nLate question/);
});

test('a business hours failure does not block the request', async () => {
  const sf = fakeSalesforce({ queries: ORG, search: [{ Id: '003A', AccountId: '001A', MobilePhone: '+919810000001' }] });
  const broken = { isOpen: async () => { throw new Error('INVALID_TYPE'); } };
  const result = await createCrm({ salesforce: sf, businessHours: broken }).createServiceCase({ issueType: 'general', description: 'x', phone: '+919810000001' });
  assert.equal(result.created, true);
  assert.equal(result.withinBusinessHours, true);
});

test('requests without a description or a way to reach the customer are refused before anything is saved', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  const crm = createCrm({ salesforce: sf, businessHours: open });
  assert.deepEqual(await crm.createServiceCase({ issueType: 'general', description: '  ', phone: '+919810000001' }), { created: false, error: 'A description of the issue is required.' });
  assert.deepEqual(await crm.createServiceCase({ issueType: 'general', description: 'x' }), { created: false, error: 'A mobile number is needed to register the request.' });
  assert.deepEqual(await crm.createServiceCase({ issueType: 'general', description: 'x', erpOrderId: 'TD-ORD-1001', invoiceNumber: 'INV-9' }), { created: false, error: 'A mobile number is needed to register the request.' });
  assert.equal(sf.log.creates.length, 0);
});

test('a verified order alone is enough to register without a mobile', async () => {
  const sf = fakeSalesforce({ queries: ORG });
  const result = await createCrm({ salesforce: sf, businessHours: open }).createServiceCase({ issueType: 'replacement', description: 'Need a new shelf', erpOrderId: 'TD-ORD-1001', invoiceNumber: 'INV-2001' });
  assert.equal(result.created, true);
  assert.equal(sf.log.creates[0].fields.RecordTypeId, '012RT-REP');
  assert.equal(sf.log.creates[0].fields.ContactId, '003Z');
});

test('a Salesforce error while saving is not hidden', async () => {
  const sf = fakeSalesforce({ queries: ORG, search: [{ Id: '003A', AccountId: '001A', MobilePhone: '+919810000001' }] });
  sf.create = async () => { throw new Error('Salesforce request failed (400): FIELD_CUSTOM_VALIDATION_EXCEPTION'); };
  await assert.rejects(
    createCrm({ salesforce: sf, businessHours: open }).createServiceCase({ issueType: 'general', description: 'x', phone: '+919810000001' }),
    /FIELD_CUSTOM_VALIDATION_EXCEPTION/,
  );
});

test('getCaseStatus pads case numbers and includes the latest visit and shipment', async () => {
  const sf = fakeSalesforce({
    queries: {
      'FROM Case': () => [{
        Id: '500X', CaseNumber: '00001063', AccountId: '001A', Service_Type__c: 'Installation', Status: 'Appointment Scheduled',
        Order__r: { ERP_Order_Id__c: 'TD-ORD-1001' },
        Service_Visits__r: { records: [{ Status__c: 'Appointment Scheduled', Scheduled_Start__c: '2026-10-16T05:30:00Z', Technician__r: { Name: 'Demo Tech - Vikram (Internal)' } }] },
        Replacement_Shipments__r: null,
      }],
    },
  });
  const [c] = await createCrm({ salesforce: sf }).getCaseStatus({ caseNumber: 'case 1063' });
  assert.match(sf.log.queries[0], /CaseNumber = '00001063'/);
  assert.match(sf.log.queries[0], /FROM Service_Visits__r/);
  assert.match(sf.log.queries[0], /FROM Replacement_Shipments__r/);
  assert.equal(c.id, '500X');
  assert.equal(c.erpOrderId, 'TD-ORD-1001');
  assert.deepEqual(c.visit, { status: 'Appointment Scheduled', scheduledStart: '2026-10-16T05:30:00Z', technician: 'Demo Tech - Vikram (Internal)' });
  assert.equal(c.shipment, null);
});

test('getOrderByInvoice looks the order up by invoice number', async () => {
  const sf = fakeSalesforce({ queries: { 'FROM Order ': () => [{ Id: '801A', ERP_Order_Id__c: 'TD-ORD-1001', Invoice_Number__c: 'INV-2001' }] } });
  const order = await createCrm({ salesforce: sf }).getOrderByInvoice(' INV-2001 ');
  assert.match(sf.log.queries[0], /WHERE Invoice_Number__c = 'INV-2001'/);
  assert.equal(order.erpOrderId, 'TD-ORD-1001');
});

test('findParts lists the components of the products on an order', async () => {
  const sf = fakeSalesforce({
    queries: {
      'FROM Order ': () => [{ Id: '801A', ERP_Order_Id__c: 'TD-ORD-1001' }],
      'FROM OrderItem': () => [{ Product2Id: '01tW', Product2: { Name: 'Demo 3-Door Wardrobe' }, Quantity: 1 }],
      'FROM Product_Component__c': () => [{ Name: 'Demo 3-Door Wardrobe - Hardware Kit', Part_Number__c: 'WRD-3D-HDW-001', Product__r: { Name: 'Demo 3-Door Wardrobe' } }],
    },
  });
  const parts = await createCrm({ salesforce: sf }).findParts({ erpOrderId: 'TD-ORD-1001' });
  assert.match(sf.log.queries.at(-1), /WHERE Product__c IN \('01tW'\)/);
  assert.deepEqual(parts, [{ name: 'Hardware Kit', partNumber: 'WRD-3D-HDW-001', productName: 'Demo 3-Door Wardrobe' }]);
});

test('findParts by product name escapes LIKE wildcards', async () => {
  const sf = fakeSalesforce();
  await createCrm({ salesforce: sf }).findParts({ productName: "kid's 100%_bed" });
  assert.match(sf.log.queries[0], /Product__r\.Name LIKE '%kid\\'s 100\\%\\_bed%'/);
  assert.deepEqual(await createCrm({ salesforce: sf }).findParts({}), []);
});

test('findParts returns nothing for an order without products', async () => {
  const sf = fakeSalesforce();
  assert.deepEqual(await createCrm({ salesforce: sf }).findParts({ erpOrderId: 'TD-ORD-0' }), []);
  assert.equal(sf.log.queries.some((q) => q.includes('Product_Component__c')), false);
});

test('getCaseNotice gathers the customer number, visit and shipment', async () => {
  const sf = fakeSalesforce({
    queries: {
      'FROM Case': () => [{
        Id: '500Y', CaseNumber: '00001060', Service_Type__c: 'Damage or Defect', Status: 'Replacement Dispatched',
        Customer_Mobile__c: null, ContactId: '003B', Contact: { FirstName: 'Meera', LastName: 'Iyer', MobilePhone: null, Phone: '+91 98200 11111' },
        Order__r: { ERP_Order_Id__c: 'TD-ORD-1111' },
        Service_Visits__r: null,
        Replacement_Shipments__r: { records: [{ Id: 'a01', Shipment_Status__c: 'Dispatched', Expected_Delivery_Date__c: '2026-10-18', Courier__c: 'BlueDart', Component__r: { Name: 'Demo Bookcase - Side Panel' } }] },
      }],
    },
  });
  const notice = await createCrm({ salesforce: sf }).getCaseNotice({ caseNumber: '1060' });
  assert.match(sf.log.queries[0], /CaseNumber = '00001060'/);
  assert.equal(notice.phone, '+91 98200 11111', 'falls back to the contact number');
  assert.equal(notice.customerName, 'Meera Iyer');
  assert.equal(notice.shipment.courier, 'BlueDart');
  assert.equal(notice.visit, null);
  assert.equal(await createCrm({ salesforce: sf }).getCaseNotice({}), null);
});

test('findVoiceCaseSince filters phone cases for the number since the call started', async () => {
  const sf = fakeSalesforce({ queries: { 'FROM Case': () => [{ Id: '500A', CaseNumber: '00001100' }] } });
  const found = await createCrm({ salesforce: sf }).findVoiceCaseSince('+919876543210', '2026-10-14T06:30:12.345Z');
  assert.match(sf.log.queries[0], /Origin = 'Phone' AND Customer_Mobile__c = '\+919876543210' AND CreatedDate >= 2026-10-14T06:30:12Z /);
  assert.deepEqual(found, { id: '500A', caseNumber: '00001100' });
  assert.equal(await createCrm({ salesforce: sf }).findVoiceCaseSince('+919876543210', 'garbage'), null);
});

test('logCall writes a completed call Task', async () => {
  const sf = fakeSalesforce();
  await createCrm({ salesforce: sf }).logCall({
    subject: 'AI voice agent call (outbound)',
    description: 'Summary',
    contactId: '003A',
    relatedId: '801A',
    direction: 'outbound',
    durationSeconds: 92.6,
    disposition: 'delivered_ok',
    callId: 'int-1',
    activityDate: '2026-10-14',
  });
  assert.deepEqual(sf.log.creates[0], {
    sobject: 'Task',
    fields: {
      Subject: 'AI voice agent call (outbound)',
      Description: 'Summary',
      WhoId: '003A',
      WhatId: '801A',
      Status: 'Completed',
      TaskSubtype: 'Call',
      ActivityDate: '2026-10-14',
      CallType: 'Outbound',
      CallDisposition: 'delivered_ok',
      CallObject: 'int-1',
      CallDurationInSeconds: 93,
    },
  });
  assert.equal('Type' in sf.log.creates[0].fields, false, 'this org has no Task.Type field');
});

// The standard price book and India's state picklist, as the org returns them.
const CATALOG = [
  { Id: '01uSTD', UnitPrice: 8999, Pricebook2Id: '01sSTD', Product2Id: '01tSTD', Product2: { Name: 'Demo Study Table', ProductCode: 'TD-STD-01' } },
  { Id: '01uPRM', UnitPrice: 15999, Pricebook2Id: '01sSTD', Product2Id: '01tPRM', Product2: { Name: 'Demo Premium Height-Adjustable Study Table', ProductCode: 'TD-STD-PR' } },
  { Id: '01uCHR', UnitPrice: 4999, Pricebook2Id: '01sSTD', Product2Id: '01tCHR', Product2: { Name: 'Demo Ergonomic Study Chair', ProductCode: 'TD-CHR-01' } },
  { Id: '01uBKC', UnitPrice: 7499, Pricebook2Id: '01sSTD', Product2Id: '01tBKC', Product2: { Name: 'Demo Bookcase', ProductCode: 'TD-BKC-01' } },
];

// validFor is a bitmap over the country list: AU is bit 0, IN is bit 1.
const ORDER_DESCRIBE = {
  fields: [
    { name: 'ShippingCountryCode', picklistValues: [{ value: 'AU', label: 'Australia', active: true }, { value: 'IN', label: 'India', active: true }] },
    {
      name: 'ShippingStateCode',
      picklistValues: [
        { value: 'DL', label: 'Delhi', active: true, validFor: 'QA==' },
        { value: 'HR', label: 'Haryana', active: true, validFor: 'QA==' },
        { value: 'OD', label: 'Odisha', active: true, validFor: 'QA==' },
        { value: 'WA', label: 'Western Australia', active: true, validFor: 'gA==' },
        { value: 'XX', label: 'Retired State', active: false, validFor: 'QA==' },
      ],
    },
  ],
};

const AARAV = { Id: '003A', FirstName: 'Aarav', LastName: 'Sharma', AccountId: '001A', MobilePhone: '+91 98100 00001' };
const ORDER_INPUT = {
  customerName: 'Aarav Sharma',
  phone: '+919810000001',
  items: 'TD-STD-01 x 1, td-chr-01 x 2',
  address: ' 12 MG Road ',
  city: 'New Delhi',
  state: 'new delhi',
  postalCode: '110 001',
};
// 01:30 on 15 October in India, still 14 October in UTC.
const lateEvening = () => Date.parse('2026-10-14T20:00:00Z');

function orderOrg({ search = [], describe = { Order: ORDER_DESCRIBE } } = {}) {
  return fakeSalesforce({
    queries: {
      'FROM PricebookEntry': () => CATALOG,
      'SELECT OrderNumber, TotalAmount FROM Order': () => [{ OrderNumber: '00000120', TotalAmount: 18997 }],
    },
    search,
    describe,
  });
}

test('createOrder saves a Draft order with price book lines for a known caller', async () => {
  const sf = orderOrg({ search: [AARAV] });
  const result = await createCrm({ salesforce: sf, businessHours: open, now: lateEvening }).createOrder({ ...ORDER_INPUT, notes: 'Ring the bell twice' });
  assert.deepEqual(result, {
    created: true,
    orderId: 'Order-1',
    orderNumber: '00000120',
    total: 18997,
    lines: [
      { name: 'Demo Study Table', productCode: 'TD-STD-01', quantity: 1, unitPrice: 8999 },
      { name: 'Demo Ergonomic Study Chair', productCode: 'TD-CHR-01', quantity: 2, unitPrice: 4999 },
    ],
    newCustomer: false,
  });
  assert.deepEqual(sf.log.creates.map((c) => c.sobject), ['Order'], 'the caller account and contact are reused');
  const { fields } = sf.log.creates[0];
  assert.deepEqual({ ...fields, Description: undefined }, {
    AccountId: '001A',
    CustomerAuthorizedById: '003A',
    EffectiveDate: '2026-10-15',
    Status: 'Draft',
    Pricebook2Id: '01sSTD',
    Order_Source__c: 'Other',
    Description: undefined,
    ShippingStreet: '12 MG Road',
    ShippingCity: 'New Delhi',
    ShippingPostalCode: '110001',
    ShippingCountryCode: 'IN',
    ShippingStateCode: 'DL',
  });
  assert.equal(fields.Description, [
    'Placed by phone through the Sarvam AI voice agent.',
    'Confirm the final price, delivery charges, delivery date and payment with the customer before activating.',
    'Customer notes: Ring the bell twice',
  ].join('\n'));
  assert.deepEqual(sf.log.batches, [{
    sobject: 'OrderItem',
    records: [
      { OrderId: 'Order-1', PricebookEntryId: '01uSTD', Quantity: 1, UnitPrice: 8999 },
      { OrderId: 'Order-1', PricebookEntryId: '01uCHR', Quantity: 2, UnitPrice: 4999 },
    ],
  }]);
  assert.equal(sf.log.deletes.length, 0);
});

test('a new caller gets an account with the billing address and a contact before the order', async () => {
  const sf = orderOrg();
  const result = await createCrm({ salesforce: sf, businessHours: open, now: lateEvening }).createOrder({
    ...ORDER_INPUT, customerName: 'Ravi Kumar Verma', phone: '+919000000001', city: 'Gurugram', state: 'Haryana', postalCode: '122002',
  });
  assert.equal(result.newCustomer, true);
  assert.deepEqual(sf.log.creates.map((c) => c.sobject), ['Account', 'Contact', 'Order']);
  assert.deepEqual(sf.log.creates[0].fields, {
    Name: 'Ravi Kumar Verma', BillingStreet: '12 MG Road', BillingCity: 'Gurugram', BillingPostalCode: '122002', BillingCountryCode: 'IN', BillingStateCode: 'HR',
  });
  assert.deepEqual(sf.log.creates[1].fields, { AccountId: 'Account-1', FirstName: 'Ravi', LastName: 'Kumar Verma', MobilePhone: '+919000000001' });
  assert.equal(sf.log.creates[2].fields.AccountId, 'Account-1');
  assert.equal(sf.log.creates[2].fields.CustomerAuthorizedById, 'Contact-2');
  assert.doesNotMatch(sf.log.creates[2].fields.Description, /gave the name/);
});

test('a different name on a known mobile is noted for the sales team', async () => {
  const sf = orderOrg({ search: [AARAV] });
  await createCrm({ salesforce: sf, businessHours: open, now: lateEvening }).createOrder({ ...ORDER_INPUT, customerName: 'Rahul Mehta' });
  const { fields } = sf.log.creates[0];
  assert.equal(fields.AccountId, '001A', 'the order stays with the owner of the mobile');
  assert.match(fields.Description, /\nThe caller gave the name Rahul Mehta; the mobile belongs to Aarav Sharma\.$/);
});

test('a state that is not an Indian state is left out of the address instead of failing the order', async () => {
  for (const state of ['Atlantis', 'Western Australia', 'Retired State', undefined]) {
    const sf = orderOrg({ search: [AARAV] });
    const result = await createCrm({ salesforce: sf, businessHours: open, now: lateEvening }).createOrder({ ...ORDER_INPUT, state });
    assert.equal(result.created, true, String(state));
    assert.equal('ShippingStateCode' in sf.log.creates[0].fields, false, String(state));
    assert.equal(sf.log.creates[0].fields.ShippingCountryCode, 'IN');
  }
  const noDescribe = orderOrg({ search: [AARAV], describe: {} });
  assert.equal((await createCrm({ salesforce: noDescribe, businessHours: open }).createOrder(ORDER_INPUT)).created, true, 'a describe failure is not fatal');
});

test('order requests are checked before anything is saved', async () => {
  const sf = orderOrg({ search: [AARAV] });
  const crm = createCrm({ salesforce: sf, businessHours: open, now: lateEvening });
  const quantityLimit = 'Quantities from 1 to 10 can be ordered by phone. Offer a call back from the sales team for larger quantities.';
  const refusals = [
    [{ phone: '' }, 'A valid mobile number is needed to place the order.'],
    [{ items: '' }, 'No product was given. Ask which product and how many.'],
    [{ items: 'a big study table' }, 'No product code was given in "a big study table". Check the product with find_products.'],
    [{ items: 'TD-SOFA-01 x 1' }, 'Product code TD-SOFA-01 is not in the catalog. Check the product with find_products.'],
    [{ items: 'TD-STD-01 x 11' }, quantityLimit],
    [{ items: 'TD-STD-01 x 0' }, quantityLimit],
    [{ items: 'TD-STD-01 x 6, TD-STD-01 x 5' }, quantityLimit],
    [{ items: Array.from({ length: 11 }, (_, i) => `TD-X${i}-01`).join(', ') }, 'Up to 10 different products can be ordered by phone. Offer a call back from the sales team for larger orders.'],
    [{ address: ' ' }, 'The delivery address and city are needed.'],
    [{ city: undefined }, 'The delivery address and city are needed.'],
    [{ postalCode: '11001' }, 'A valid six digit PIN code is needed for delivery.'],
    [{ postalCode: '011001' }, 'A valid six digit PIN code is needed for delivery.'],
  ];
  for (const [change, error] of refusals) {
    assert.deepEqual(await crm.createOrder({ ...ORDER_INPUT, ...change }), { created: false, error }, JSON.stringify(change));
  }
  assert.equal(sf.log.creates.length, 0);
  assert.equal(sf.log.batches.length, 0);
  assert.equal(sf.log.searches.length, 0, 'the caller is not looked up for a refused order');
});

test('if the order lines are refused the draft order is deleted and the error is passed on', async () => {
  const sf = orderOrg({ search: [AARAV] });
  sf.createMany = async () => { throw new Error('Salesforce rejected OrderItem records: FIELD_INTEGRITY_EXCEPTION'); };
  await assert.rejects(createCrm({ salesforce: sf, businessHours: open }).createOrder(ORDER_INPUT), /FIELD_INTEGRITY_EXCEPTION/);
  assert.deepEqual(sf.log.deletes, [{ sobject: 'Order', id: 'Order-1' }]);
});

test('findProducts searches the TD- price book entries by every word, then by any word', async () => {
  const sf = orderOrg();
  let clock = Date.parse('2026-10-14T06:30:00Z');
  const crm = createCrm({ salesforce: sf, businessHours: open, now: () => clock });
  const codes = async (query) => (await crm.findProducts(query)).map((p) => p.productCode);
  assert.deepEqual(await codes('study table'), ['TD-STD-01', 'TD-STD-PR']);
  assert.deepEqual(await codes('Study Chairs'), ['TD-CHR-01'], 'plurals match');
  assert.deepEqual(await codes('wooden bookcase'), ['TD-BKC-01'], 'an unknown word does not hide a match');
  assert.deepEqual(await codes('td-bkc-01'), ['TD-BKC-01']);
  assert.deepEqual(await codes('sofa'), []);
  assert.equal((await crm.findProducts('')).length, 4);
  assert.equal((await crm.findProducts('what furniture products do you have')).length, 4, 'a general question lists everything');
  assert.deepEqual(await codes('I want to buy a new bookcase'), ['TD-BKC-01']);
  assert.deepEqual(await crm.findProducts('bookcase'), [
    { pricebookEntryId: '01uBKC', pricebookId: '01sSTD', productId: '01tBKC', name: 'Demo Bookcase', productCode: 'TD-BKC-01', unitPrice: 7499 },
  ]);
  assert.equal(sf.log.queries.length, 1, 'the catalog is cached');
  assert.match(sf.log.queries[0], /FROM PricebookEntry WHERE Pricebook2\.IsStandard = true AND IsActive = true AND Product2\.IsActive = true AND Product2\.ProductCode LIKE 'TD-%' /);
  clock += 11 * 60 * 1000;
  await crm.findProducts('desk');
  assert.equal(sf.log.queries.length, 2, 'and reloaded after ten minutes');

  const unfiltered = orderOrg();
  await createCrm({ salesforce: unfiltered, businessHours: open, productCodePrefix: '' }).findProducts('desk');
  assert.doesNotMatch(unfiltered.log.queries[0], /LIKE/);
});

test('indianStateCode reads the Indian states from the Order describe, by name, code or common alias', async () => {
  const sf = orderOrg();
  const crm = createCrm({ salesforce: sf });
  assert.equal(await crm.indianStateCode('Delhi'), 'DL');
  assert.equal(await crm.indianStateCode(' new delhi '), 'DL');
  assert.equal(await crm.indianStateCode('hr'), 'HR');
  assert.equal(await crm.indianStateCode('Orissa'), 'OD');
  assert.equal(await crm.indianStateCode('Western Australia'), undefined, 'states of other countries are ignored');
  assert.equal(await crm.indianStateCode('Retired State'), undefined, 'inactive states are ignored');
  assert.equal(await crm.indianStateCode(''), undefined);
  assert.deepEqual(sf.log.describes, ['Order'], 'described once');
});

test('verifyOrder also accepts the Salesforce order number of a phone order', async () => {
  const sf = fakeSalesforce({
    queries: {
      'FROM Order ': () => [{ Id: '801P', OrderNumber: '00000120', AccountId: '001A', Account: { Name: 'Aarav Sharma' } }],
      "FROM Contact WHERE AccountId = '001A'": ORG["FROM Contact WHERE AccountId = '001A'"],
    },
  });
  const crm = createCrm({ salesforce: sf, businessHours: open });
  const result = await crm.verifyOrder(' 120 ', '9810000001');
  assert.match(sf.log.queries[0], /WHERE \(ERP_Order_Id__c = '120' OR OrderNumber = '00000120'\) LIMIT 1$/);
  assert.equal(result.found, true);
  assert.equal(result.order.id, '801P');
  assert.equal(result.contactId, '003A');

  await crm.verifyOrder('TD-ORD-1001', '9810000001');
  const orderQueries = sf.log.queries.filter((q) => q.includes('FROM Order '));
  assert.doesNotMatch(orderQueries[1], /OrderNumber =/, 'an ERP id is never read as an order number');
});

test('findVoiceOrderSince finds the order placed during the call by number, else by the caller', async () => {
  const sf = fakeSalesforce({
    queries: {
      "OrderNumber = '00000120'": () => [{ Id: '801P', OrderNumber: '00000120' }],
      "CustomerAuthorizedById = '003A'": () => [{ Id: '801Q', OrderNumber: '00000121' }],
    },
  });
  const crm = createCrm({ salesforce: sf });
  const since = '2026-10-14T06:30:12.345Z';
  assert.deepEqual(await crm.findVoiceOrderSince({ orderNumber: '1 2 0', contactId: '003A', since }), { id: '801P', orderNumber: '00000120' });
  assert.match(sf.log.queries[0], /FROM Order WHERE OrderNumber = '00000120' AND CreatedDate >= 2026-10-14T06:30:12Z ORDER BY CreatedDate DESC LIMIT 1$/);
  assert.deepEqual(await crm.findVoiceOrderSince({ orderNumber: '999', contactId: '003A', since }), { id: '801Q', orderNumber: '00000121' });
  assert.deepEqual(await crm.findVoiceOrderSince({ contactId: '003A', since }), { id: '801Q', orderNumber: '00000121' });
  assert.equal(await crm.findVoiceOrderSince({ orderNumber: '999', since }), null);
  const before = sf.log.queries.length;
  assert.equal(await crm.findVoiceOrderSince({ orderNumber: '120', contactId: '003A', since: 'garbage' }), null);
  assert.equal(await crm.findVoiceOrderSince({ orderNumber: '123456789', since }), null, 'longer than an order number');
  assert.equal(sf.log.queries.length, before);
});
