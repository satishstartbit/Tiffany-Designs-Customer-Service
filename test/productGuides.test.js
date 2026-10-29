const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createProductGuides, guideMessage } = require('../src/crm/productGuides');
const adminRouter = require('../src/routes/admin');
const agentToolsRouter = require('../src/routes/agentTools');

const NOW = Date.parse('2026-10-27T06:00:00Z');
const PRODUCT = { Id: '01tgK00000FbCMXQA3', Name: 'Rocco Walky Kitchen Island', ProductCode: 'TD-KIS-WALKY-L' };

const field = (name, type, extra = {}) => ({ name, type, nillable: true, length: 0, precision: 0, scale: 0, picklistValues: [], ...extra });
const DESCRIBE = {
  fields: [
    field('Name', 'string', { length: 80 }),
    field('Status__c', 'picklist', { length: 255, picklistValues: ['Draft', 'Published', 'Archived'].map((value) => ({ value, active: true })) }),
    field('Brand__c', 'string', { length: 255, nillable: false }),
    field('ProductType__c', 'picklist', { length: 255, picklistValues: ['Storage Cabinet', 'Other'].map((value) => ({ value, active: true })) }),
    field('ModelCode__c', 'string', { length: 255 }),
    field('Version__c', 'string', { length: 255 }),
    field('SetContents__c', 'string', { length: 255, nillable: false }),
    field('TotalParts__c', 'double', { nillable: false, precision: 6, scale: 3 }),
    field('PartsHaveNumberStickers__c', 'boolean', { nillable: false }),
    field('Dimensions__c', 'string', { length: 255 }),
    field('ColourFinish__c', 'string', { length: 255 }),
    field('Material__c', 'string', { length: 255 }),
    field('WeightCapacity__c', 'string', { length: 255 }),
    field('RecommendedAge__c', 'double', { precision: 18 }),
    field('ToolsNeeded__c', 'string', { length: 255 }),
    ...['Overview__c', 'PartsList__c', 'HardwareList__c', 'AssemblySteps__c', 'HardwarePerStep__c', 'AssemblyTips__c', 'DeliveryCheckScript__c',
      'AgentRulesForThisProduct__c', 'WarrantyInformation__c'].map((n) => field(n, 'textarea', { length: 32768 })),
    field('BrandWebsite__c', 'url', { length: 255 }),
    field('BrandSupportEmail__c', 'email', { length: 80 }),
    field('BrandSupportWhatsApp__c', 'phone', { length: 40 }),
    field('BrandSupportHours__c', 'string', { length: 255 }),
    field('AssemblyVideoURL__c', 'url', { length: 255 }),
    field('ManualPDFURL__c', 'url', { length: 255 }),
    field('Source__c', 'string', { length: 255 }),
    field('LastReviewedOn__c', 'date'),
  ],
};

const GUIDE_ROW = {
  Id: 'a0EgK00000AvsVlUAJ',
  Product__c: PRODUCT.Id,
  Product__r: { Name: PRODUCT.Name },
  Product_Code__c: PRODUCT.ProductCode,
  LastModifiedDate: '2026-10-27T05:00:00.000+0000',
  LastModifiedBy: { Name: 'Integration User' },
  Name: 'Rocco Walky Kitchen Island guide',
  Status__c: 'Published',
  Brand__c: 'Rocco',
  SetContents__c: '1 kitchen island: 16 numbered parts and a hardware pack',
  TotalParts__c: 16,
  PartsHaveNumberStickers__c: true,
  Version__c: '1.0',
  PartsList__c: '1. Worktop x 1, part number KIS-WALKY-01\n10. Fluted acrylic doors x 2, part number KIS-WALKY-10',
  HardwareList__c: 'A. Cam bolts, for joining panels\nAll hardware comes in one pack, part number KIS-WALKY-HW.',
  AgentRulesForThisProduct__c: '- The parts carry number stickers 1 to 16.\n- A burning smell is a safety risk.',
  ToolsNeeded__c: 'Phillips screwdriver (not included); Allen key (J, included)',
  AssemblySteps__c: '1. Fit the wheels. Turn the base panel (5) upside down.\n2. Attach the side panels with the cam bolts (A).',
  HardwarePerStep__c: '1. Fit the wheels: E\n2. Attach the side panels: A, J',
  AssemblyTips__c: 'Before you start: unpack everything onto a soft surface.\n\nSafety and care:\n- Do not plug in until assembly is complete.',
  DeliveryCheckScript__c: 'Check one at a time: the worktop and the foldable extension leaf; both side panels.',
};

// Salesforce as the guide module uses it: describe, a few query shapes, create and update.
function fakeSalesforce({ guides: rows = [GUIDE_ROW], refuse = null } = {}) {
  const guides = rows.map((g) => ({ ...g }));
  const calls = { creates: [], updates: [], queries: [] };
  return {
    calls,
    async describe(sobject) {
      assert.equal(sobject, 'Product_Guide__c');
      return DESCRIBE;
    },
    async query(soql) {
      calls.queries.push(soql);
      if (/FROM Product2 WHERE Id = /.test(soql)) return soql.includes(PRODUCT.Id) ? [PRODUCT] : [];
      if (/FROM Product2 WHERE IsActive/.test(soql)) return /kitchen island/i.test(soql) ? [{ Id: PRODUCT.Id }] : [];
      if (/FROM Product_Guide__c WHERE Product__c = /.test(soql)) return guides.filter((g) => soql.includes(g.Product__c));
      if (/FROM Product_Guide__c WHERE Product__c IN/.test(soql)) return guides.filter((g) => soql.includes(g.Product__c) && g.Status__c === 'Published');
      if (/FROM Product_Component__c/.test(soql)) {
        return [
          { Product__c: PRODUCT.Id, Name: 'Rocco Walky Kitchen Island - Worktop', Part_Number__c: 'KIS-WALKY-01' },
          { Product__c: PRODUCT.Id, Name: 'Rocco Walky Kitchen Island - Hardware pack (A to J)', Part_Number__c: 'KIS-WALKY-HW' },
          { Product__c: PRODUCT.Id, Name: 'Rocco Walky Kitchen Island - LED light strip', Part_Number__c: 'KIS-WALKY-14' },
        ];
      }
      throw new Error(`Unexpected query: ${soql}`);
    },
    async create(sobject, fields) {
      calls.creates.push({ sobject, fields });
      if (sobject === 'Product_Guide__c') {
        guides.push({ ...fields, Id: 'a0ENEW', LastModifiedDate: '2026-10-27T06:00:00.000+0000', LastModifiedBy: { Name: 'Integration User' } });
        return { id: 'a0ENEW' };
      }
      return { id: '00T1' };
    },
    async update(sobject, id, fields) {
      if (refuse) throw new Error(refuse);
      calls.updates.push({ sobject, id, fields });
      Object.assign(guides.find((g) => g.Id === id), fields);
    },
  };
}

const quiet = { error() {} };
const setup = (options) => {
  const salesforce = fakeSalesforce(options);
  return { salesforce, guides: createProductGuides({ salesforce, now: () => NOW, logger: quiet }) };
};

test('the console gets the product, its guide and the form limits from the org', async () => {
  const { guides } = setup();
  const result = await guides.getGuide(PRODUCT.Id);
  assert.deepEqual(result.product, { id: PRODUCT.Id, name: PRODUCT.Name, code: PRODUCT.ProductCode });
  assert.equal(result.guide.id, GUIDE_ROW.Id);
  assert.equal(result.guide.values.totalParts, 16);
  assert.equal(result.guide.values.partsHaveNumberStickers, true);
  assert.equal(result.guide.values.warranty, null);
  assert.deepEqual(result.form.options.status, ['Draft', 'Published', 'Archived']);
  assert.deepEqual(result.form.required, ['brand', 'setContents', 'totalParts'], 'a yes or no field always has a value');
  assert.equal(result.form.maxLengths.brandSupportEmail, 80);
  assert.equal(result.form.labels.agentRules, 'Rules for the voice agent');
  assert.equal(await guides.getGuide('not-an-id'), null);
  assert.equal(await guides.getGuide('01tgK00000XXXXXXXX'), null);
});

test('an archived guide gives way to a newer one that is not archived', async () => {
  const archived = { ...GUIDE_ROW, Id: 'a0EOLD', Status__c: 'Archived' };
  const { guides } = setup({ guides: [archived, { ...GUIDE_ROW, Id: 'a0EDRAFT', Status__c: 'Draft' }] });
  assert.equal((await guides.getGuide(PRODUCT.Id)).guide.id, 'a0EDRAFT');
});

test('a product without a guide gets one, named after it, with the required fields', async () => {
  const { salesforce, guides } = setup({ guides: [] });
  assert.equal((await guides.getGuide(PRODUCT.Id)).guide, null);

  const missing = await guides.saveGuide(PRODUCT.Id, { brand: 'Rocco', totalParts: '16' });
  assert.deepEqual(missing, { error: 'invalid', field: 'setContents', message: 'Set contents cannot be empty.' });

  const result = await guides.saveGuide(
    PRODUCT.Id,
    { brand: ' Rocco ', setContents: '1 kitchen island', totalParts: '16', partsHaveNumberStickers: 'true', warranty: '', status: 'Draft' },
    { editedBy: 'staff@tiffanydesigns.in' },
  );
  assert.equal(result.created, true);
  const [guide, note] = salesforce.calls.creates;
  assert.deepEqual(guide, {
    sobject: 'Product_Guide__c',
    fields: {
      Name: 'Rocco Walky Kitchen Island guide',
      Brand__c: 'Rocco',
      SetContents__c: '1 kitchen island',
      TotalParts__c: 16,
      PartsHaveNumberStickers__c: true,
      Status__c: 'Draft',
      Product__c: PRODUCT.Id,
      Product_Code__c: 'TD-KIS-WALKY-L',
    },
  });
  assert.equal(note.sobject, 'Task');
  assert.equal(note.fields.WhatId, 'a0ENEW');
  assert.equal(note.fields.Subject, 'Product guide added in the service console');
  assert.match(note.fields.Description, /^staff@tiffanydesigns\.in added:\n- Brand: Rocco\n/);
  assert.equal(note.fields.ActivityDate, '2026-10-27');
});

test('an edit saves only what changed and notes it under the editor\'s name', async () => {
  const { salesforce, guides } = setup();
  const result = await guides.saveGuide(
    PRODUCT.Id,
    { brand: 'Rocco', totalParts: '16', partsHaveNumberStickers: 'false', version: '1.1', warranty: 'One year on the frame.', lastReviewedOn: '2026-10-27' },
    { editedBy: 'staff@tiffanydesigns.in' },
  );
  assert.equal(result.updated, true);
  assert.deepEqual(salesforce.calls.updates, [{
    sobject: 'Product_Guide__c',
    id: GUIDE_ROW.Id,
    fields: { PartsHaveNumberStickers__c: false, Version__c: '1.1', WarrantyInformation__c: 'One year on the frame.', LastReviewedOn__c: '2026-10-27' },
  }]);
  const note = salesforce.calls.creates.find((c) => c.sobject === 'Task');
  assert.equal(note.fields.Subject, 'Product guide edited in the service console');
  assert.match(note.fields.Description, /- Parts have number stickers: yes → no/);
  assert.match(note.fields.Description, /- Version: 1\.0 → 1\.1/);

  const again = await guides.saveGuide(PRODUCT.Id, { version: '1.1' });
  assert.equal(again.updated, false, 'nothing is sent when nothing changed');
  assert.equal(salesforce.calls.updates.length, 1);
});

test('values are checked against the org before anything is saved', async () => {
  const { salesforce, guides } = setup();
  const check = (changes) => guides.saveGuide(PRODUCT.Id, changes);
  assert.deepEqual(await check({ status: 'Live' }), { error: 'invalid', field: 'status', message: 'Status must be one of: Draft, Published, Archived.' });
  assert.equal((await check({ totalParts: 'sixteen' })).message, 'Total parts must be a number.');
  assert.equal((await check({ totalParts: '1000' })).message, 'Total parts is too large.');
  assert.equal((await check({ brand: '' })).message, 'Brand cannot be empty.');
  assert.equal((await check({ brandWebsite: 'rocco' })).message, 'Brand website must be a web address starting with https://.');
  assert.equal((await check({ brandSupportEmail: 'help@rocco' })).message, 'Brand support email must be an email address.');
  assert.equal((await check({ lastReviewedOn: '2026-02-30' })).message, 'Last reviewed on must be a date.');
  assert.equal((await check({ modelCode: 'x'.repeat(256) })).message, 'Model code can be at most 255 characters.');
  assert.deepEqual(await check({ price: '100' }), { error: 'invalid', field: 'price', message: 'These cannot be changed here: price.' });
  assert.equal((await check([])).error, 'invalid');
  assert.equal(salesforce.calls.updates.length, 0);
  assert.equal(await guides.saveGuide('01tgK00000XXXXXXXX', { version: '2' }), null);
});

test('a save Salesforce refuses comes back with its message and the field it names', async () => {
  const refusal = 'Salesforce request failed (400): [{"message":"Brand is not allowed.","errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION","fields":["Brand__c"]}]';
  const { guides } = setup({ refuse: refusal });
  assert.deepEqual(await guides.saveGuide(PRODUCT.Id, { brand: 'Other' }), { error: 'rejected', message: 'Brand is not allowed.', field: 'brand' });
});

test('the agent hears a published guide: the set, numbered parts with quantities, the hardware, the delivery check and the rules', async () => {
  const { guides } = setup({ guides: [GUIDE_ROW, { ...GUIDE_ROW, Id: 'a0EDRAFT', Product__c: '01tOTHERPRODUCT000', Status__c: 'Draft' }] });
  const found = await guides.publishedFor([PRODUCT.Id, '01tOTHERPRODUCT000', 'bad id']);
  assert.equal(found.length, 1, 'a draft guide is not used');
  assert.equal(
    guideMessage(found[0]),
    'Product guide for the Rocco Walky Kitchen Island by Rocco. In the set: 1 kitchen island: 16 numbered parts and a hardware pack. '
      + 'Every part carries a number sticker. '
      + 'Parts: 1. Worktop x 1, part number KIS-WALKY-01; 10. Fluted acrylic doors x 2, part number KIS-WALKY-10. '
      + 'Part numbers on record: LED light strip, KIS-WALKY-14. '
      + 'Hardware: A. Cam bolts, for joining panels; All hardware comes in one pack, part number KIS-WALKY-HW. '
      + 'Delivery check: Check one at a time: the worktop and the foldable extension leaf; both side panels. '
      + 'Rules for this product: The parts carry number stickers 1 to 16; A burning smell is a safety risk.',
  );
  assert.deepEqual(await guides.publishedFor([]), []);
});

test('for assembly the agent hears the complete guide, each step with its hardware named in it', async () => {
  const { guides } = setup({
    guides: [{
      ...GUIDE_ROW,
      Overview__c: 'A grey mobile kitchen island with a foldable top.\n\nStorage: 2 door cabinets.',
      Dimensions__c: '120 x 70 x 84 cm',
      HardwareList__c: 'A. Cam bolts, for joining panels\nE. Castor mounting screws, for the wheels\nJ. Allen key, for tightening',
      HardwarePerStep__c: '1. Fit the wheels: E\n2. Attach the side panels: A, J\n3. Fix the worktop: A and B, or D\n4. Fit the electrical parts: no hardware',
      AssemblySteps__c: '1. Fit the wheels. Turn the base panel (5) upside down.\n2. Attach the side panels with the cam bolts (A).\n'
        + '3. Fix the worktop.\n4. Fit the electrical parts.',
      WarrantyInformation__c: '1 year on manufacturing defects.',
    }],
  });
  const [guide] = await guides.publishedFor([PRODUCT.Id]);
  assert.equal(
    guideMessage(guide, 'assembly'),
    'Product guide for the Rocco Walky Kitchen Island by Rocco. '
      + 'About it: A grey mobile kitchen island with a foldable top. Size: 120 x 70 x 84 cm. '
      + 'In the set: 1 kitchen island: 16 numbered parts and a hardware pack. Every part carries a number sticker. '
      + 'Tools needed: Phillips screwdriver (not included); Allen key (J, included). '
      + 'Parts by sticker number: 1. Worktop x 1, part number KIS-WALKY-01; 10. Fluted acrylic doors x 2, part number KIS-WALKY-10. '
      + 'Hardware by letter: A. Cam bolts, for joining panels; E. Castor mounting screws, for the wheels; J. Allen key, for tightening. '
      + 'Parts check before starting: Check one at a time: the worktop and the foldable extension leaf; both side panels. '
      + 'Assembly steps, 4 in all, to give one at a time in this order: '
      + 'Step 1 of 4: Fit the wheels. Turn the base panel (5) upside down. Hardware: E, Castor mounting screws. '
      + 'Step 2 of 4: Attach the side panels with the cam bolts (A). Hardware: A, Cam bolts; J, Allen key. '
      + 'Step 3 of 4: Fix the worktop. Hardware: A and B, or D (A, Cam bolts). '
      + 'Step 4 of 4: Fit the electrical parts. No hardware. '
      + 'Tips, safety and care: Before you start: unpack everything onto a soft surface; Safety and care; Do not plug in until assembly is complete. '
      + 'Rules for this product: The parts carry number stickers 1 to 16; A burning smell is a safety risk. '
      + 'Warranty: 1 year on manufacturing defects.',
  );
  assert.equal(
    guideMessage({ ...guide, assemblySteps: null }, 'assembly'),
    'Product guide for the Rocco Walky Kitchen Island by Rocco. No assembly steps are on record for it. Offer an installation visit by the service team instead.',
  );
});

async function serve(t, router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (method, path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('the console reads and saves a guide through /api/admin, naming the signed-in person', async (t) => {
  const { salesforce, guides } = setup();
  const call = await serve(t, adminRouter({ consoleData: {}, productGuides: guides }));

  const read = await call('GET', `/products/${PRODUCT.Id}/guide`);
  assert.equal(read.status, 200);
  assert.equal(read.body.guide.values.brand, 'Rocco');
  assert.equal((await call('GET', '/products/01tgK00000XXXXXXXX/guide')).status, 404);

  const refused = await call('PUT', `/products/${PRODUCT.Id}/guide`, { status: 'Live' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.field, 'status');

  const saved = await call('PUT', `/products/${PRODUCT.Id}/guide`, { version: '2.0' }, { 'x-console-user': 'staff@tiffanydesigns.in' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.changes.length, 1);
  assert.match(salesforce.calls.creates.find((c) => c.sobject === 'Task').fields.Description, /^staff@tiffanydesigns\.in changed:/);
});

test('the agent tool finds the guide from the order, or from the product the customer names', async (t) => {
  const { guides } = setup();
  const crm = {
    findOrdersByReference: async (ref) => (ref === 'TD-ORD-1020' ? [{ id: '801X' }] : []),
    findOrdersByInvoice: async () => [],
    getOrderById: async () => ({ id: '801X', items: [{ productId: PRODUCT.Id }] }),
  };
  const call = await serve(t, agentToolsRouter({ crm, productGuides: guides }));

  const byOrder = await call('POST', '/product-guide', { order_id: 'TD-ORD-1020' });
  assert.equal(byOrder.body.found, true);
  assert.equal(byOrder.body.products[0].parts_have_number_stickers, true);
  assert.deepEqual(byOrder.body.products[0].parts[0], { name: 'Worktop', part_number: 'KIS-WALKY-01' });
  assert.match(byOrder.body.message, /^Product guide for the Rocco Walky Kitchen Island by Rocco\./);

  const byName = await call('POST', '/product-guide', { product_name: 'kitchen island' });
  assert.equal(byName.body.found, true);
  assert.equal(byName.body.purpose, 'parts');
  assert.match(byName.body.message, /Delivery check: /);
  assert.doesNotMatch(byName.body.message, /Assembly steps/, 'the steps come only when asked for assembly');

  const assembly = await call('POST', '/product-guide', { order_id: 'TD-ORD-1020', purpose: 'assembly' });
  assert.equal(assembly.body.purpose, 'assembly');
  assert.equal(assembly.body.has_assembly_steps, true);
  assert.equal(assembly.body.step_count, 2);
  assert.match(assembly.body.message, /Step 1 of 2: Fit the wheels\./);
  assert.match(assembly.body.message, /Assembly steps, 2 in all, to give one at a time in this order: Step 1 of 2/);
  assert.match(assembly.body.message, /Parts by sticker number: 1\. Worktop/, 'the parts list comes with the steps');
  assert.doesNotMatch(assembly.body.message, /Delivery check/);

  const none = await call('POST', '/product-guide', { product_name: 'kids bed' });
  assert.deepEqual(none.body, { found: false, message: 'No product guide is on record for this product. Match the part with tool:find_parts instead.' });
  const noAssembly = await call('POST', '/product-guide', { product_name: 'kids bed', purpose: 'assembly' });
  assert.equal(noAssembly.body.message, 'No assembly guide is on record for this product. Offer an installation visit by the service team instead.');
  assert.equal((await call('POST', '/product-guide', {})).body.message, 'An order id, order number or invoice number, or the product name, is needed.');
  assert.match((await call('POST', '/product-guide', { order_id: 'TD-ORD-9999' })).body.message, /^No order matches/);
});
