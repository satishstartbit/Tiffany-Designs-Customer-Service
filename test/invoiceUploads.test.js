// When the agent cannot find a caller's order it sends, on WhatsApp, the one public page where invoices are uploaded.
// The page takes only the file: the invoice is read by a Groq vision model, matched to an order by invoice number, order
// id or the phone on it, tied to the caller's request through the link sent to that phone or the order's customer,
// and the order gets the missing details.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvoiceLinkSender } = require('../src/invoiceLinks');
const { createWhatsApp } = require('../src/whatsapp');
const { createInvoiceReader, normalizeInvoice, INVOICE_SCHEMA } = require('../src/invoiceReader');
const { pdfPages } = require('../src/pdfPages');
const { createInvoiceUploads, productFor, LINK_SUBJECT } = require('../src/crm/invoiceUploads');
const { createInvoiceLinkLimiter, createInvoiceUploadLimiter } = require('../src/rateLimit');
const { createCrm } = require('../src/crm/crm');
const { lastTenDigits, fullName } = require('../src/rules');
const { startTestServer } = require('./helpers');

const NOW = Date.parse('2026-10-14T06:30:00Z');
const quiet = { error() {}, warn() {}, log() {} };

const INVOICE = {
  isInvoice: true,
  invoiceNumber: 'INV-2010',
  orderId: 'TD-ORD-2010',
  orderNumber: null,
  invoiceDate: '2026-10-10',
  orderDate: '2026-10-08',
  soldBy: 'Tiffany Designs Private Limited',
  seller: 'Tiffany Designs',
  platform: 'Website',
  customerName: 'Asha Sharma',
  phone: '+919876500000',
  email: 'asha@example.com',
  address: { street: '12 Civil Lines', city: 'Jaipur', state: 'Rajasthan', postalCode: '302006' },
  billingAddress: { street: '12 Civil Lines', city: 'Jaipur', state: 'Rajasthan', postalCode: '302006' },
  items: [{ name: 'Study Table', quantity: 1, sku: 'TD-STD-01', amount: 8999 }],
  total: 8999,
};

// ---------- The agent tool ----------

function fakeWhatsAppApi(status = 200) {
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
    return { ok: status < 400, status, text: async () => 'down', json: async () => ({ ok: true }) };
  };
  return { sent, fetchImpl };
}

// Links noted in Salesforce, as records.linkSent and records.linkFailed keep them.
function fakeLinkNotes() {
  return {
    notes: [],
    removed: [],
    async linkSent(link) {
      this.notes.push(link);
      return `00T${this.notes.length}`;
    },
    async linkFailed(id) {
      this.removed.push(id);
    },
  };
}

function linkServices({ status = 200, apiKey = 'wa-key', canRead = true } = {}) {
  const api = fakeWhatsAppApi(status);
  const records = fakeLinkNotes();
  const factory = ({ now }) => {
    const whatsapp = createWhatsApp({ eventsUrl: 'https://wa.example.test/events', apiKey, fetchImpl: api.fetchImpl });
    const reader = { configured: canRead, read: async () => INVOICE };
    return {
      sender: createInvoiceLinkSender({ whatsapp, reader, records, limiter: createInvoiceLinkLimiter({ now }), logger: quiet }),
      reader,
      records,
      uploadLimiter: createInvoiceUploadLimiter({ perHour: 30, perDay: 150, now }),
    };
  };
  return { api, records, factory };
}

test('send_invoice_upload_link notes the number and sends the WhatsApp event with only the fields the integration accepts', async (t) => {
  const { api, records, factory } = linkServices();
  const srv = await startTestServer({ invoices: factory });
  t.after(srv.close);

  const res = await srv.call('POST', '/api/agent/invoice-upload-link', {
    headers: srv.agent,
    body: { phone: '98765 43210', customer_name: 'Asha Sharma', order_reference: 'INV 2010' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.match(res.body.message, /^The upload link is sent on WhatsApp to the number ending 3 2 1 0\. Tell the customer to open it and upload/);

  assert.deepEqual(records.notes, [{ phone: '+919876543210', customerName: 'Asha Sharma', reference: 'INV 2010' }]);
  assert.deepEqual(api.sent, [{
    url: 'https://wa.example.test/events',
    auth: 'Bearer wa-key',
    body: { event: 'invoice_upload_requested', phone_number: '+919876543210', customer_name: 'Asha Sharma' },
  }], 'the integration refuses any other field; the page address is in its message template');
});

test('an event without an enabled WhatsApp template is reported as that, not as a generic refusal', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ error: 'Configure and enable an approved template for this event in Management → Voice agent API.', code: 'VOICE_EVENT_NOT_CONFIGURED' }),
  });
  const whatsapp = createWhatsApp({ eventsUrl: 'https://wa.example.test/events', apiKey: 'k', fetchImpl });
  await assert.rejects(whatsapp.sendInvoiceUploadLink({ phone: '+919876543210', customerName: 'Asha' }), (err) => {
    assert.equal(err.code, 'VOICE_EVENT_NOT_CONFIGURED');
    assert.match(err.message, /no approved template enabled for the event invoice_upload_requested: enable one in the WhatsApp integration \(Management → Voice agent API\)/);
    return true;
  });
});

test('the link needs a valid Indian mobile, goes to one number at most 3 times a day, and fails softly', async (t) => {
  const { api, factory } = linkServices();
  const srv = await startTestServer({ invoices: factory });
  t.after(srv.close);
  const send = (body) => srv.call('POST', '/api/agent/invoice-upload-link', { headers: srv.agent, body });

  const bad = await send({ phone: '12345' });
  assert.equal(bad.body.sent, false);
  assert.match(bad.body.message, /10 digit Indian mobile number that is on WhatsApp/);
  assert.equal(api.sent.length, 0);

  for (let i = 0; i < 3; i += 1) assert.equal((await send({ phone: '9876543210' })).body.sent, true);
  const fourth = await send({ phone: '9876543210' });
  assert.equal(fourth.body.sent, false);
  assert.match(fourth.body.message, /already sent to this number today/);
  assert.equal(api.sent.at(-1).body.customer_name, 'Customer', 'a caller who gave no name is greeted as Customer');
  assert.equal((await send({ phone: '9123456780' })).body.sent, true, 'another number is not affected');

  // The number of this call, when the customer asks for it, is the one the call came from, whatever digits the agent sent.
  const own = await send({ use_calling_number: true, phone: '9123456780', caller_phone: '+919000000555' });
  assert.match(own.body.message, /^The upload link is sent on WhatsApp to the number ending 0 5 5 5\./);
  assert.equal(api.sent.at(-1).body.phone_number, '+919000000555');
  const unknown = await send({ use_calling_number: true, phone: '9123456780' });
  assert.equal(unknown.body.sent, false);
  assert.match(unknown.body.message, /^The number of this call is not known\. Ask for the 10 digit WhatsApp number/);

  assert.equal((await srv.call('POST', '/api/agent/invoice-upload-link', { body: { phone: '9876543210' } })).status, 401, 'the agent secret is needed');
});

test('when WhatsApp refuses, the note is removed; when nothing is set up, nothing is sent', async (t) => {
  const refused = linkServices({ status: 500 });
  const srv = await startTestServer({ invoices: refused.factory });
  t.after(srv.close);
  const res = await srv.call('POST', '/api/agent/invoice-upload-link', { headers: srv.agent, body: { phone: '9876543210' } });
  assert.equal(res.body.sent, false);
  assert.match(res.body.message, /cannot be sent right now\. Register no installation, damage or replacement request without the order: offer a call back/);
  assert.deepEqual(refused.records.removed, ['00T1'], 'a number that got no message has no link on record');

  for (const options of [{ apiKey: '' }, { canRead: false }]) {
    const { api, records, factory } = linkServices(options);
    const off = await startTestServer({ invoices: factory });
    const answer = await off.call('POST', '/api/agent/invoice-upload-link', { headers: off.agent, body: { phone: '9876543210' } });
    assert.equal(answer.body.sent, false);
    assert.equal(api.sent.length + records.notes.length, 0);
    await off.close();
  }

  const none = await startTestServer();
  t.after(none.close);
  const answer = await none.call('POST', '/api/agent/invoice-upload-link', { headers: none.agent, body: { phone: '9876543210' } });
  assert.equal(answer.body.sent, false);
  assert.equal((await none.call('GET', '/api/invoice-uploads')).status, 404, 'no upload routes without the invoice services');
});

test('check_invoice_upload tells the agent, once the caller says the invoice is uploaded, which order to look up or what to say', async (t) => {
  let status = { sent: false };
  const asked = [];
  const srv = await startTestServer({
    invoices: ({ now }) => ({
      sender: null,
      reader: { configured: true, read: async () => INVOICE },
      records: { async uploadStatus(phones) { asked.push(phones); return typeof status === 'function' ? status() : status; } },
      uploadLimiter: createInvoiceUploadLimiter({ perHour: 30, perDay: 150, now }),
    }),
  });
  t.after(srv.close);
  const check = (body = { phone: '98765 00000', caller_phone: '+919000000001' }) => srv.call('POST', '/api/agent/invoice-upload-status', { headers: srv.agent, body }).then((r) => r.body);

  const none = await check();
  assert.deepEqual(asked[0], ['+919876500000', '+919000000001'], 'the WhatsApp number and the number of the call');
  assert.equal(none.link_sent, false);
  assert.match(none.message, /^No upload link was sent to this number recently\. Ask which WhatsApp number the link came on/);

  status = { sent: true, uploaded: false };
  assert.match((await check()).message, /^No invoice has been received on the link yet\. .*call this tool again\. When it is still not received after that, ask for the invoice number printed on the invoice and call tool:find_order with it\.$/);

  status = { sent: true, uploaded: true, refused: '"Mystery Lamp" is not in the product catalog' };
  const refused = await check();
  assert.equal(refused.accepted, false);
  assert.match(refused.message, /^The invoice the customer uploaded was not accepted, because "Mystery Lamp" is not in the product catalog, and nothing was saved/);

  status = { sent: true, uploaded: true, order: { id: '801Z', orderNumber: '00000130', erpOrderId: null, invoiceNumber: 'INV-2010', added: true } };
  const added = await check();
  assert.deepEqual({ ...added, message: undefined }, {
    link_sent: true, uploaded: true, accepted: true, order_found: true, order_added: true, order_id: null, order_number: '00000130', invoice_number: 'INV-2010', message: undefined,
  });
  assert.match(added.message, /^The invoice is received, and as no order matched it, an order was added from it\. Call tool:find_order now with order number 00000130 and the WhatsApp number as the mobile number/);
  assert.doesNotMatch(added.message, /801Z/, 'no record id');

  status = { sent: true, uploaded: true, order: { id: '801Z', orderNumber: '00000130', erpOrderId: 'TD-ORD-2010', invoiceNumber: 'INV-2010', added: false } };
  assert.match((await check()).message, /matched to its order, which was updated from it\. Call tool:find_order now with order id TD-ORD-2010 /);

  status = { sent: true, uploaded: true, caseNumber: '00001290' };
  const team = await check();
  assert.equal(team.spoken_case_number, '1290');
  assert.match(team.message, /with the service team on request 1290\. .*Register no installation, damage, part, replacement or return request for it on this call\.$/);

  assert.equal((await check({ phone: '12345' })).uploaded, null, 'a number is needed');
  status = () => { throw new Error('Salesforce is down'); };
  const down = await check();
  assert.equal(down.error, 'unavailable');
  assert.match(down.message, /When it fails again, ask for the invoice number printed on the invoice and call tool:find_order with it\.$/);
});

// ---------- The public upload page's API ----------

async function uploadServer({ reader, records, readerConfigured = true } = {}) {
  const calls = { read: [], record: [] };
  const srv = await startTestServer({
    invoices: ({ now }) => ({
      sender: null,
      reader: { configured: readerConfigured, read: async (file) => { calls.read.push(file); return reader ? reader(file) : INVOICE; } },
      records: {
        async record(input) {
          calls.record.push(input);
          return records ? records(input) : { matched: true, recorded: true };
        },
      },
      uploadLimiter: createInvoiceUploadLimiter({ perHour: 30, perDay: 150, now }),
    }),
  });
  const upload = (body, type = 'image/jpeg') => srv.call('POST', '/api/invoice-uploads', { body, headers: { 'Content-Type': type } });
  return { srv, calls, upload };
}

test('an uploaded invoice is read and recorded with nothing else asked, and the answer names nothing from Salesforce', async (t) => {
  const { srv, calls, upload } = await uploadServer();
  t.after(srv.close);

  const opened = await srv.call('GET', '/api/invoice-uploads');
  assert.deepEqual(opened.body, { available: true });
  assert.equal(opened.headers.get('cache-control'), 'no-store');

  const res = await upload(Buffer.from('fake jpeg bytes'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    status: 'matched',
    invoice_number: 'INV-2010',
    order_id: 'TD-ORD-2010',
    message: 'Thank you. We found your order and added your invoice to it. If you are still on the call with our assistant, tell it that the '
      + 'invoice is uploaded; otherwise our service team will take it from here.',
  });
  assert.equal(calls.read[0].contentType, 'image/jpeg');
  assert.equal(calls.read[0].data.toString(), 'fake jpeg bytes');
  assert.deepEqual(Object.keys(calls.record[0]), ['invoice', 'file']);
  assert.equal(calls.record[0].invoice, INVOICE);
});

test('an unmatched invoice is received for the service team, unless nobody can be reached about it', async (t) => {
  let result = { matched: false, recorded: true, caseNumber: '00001300' };
  const { srv, upload } = await uploadServer({ records: () => result });
  t.after(srv.close);
  const received = await upload(Buffer.from('%PDF-1.7'), 'application/pdf');
  assert.equal(received.body.status, 'received');
  assert.match(received.body.message, /could not match it to an order automatically/);
  assert.doesNotMatch(JSON.stringify(received.body), /1300/, 'the request number is not shown on the public page');

  result = { matched: false, recorded: false };
  const lost = await upload(Buffer.from('a'));
  assert.equal(lost.body.status, 'not_found');
  assert.match(lost.body.message, /Please call Tiffany Designs customer care/);
});

test('other files, oversized files and pictures that are not invoices are refused', async (t) => {
  const { srv, calls, upload } = await uploadServer({ reader: (file) => (file.data.toString() === 'cat' ? { ...INVOICE, isInvoice: false } : INVOICE) });
  t.after(srv.close);

  assert.equal((await upload('just text', 'text/plain')).status, 415);
  assert.equal((await upload(Buffer.alloc(9 * 1024 * 1024), 'image/png')).status, 413);
  const cat = await upload(Buffer.from('cat'));
  assert.equal(cat.status, 422);
  assert.equal(cat.body.error, 'not_an_invoice');
  assert.equal(calls.record.length, 0, 'nothing reaches Salesforce');
});

test('only an invoice sold by Tiffany Designs Private Limited is taken', async (t) => {
  const sellers = { other: { soldBy: 'Comfort Furniture Traders' }, none: { soldBy: null, seller: null }, short: { soldBy: 'TIFFANY DESIGNS PVT. LTD.' }, header: { soldBy: null, seller: 'Tiffany Designs Private Limited' } };
  const { srv, calls, upload } = await uploadServer({ reader: (file) => ({ ...INVOICE, ...sellers[file.data.toString()] }) });
  t.after(srv.close);

  for (const name of ['other', 'none']) {
    const refused = await upload(Buffer.from(name));
    assert.equal(refused.status, 422, name);
    assert.deepEqual(refused.body, {
      error: 'not_tiffany_invoice',
      message: 'This invoice does not show Tiffany Designs Private Limited as the seller. Please upload the Tiffany Designs invoice for your order, where Sold By shows Tiffany Designs Private Limited.',
    });
  }
  assert.equal(calls.record.length, 0, 'nothing reaches Salesforce');
  assert.equal((await upload(Buffer.from('short'))).status, 200, 'Pvt. Ltd. is the same company');
  assert.equal((await upload(Buffer.from('header'))).status, 200, 'an invoice without Sold By counts its seller');
  assert.equal(calls.record.length, 2);
});

test('an invoice that matches no order is answered as added', async (t) => {
  const { srv, upload } = await uploadServer({ records: () => ({ matched: false, created: true, recorded: true, orderId: '801N', orderName: 'TD-ORD-2010' }) });
  t.after(srv.close);
  const res = await upload(Buffer.from('a'));
  assert.deepEqual(res.body, {
    status: 'created',
    invoice_number: 'INV-2010',
    order_id: 'TD-ORD-2010',
    message: 'Thank you. Your order was not in our records, so we have added it from your invoice. Our service team will check it. '
      + 'If you are still on the call with our assistant, tell it that the invoice is uploaded; otherwise please call us again to continue with your request.',
  });
});

test('an invoice no order may be added from is refused with what to fix, naming only the invoice\'s own products', async (t) => {
  const refusals = {
    lamp: { reason: 'product_not_available', products: ['Mystery Lamp'] },
    many: { reason: 'product_not_available', products: ['Lamp', 'Swing', 'Rug', `Very Long ${'Name '.repeat(20)}`] },
    number: { reason: 'invoice_number_missing' },
    empty: { reason: 'no_products' },
    seller: { reason: 'not_tiffany_invoice' },
  };
  const { srv, upload } = await uploadServer({ records: ({ file }) => ({ matched: false, created: false, recorded: false, refused: refusals[file.data.toString()] }) });
  t.after(srv.close);
  const answer = async (name) => {
    const res = await upload(Buffer.from(name));
    assert.equal(res.status, 422, name);
    assert.equal(res.body.error, refusals[name].reason);
    return res.body.message;
  };
  assert.equal(await answer('lamp'), 'This product on your invoice is not available in our product list: "Mystery Lamp". We could not add your order from this invoice. '
    + 'Please check that you uploaded your Tiffany Designs invoice, or call Tiffany Designs customer care.');
  assert.match(await answer('many'), /^These products on your invoice are not available in our product list: "Lamp", "Swing", "Rug" and 1 more\./);
  assert.match(await answer('number'), /could not read the invoice number on this invoice.*with the invoice number showing\.$/);
  assert.match(await answer('empty'), /could not read the products on this invoice.*with the product list showing\.$/);
  assert.match(await answer('seller'), /^This invoice does not show Tiffany Designs Private Limited as the seller\./);
});

test('each visitor gets 10 uploads an hour, and a failed reading says to try again', async (t) => {
  let fail = false;
  const { srv, calls, upload } = await uploadServer({ reader: () => { if (fail) throw new Error('Groq request failed (500): boom'); return INVOICE; } });
  t.after(srv.close);
  fail = true;
  const failed = await upload(Buffer.from('a'));
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.body.message, /Groq|boom/, 'the visitor never sees the technical reason');
  fail = false;
  for (let i = 0; i < 9; i += 1) assert.equal((await upload(Buffer.from('a'))).status, 200);
  const limited = await upload(Buffer.from('a'));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(calls.read.length, 10, 'the 11th upload is not read');
});

test('a Groq account that cannot be used says uploads are not available, not "try again in a minute"', async (t) => {
  const blocked = Object.assign(new Error('Groq request failed (403): Organization has been restricted.'), { setup: true });
  const { srv, upload } = await uploadServer({ reader: () => { throw blocked; } });
  t.after(srv.close);
  const res = await upload(Buffer.from('a'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.doesNotMatch(res.body.message, /restricted|Groq|try again in a minute/);
});

test('a PDF that cannot be opened asks for a photo instead, and reaches nothing else', async (t) => {
  const locked = Object.assign(new Error('The PDF cannot be opened: No password given'), { unreadable: true });
  const { srv, calls, upload } = await uploadServer({ reader: () => { throw locked; } });
  t.after(srv.close);
  const res = await upload(Buffer.from('%PDF-1.7'), 'application/pdf');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, {
    error: 'unreadable_pdf',
    message: 'We could not open this PDF. It may be locked with a password or damaged. Please upload a photo or screenshot of the invoice instead.',
  });
  assert.equal(calls.record.length, 0);
});

test('without a Groq key the page says uploads are not available', async (t) => {
  const { srv, calls, upload } = await uploadServer({ readerConfigured: false });
  t.after(srv.close);
  assert.deepEqual((await srv.call('GET', '/api/invoice-uploads')).body, { available: false });
  const res = await upload(Buffer.from('a'));
  assert.equal(res.status, 503);
  assert.equal(calls.read.length, 0);
});

// ---------- Reading the invoice ----------

function fakeGroq(content, status = 200, error = { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' }) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
    const answer = status < 400 ? { choices: [{ message: { content: JSON.stringify(content) } }] } : { error };
    return { ok: status < 400, status, json: async () => answer };
  };
  return { requests, fetchImpl };
}

const READ = {
  is_invoice: true,
  invoice_number: ' INV-2010 ',
  order_id: 'TD-ORD-2010',
  order_number: null,
  invoice_date: '2026-10-10',
  order_date: '2026-02-30',
  sold_by: ' Tiffany Designs Private Limited ',
  seller: 'Tiffany Designs',
  platform: 'Myntra',
  customer_name: 'Asha  Sharma',
  phone: '098765 00000',
  email: 'not an email',
  shipping_address: { street: '12 Civil Lines', city: 'Jaipur', state: 'Rajasthan', postal_code: '302 006' },
  items: [{ name: 'Study Table', quantity: 1, sku: null, amount: 8999 }, { name: '', quantity: 1, sku: null, amount: null }],
  total_amount: 8999,
};

test('an image goes to the Groq vision model with a strict schema, and the answer is checked', async () => {
  const api = fakeGroq(READ);
  const reader = createInvoiceReader({ apiKey: 'gsk_test', model: 'qwen/qwen3.8-27b', fetchImpl: api.fetchImpl });
  const invoice = await reader.read({ data: Buffer.from('jpeg'), contentType: 'image/jpeg' });

  const [request] = api.requests;
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.auth, 'Bearer gsk_test');
  assert.equal(request.body.model, 'qwen/qwen3.8-27b');
  assert.deepEqual(request.body.messages[1].content[1], { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}` } });
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.reasoning_effort, 'none');

  assert.equal(invoice.invoiceNumber, 'INV-2010');
  assert.equal(invoice.soldBy, 'Tiffany Designs Private Limited');
  assert.equal(invoice.orderNumber, null);
  assert.equal(invoice.orderDate, null, '30 February is no date');
  assert.equal(invoice.platform, null, 'only the org\'s channels');
  assert.equal(invoice.customerName, 'Asha Sharma');
  assert.equal(invoice.phone, '+919876500000');
  assert.equal(invoice.email, null);
  assert.equal(invoice.address.postalCode, '302006');
  assert.deepEqual(invoice.items, [{ name: 'Study Table', quantity: 1, sku: null, amount: 8999 }]);
});

// A text-only PDF with one page per list of lines, written by hand so the test needs no file.
function textPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = pages.map((lines) => {
    const stream = lines.map((line, i) => `BT /F1 12 Tf 50 ${780 - i * 20} Td (${line}) Tj ET`).join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    return `${objects.length} 0 R`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('a PDF goes as an image of page one with the text printed on every page', async () => {
  const api = fakeGroq(READ);
  const pdf = textPdf([['Sold By : Tiffany Designs Private Limited', 'Invoice Number : INV-2010'], ['Page two'], ['Terms']]);
  await createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl }).read({ data: pdf, contentType: 'application/pdf' });

  const [text, ...images] = api.requests[0].body.messages[1].content;
  assert.equal(images.length, 1, 'each image costs a share of the per-minute allowance');
  assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,\/9j\//, 'the page is a JPEG');
  assert.match(text.text, /the image is page 1 of its 3 pages/);
  assert.match(text.text, /Sold By : Tiffany Designs Private Limited\s+Invoice Number : INV-2010/);
  assert.match(text.text, /Terms/, 'the text of every page goes along');

  const pages = await pdfPages(pdf, { maxPages: 3 });
  assert.equal(pages.images.length, 3);
});

test('a scanned PDF goes without text; a broken PDF is unreadable, not a failure to retry', async () => {
  const api = fakeGroq(READ);
  const scanned = async () => ({ pageCount: 1, images: [Buffer.from('page')], text: '' });
  await createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl, readPdf: scanned }).read({ data: Buffer.from('%PDF'), contentType: 'application/pdf' });
  const [text, image] = api.requests[0].body.messages[1].content;
  assert.equal(text.text, 'Read this invoice. It is a PDF: the image is its page. It has no printed text, so read the image.');
  assert.equal(image.image_url.url, `data:image/jpeg;base64,${Buffer.from('page').toString('base64')}`);

  const broken = await pdfPages(Buffer.from('%PDF-1.7 not really')).then(() => null, (err) => err);
  assert.equal(broken.unreadable, true);
  const reader = createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: fakeGroq(READ).fetchImpl });
  await assert.rejects(reader.read({ data: Buffer.from('%PDF-1.7 not really'), contentType: 'application/pdf' }), (err) => err.unreadable === true);
});

test('a used-up minute allowance is waited out once when Groq names a short wait', async () => {
  const limited = (retryAfter) => {
    const answers = [
      { ok: false, status: 429, headers: new Headers({ 'retry-after': retryAfter }), json: async () => ({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }) },
      { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify(READ) } }] }) },
    ];
    const calls = [];
    return { calls, fetchImpl: async (url) => { calls.push(url); return answers[calls.length - 1]; } };
  };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };

  const short = limited('4');
  const invoice = await createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: short.fetchImpl, sleep }).read({ data: Buffer.from('a'), contentType: 'image/png' });
  assert.equal(invoice.invoiceNumber, 'INV-2010');
  assert.deepEqual(waits, [4000]);
  assert.equal(short.calls.length, 2);

  const long = limited('45');
  const err = await createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: long.fetchImpl, sleep }).read({ data: Buffer.from('a'), contentType: 'image/png' }).then(() => null, (e) => e);
  assert.match(err.message, /Groq request failed \(429\)/);
  assert.equal(err.setup, false);
  assert.equal(long.calls.length, 1, 'a long wait is left to the customer');
});

test('a refused key or another file type is an error', async () => {
  const refused = createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: fakeGroq(READ, 401).fetchImpl });
  await assert.rejects(refused.read({ data: Buffer.from('a'), contentType: 'image/png' }), /Groq request failed \(401\): Invalid API Key/);
  await assert.rejects(refused.read({ data: Buffer.from('a'), contentType: 'image/gif' }), /Unsupported invoice file type/);
  assert.equal(createInvoiceReader({ apiKey: '', model: 'm' }).configured, false);
});

test('a refused key, a blocked account or an unknown model is a setup problem; a rate limit or an outage is not', async () => {
  const failure = async (status, error) => {
    const reader = createInvoiceReader({ apiKey: 'k', model: 'm', fetchImpl: fakeGroq(READ, status, error).fetchImpl });
    return reader.read({ data: Buffer.from('a'), contentType: 'image/png' }).then(() => null, (err) => err);
  };
  const blocked = await failure(403, { message: 'Organization has been restricted.', type: 'invalid_request_error', code: 'organization_restricted' });
  assert.match(blocked.message, /Groq request failed \(403\): Organization has been restricted\./);
  assert.equal(blocked.setup, true);
  assert.equal((await failure(401, { message: 'Invalid API Key', code: 'invalid_api_key' })).setup, true);
  assert.equal((await failure(404, { message: 'The model does not exist or you do not have access to it.', code: 'model_not_found' })).setup, true);
  assert.equal((await failure(400, { message: 'The model has been decommissioned.', code: 'model_decommissioned' })).setup, true);
  assert.equal((await failure(429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' })).setup, false);
  assert.equal((await failure(500, { message: 'The server had an error' })).setup, false);
});

test('the schema meets strict structured output: every property required, nothing extra', () => {
  const check = (schema, where) => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.equal(schema.additionalProperties, false, where);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), where);
      for (const [name, child] of Object.entries(schema.properties)) check(child, `${where}.${name}`);
    }
    if (schema.items) check(schema.items, `${where}[]`);
  };
  check(INVOICE_SCHEMA, 'invoice');
  assert.equal(normalizeInvoice(null).isInvoice, false);
});

// ---------- Matching the order in Salesforce and updating it ----------

const FILE = { data: Buffer.from('jpeg'), contentType: 'image/jpeg' };
// A link the voice agent sent to the phone printed on INVOICE.
const LINK_TO_INVOICE_PHONE = { Id: 'lnk1', phone: '+919876500000', Description: 'Link sent.\nCustomer name: Asha Sharma\nOrder reference given on the call: INV 2010' };

const ORDER_ROW = {
  Id: '801Z', OrderNumber: '00000130', Status: 'Draft', Pricebook2Id: '01sSTD', EffectiveDate: '2026-10-15', ERP_Order_Id__c: 'TD-ORD-2010',
  Invoice_Number__c: null, Order_Source__c: null, Description: 'Imported from the ERP.', AccountId: '001Z', Account: { Name: 'Asha Sharma' },
  CustomerAuthorizedById: null, ShippingStreet: null, ShippingCity: null, ShippingPostalCode: null, ShippingStateCode: null, ShippingCountryCode: null,
  BillingStreet: null, BillingCity: null, BillingPostalCode: null, BillingStateCode: null, BillingCountryCode: null,
};
const ENTRIES = [
  { Id: '01uTBL', UnitPrice: 8999, Product2Id: '01tTBL', Product2: { Name: 'Demo Study Table', ProductCode: 'TD-STD-01' } },
  { Id: '01uPRM', UnitPrice: 15999, Product2Id: '01tPRM', Product2: { Name: 'Demo Premium Study Table', ProductCode: 'TD-STD-PR' } },
  { Id: '01uCHR', UnitPrice: 4999, Product2Id: '01tCHR', Product2: { Name: 'Demo Study Chair', ProductCode: 'TD-CHR-01' } },
  { Id: '01uSHC', UnitPrice: 6999, Product2Id: '01tSHC', Product2: { Name: 'Demo Shoe Cabinet', ProductCode: 'TD-SHC-01' } },
];
const contactRow = (fields) => ({
  AccountId: '001Z', FirstName: 'Asha', LastName: 'Sharma', MobilePhone: null, Email: null,
  MailingStreet: null, MailingCity: null, MailingPostalCode: null, MailingStateCode: null, MailingCountryCode: null, ...fields,
});

// `refuse(sobject, fields)` returns the reason Salesforce gives for refusing an update, or nothing.
function fakeOrg({ order = {}, contact = null, items = [], waiting = [], links = [], refuse = () => null } = {}) {
  const log = { queries: [], creates: [], updates: [], many: [] };
  const row = { ...ORDER_ROW, ...order };
  const salesforce = {
    log,
    async query(soql) {
      log.queries.push(soql);
      if (soql.includes('FROM Order WHERE Id')) return [row];
      if (soql.includes('FROM Pricebook2 WHERE IsStandard = true')) return [{ Id: '01sSTD' }];
      if (soql.includes('FROM Contact WHERE Id')) return contact && soql.includes(`'${contact.Id}'`) ? [contact] : [];
      if (soql.includes('FROM PricebookEntry')) return ENTRIES;
      if (soql.includes('FROM OrderItem')) return items;
      if (soql.includes('FROM Case WHERE IsClosed = false')) return waiting;
      if (soql.includes('FROM Task WHERE Subject IN')) {
        const sent = [
          ...links.map((l) => ({ Id: l.Id, Subject: `${LINK_SUBJECT} ${l.phone}`, Description: l.Description, CreatedDate: '2026-10-14T06:00:00.000+0000' })),
          ...log.creates.filter((c) => c.sobject === 'Task' && c.fields.Subject.startsWith(LINK_SUBJECT))
            .map((c) => ({ Id: c.id, Subject: c.fields.Subject, Description: c.fields.Description, CreatedDate: '2026-10-14T06:30:00.000+0000' })),
        ];
        return sent.filter((r) => soql.includes(`'${r.Subject}'`)).slice(-1);
      }
      return [];
    },
    async create(sobject, fields) {
      const id = `${sobject}-${log.creates.length + 1}`;
      log.creates.push({ sobject, fields, id });
      return { id };
    },
    async createMany(sobject, records) {
      log.many.push({ sobject, records });
      return records.map((r, i) => `${sobject}-new-${i + 1}`);
    },
    async update(sobject, id, fields) {
      const reason = refuse(sobject, fields);
      if (reason) throw new Error(`Salesforce request failed (400): ${JSON.stringify([{ message: reason, errorCode: 'FIELD_INTEGRITY_EXCEPTION' }])}`);
      log.updates.push({ sobject, id, fields });
      if (sobject === 'Order') Object.assign(row, fields);
    },
  };
  return { salesforce, row, log };
}

const ORDER = { id: '801Z', accountId: '001Z', invoiceNumber: null, erpOrderId: 'TD-ORD-2010' };

function fakeCrm({ byInvoice = [], byReference = [], contacts = [], accountOrders = {}, orderCustomer = null } = {}) {
  const cases = [];
  const customers = [];
  const references = [];
  return {
    cases,
    customers,
    references,
    // Like the real one: the named record for the number, else a new customer under a full name, else nothing.
    async resolveOrCreateContact(phone, name, accountFields, contactFields) {
      const known = contacts.find((c) => lastTenDigits(c.mobile) === lastTenDigits(phone));
      if (known?.name) return { ...known, created: false };
      if (!fullName(name)) return null;
      customers.push({ phone, name: fullName(name), accountFields, contactFields });
      return { id: '003N', accountId: '001N', name: fullName(name), created: true };
    },
    async findContactByPhone(phone) {
      return contacts.find((c) => lastTenDigits(c.mobile) === lastTenDigits(phone)) || null;
    },
    async findOrdersByInvoice() { return byInvoice; },
    async findOrdersByReference(reference) {
      references.push(reference);
      return typeof byReference === 'function' ? byReference(reference) : byReference;
    },
    async findRecentOrdersForAccount(accountId) { return accountOrders[accountId] || []; },
    async getOrderContact() { return orderCustomer; },
    async indianStateCode(name) { return { rajasthan: 'RJ', delhi: 'DL' }[String(name).toLowerCase()]; },
    async createServiceCase(input) {
      cases.push(input);
      return { created: true, caseId: '500N', caseNumber: '00001300' };
    },
  };
}

const uploadsWith = ({ org = fakeOrg(), crm = fakeCrm() } = {}) => ({
  org, crm, uploads: createInvoiceUploads({ salesforce: org.salesforce, crm, linkDays: 7, now: () => NOW, logger: quiet }),
});
const created = (log, sobject) => log.creates.filter((c) => c.sobject === sobject).map((c) => c.fields);
const updatesOf = (log, sobject) => log.updates.filter((u) => u.sobject === sobject);
const ADDRESS = { Street: '12 Civil Lines', City: 'Jaipur', PostalCode: '302006', StateCode: 'RJ', CountryCode: 'IN' };
const addressOf = (prefix) => Object.fromEntries(Object.entries(ADDRESS).map(([part, value]) => [`${prefix}${part}`, value]));

test('a link sent is an open task named with the number; an invoice without a phone finds it through the order\'s customer', async () => {
  const caller = { id: '003C', name: 'Asha Sharma', accountId: '001Z', mobile: '+919876543210' };
  const org = fakeOrg({ contact: contactRow({ Id: '003C', MobilePhone: '+919876543210' }) });
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ contacts: [caller], byInvoice: [ORDER], orderCustomer: caller }) });

  const id = await uploads.linkSent({ phone: '+919876543210', customerName: 'Asha Sharma', reference: 'INV 2010' });
  const [task] = created(org.log, 'Task');
  assert.equal(id, 'Task-1');
  assert.deepEqual({ ...task, Description: undefined }, {
    WhoId: '003C', Subject: `${LINK_SUBJECT} +919876543210`, Description: undefined, Status: 'Not Started', Priority: 'Normal', ActivityDate: '2026-10-14',
  });
  assert.match(task.Description, /\nCustomer name: Asha Sharma\nOrder reference given on the call: INV 2010\n/);

  const link = await uploads.findLink(['+919876543210', null]);
  assert.deepEqual({ ...link, details: undefined }, {
    id: 'Task-1', phone: '+919876543210', customerName: 'Asha Sharma', reference: 'INV 2010', issuedAt: '2026-10-14T06:30:00.000+0000', details: undefined,
    status: null, recordId: null, recordType: null,
  });
  assert.match(org.log.queries.at(-1), /Subject IN \('Invoice upload link sent on WhatsApp to \+919876543210'\) AND CreatedDate >= 2026-10-07T06:30:00Z/);
  assert.equal(await uploads.findLink(['+919123456780']), null, 'another number has no link');
  const asked = org.log.queries.length;
  assert.equal(await uploads.findLink([null]), null);
  assert.equal(org.log.queries.length, asked, 'no number, no query');

  const result = await uploads.record({ invoice: { ...INVOICE, phone: null }, file: FILE });
  assert.equal(result.matched, true);
  assert.equal(updatesOf(org.log, 'Order')[0].fields.CustomerAuthorizedById, '003C', 'the caller becomes the order\'s customer');
  const closed = updatesOf(org.log, 'Task')[0];
  assert.equal(closed.id, 'Task-1');
  assert.equal(closed.fields.Status, 'Completed');
  assert.equal(closed.fields.WhatId, '801Z', 'the link is related to the order, for the agent to find while the caller is on the call');
  assert.match(closed.fields.Description, /\nInvoice uploaded on 14 October 2026: matched to order TD-ORD-2010 by its invoice number; the order was updated from it\.$/);
});

test('the link task keeps its outcome even when Salesforce will not relate it to the order', async () => {
  const org = fakeOrg({ links: [LINK_TO_INVOICE_PHONE], refuse: (sobject, fields) => (sobject === 'Task' && fields.WhatId ? 'Related To: id value of incorrect type' : null) });
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  await uploads.record({ invoice: INVOICE, file: FILE });
  const [closed] = updatesOf(org.log, 'Task');
  assert.equal(closed.fields.Status, 'Completed');
  assert.equal(closed.fields.WhatId, undefined);
  assert.match(closed.fields.Description, /matched to order TD-ORD-2010/);
});

test('what became of the link the agent sent: not yet uploaded, refused, the order found or added, or a request for the team', async () => {
  const at = (task, records = {}) => {
    const queries = [];
    const salesforce = {
      async query(soql) {
        queries.push(soql);
        if (soql.includes('FROM Task WHERE Subject IN')) return task ? [{ Subject: `${LINK_SUBJECT} +919876500000`, CreatedDate: '2026-10-14T06:00:00.000+0000', ...task }] : [];
        if (soql.includes('FROM Order WHERE Id')) return records.order ? [records.order] : [];
        if (soql.includes('FROM Case WHERE Id')) return records.request ? [records.request] : [];
        return [];
      },
    };
    const uploads = createInvoiceUploads({ salesforce, crm: fakeCrm(), now: () => NOW, logger: quiet });
    return { queries, status: () => uploads.uploadStatus(['+919876500000', '+919000000001']) };
  };
  const sent = 'Link sent.\nCustomer name: Asha Sharma';

  const none = at(null);
  assert.deepEqual(await none.status(), { sent: false });
  assert.match(none.queries[0], /SELECT Id, Subject, Description, Status, WhatId, What\.Type, CreatedDate FROM Task WHERE Subject IN \('Invoice upload link sent on WhatsApp to \+919876500000', 'Invoice upload link sent on WhatsApp to \+919000000001'\)/);
  assert.deepEqual(await at({ Id: 'lnk1', Description: sent, Status: 'Not Started' }).status(), { sent: true, uploaded: false });

  const refused = `${sent}\nInvoice uploaded on 14 October 2026: refused and nothing was saved, because "Mystery Lamp" is not in the product catalog. `
    + 'The customer was asked to upload the right invoice or call customer care.';
  assert.deepEqual(await at({ Id: 'lnk1', Description: refused, Status: 'Not Started' }).status(),
    { sent: true, uploaded: true, refused: '"Mystery Lamp" is not in the product catalog' });

  const order = { Id: '801Z', OrderNumber: '00000130', ERP_Order_Id__c: null, Invoice_Number__c: 'INV-2010' };
  const added = await at({
    Id: 'lnk1', Status: 'Completed', WhatId: '801Z', What: { Type: 'Order' },
    Description: `${refused}\nInvoice uploaded on 14 October 2026: no order matched; order order number 00000130 was added from it.`,
  }, { order }).status();
  assert.deepEqual(added, { sent: true, uploaded: true, order: { id: '801Z', orderNumber: '00000130', erpOrderId: null, invoiceNumber: 'INV-2010', added: true } },
    'the latest upload counts, after one that was refused');
  const matched = await at({
    Id: 'lnk1', Status: 'Completed', WhatId: '801Z', What: { Type: 'Order' },
    Description: `${sent}\nInvoice uploaded on 14 October 2026: matched to order TD-ORD-2010 by its invoice number; the order was updated from it.`,
  }, { order: { ...order, ERP_Order_Id__c: 'TD-ORD-2010' } }).status();
  assert.equal(matched.order.added, false);
  assert.equal(matched.order.erpOrderId, 'TD-ORD-2010');

  assert.deepEqual(await at({ Id: 'lnk1', Status: 'Completed', WhatId: '500W', What: { Type: 'Case' }, Description: sent }, { request: { CaseNumber: '00001290' } }).status(),
    { sent: true, uploaded: true, caseNumber: '00001290' });
  assert.deepEqual(await at({ Id: 'lnk1', Status: 'Completed', WhatId: null, Description: sent }).status(), { sent: true, uploaded: true },
    'a link closed without its record still says the invoice came');
});

test('a matched order is brought in line with the invoice: its details, its customer and its products, every change noted', async () => {
  const org = fakeOrg({
    order: {
      Status: 'Activated', Invoice_Number__c: 'INV - 2010', Order_Source__c: 'Other', CustomerAuthorizedById: '003Z',
      ShippingStreet: 'Old street', ShippingCity: 'Delhi', ShippingPostalCode: '110001', ShippingStateCode: 'DL', ShippingCountryCode: 'IN',
    },
    contact: contactRow({ Id: '003Z', LastName: 'S', MobilePhone: '+919000000000' }),
    items: [
      { Id: '802A', Product2Id: '01tTBL', Product2: { Name: 'Demo Study Table' }, Quantity: 1, UnitPrice: 8999 },
      { Id: '802B', Product2Id: '01tSHC', Product2: { Name: 'Demo Shoe Cabinet' }, Quantity: 1, UnitPrice: 6999 },
    ],
  });
  const invoice = {
    ...INVOICE,
    items: [
      { name: 'Engineered Wood Study Table, Walnut', quantity: 2, sku: null, amount: 17000 },
      { name: 'Ergonomic Study Chair', quantity: 1, sku: null, amount: 4999 },
      { name: 'Mystery Lamp', quantity: 1, sku: null, amount: 999 },
    ],
  };
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  const result = await uploads.record({ invoice, file: FILE });
  assert.equal(result.matchedBy, 'invoice number');

  assert.deepEqual(org.log.updates.map((u) => `${u.sobject} ${u.id}`), [
    'Contact 003Z', 'Order 801Z', 'Order 801Z', 'OrderItem 802A', 'Order 801Z',
  ], 'the customer, the order, then its products while it is Draft');
  assert.deepEqual(org.log.updates[0].fields, {
    LastName: 'Sharma', MobilePhone: '+919876500000', Email: 'asha@example.com', ...addressOf('Mailing'),
  }, 'the customer takes the invoice\'s name, mobile, email and address');
  const order = org.log.updates[1].fields;
  assert.deepEqual({ ...order, Description: undefined }, {
    Order_Source__c: 'Website', EffectiveDate: '2026-10-08', ShippingStreet: '12 Civil Lines', ShippingCity: 'Jaipur', ShippingPostalCode: '302006',
    ShippingStateCode: 'RJ', ...addressOf('Billing'), Description: undefined,
  }, 'the same invoice number written differently is left as it is');
  assert.match(order.Description, /^Imported from the ERP\.\n\nInvoice details read by AI from the invoice the customer uploaded on 14 October 2026 \(invoice INV-2010\):\n/);
  assert.deepEqual(org.log.updates[2].fields, { Status: 'Draft' });
  assert.deepEqual(org.log.updates[3].fields, { Quantity: 2, UnitPrice: 8500 });
  assert.deepEqual(org.log.many, [{ sobject: 'OrderItem', records: [{ OrderId: '801Z', PricebookEntryId: '01uCHR', Quantity: 1, UnitPrice: 4999 }] }]);
  assert.deepEqual(org.log.updates[4].fields, { Status: 'Activated' }, 'the order is activated again');

  const [task] = created(org.log, 'Task');
  assert.equal(task.Subject, 'Order updated from the uploaded invoice');
  assert.equal(task.Status, 'Not Started', 'there is something for the team to check');
  assert.match(task.Description, /\nOrder:\n- Channel: Other → Website\n- Order date: 2026-10-15 → 2026-10-08\n- Delivery street: Old street → 12 Civil Lines\n- Delivery city: Delhi → Jaipur\n- Delivery PIN code: 110001 → 302006\n- Delivery state: DL → RJ\n- Billing street: \(empty\) → 12 Civil Lines\n/);
  assert.match(task.Description, /\nCustomer:\n- Last name: S → Sharma\n- Mobile: \+919000000000 → \+919876500000\n- Email: \(empty\) → asha@example\.com\n- Address street: \(empty\) → 12 Civil Lines\n/);
  assert.match(task.Description, /\nProducts:\n- Demo Study Table: quantity 1 → 2, price 8,999 rupees → 8,500 rupees\n- Demo Study Chair: added, quantity 1 at 4,999 rupees\n/);
  assert.match(task.Description, /\nCheck these:\n- "Mystery Lamp" on the invoice is not in the product catalog, so it was not added\.\n- Demo Shoe Cabinet is on the order but not on the invoice; it was left as it is\.\n/);
  assert.ok(result.changed.includes('Channel') && result.changed.includes('Mobile'));
});

test('an order without a customer gets a new contact from the invoice, and the caller\'s waiting request is linked', async () => {
  const org = fakeOrg({ links: [LINK_TO_INVOICE_PHONE], waiting: [{ Id: '500W', CaseNumber: '00001290', ContactId: '003W', Invoice_Number__c: null, Order_Source__c: null }] });
  const { uploads, crm } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  const result = await uploads.record({ invoice: INVOICE, file: FILE });

  assert.deepEqual(result.linkedCases, ['00001290']);
  const [contact] = created(org.log, 'Contact');
  assert.deepEqual(contact, {
    AccountId: '001Z', FirstName: 'Asha', LastName: 'Sharma', MobilePhone: '+919876500000', Email: 'asha@example.com', ...addressOf('Mailing'),
  });
  const order = updatesOf(org.log, 'Order')[0].fields;
  assert.equal(order.CustomerAuthorizedById, 'Contact-1');
  assert.equal(order.Invoice_Number__c, 'INV-2010');
  assert.deepEqual(org.log.many[0].records, [{ OrderId: '801Z', PricebookEntryId: '01uTBL', Quantity: 1, UnitPrice: 8999 }], 'matched by product code');
  assert.match(org.log.queries.find((q) => q.includes('FROM PricebookEntry')), /WHERE Pricebook2Id = '01sSTD' AND IsActive = true AND Product2\.IsActive = true AND Product2\.ProductCode LIKE 'TD-%'/, 'only Tiffany\'s active products');
  assert.equal(updatesOf(org.log, 'Order').length, 1, 'a Draft order needs no switch to change its products');

  assert.deepEqual(updatesOf(org.log, 'Case')[0], { sobject: 'Case', id: '500W', fields: { Order__c: '801Z', Invoice_Number__c: 'INV-2010', Order_Source__c: 'Website' } });
  assert.match(org.log.queries.find((q) => q.includes('FROM Case')), /Customer_Mobile__c IN \('\+919876500000', '9876500000'\).*CreatedDate >= 2026-10-14T05:00:00Z/);
  const [file] = created(org.log, 'ContentVersion');
  assert.deepEqual([file.FirstPublishLocationId, file.PathOnClient, file.VersionData], ['801Z', 'invoice-2026-10-14.jpg', Buffer.from('jpeg').toString('base64')]);
  const [task] = created(org.log, 'Task');
  assert.deepEqual([task.WhatId, task.WhoId, task.Status], ['801Z', 'Contact-1', 'Completed']);
  assert.match(task.Description, /\nUpload link sent on WhatsApp to \+919876500000 for Asha Sharma; on the call the customer gave INV 2010\.\n/);
  assert.match(task.Description, /\nCustomer:\n- Customer contact: \(empty\) → Asha Sharma \(new contact\)\n/);
  assert.match(task.Description, /\nRequests linked to the order: 00001290\.\n/);
  assert.equal(updatesOf(org.log, 'Task')[0].id, 'lnk1', 'the link task is completed');
  assert.equal(crm.cases.length, 0);
});

test('a value Salesforce refuses is left out on its own, and noted', async () => {
  const org = fakeOrg({ refuse: (sobject, fields) => (sobject === 'Order' && 'EffectiveDate' in fields ? 'You cannot change the start date of this order.' : null) });
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  const result = await uploads.record({ invoice: INVOICE, file: FILE });

  const saved = Object.assign({}, ...updatesOf(org.log, 'Order').map((u) => u.fields));
  assert.equal(saved.EffectiveDate, undefined);
  assert.equal(saved.Order_Source__c, 'Website', 'the other values are still saved');
  assert.equal(saved.ShippingCity, 'Jaipur');
  assert.ok(saved.Description);
  assert.ok(!result.changed.includes('Order date'));
  const [task] = created(org.log, 'Task');
  assert.equal(task.Status, 'Not Started');
  assert.match(task.Description, /\n- Order date was not changed: You cannot change the start date of this order\.\n/);
});

test('when an activated order cannot be made Draft, its products are left and it stays activated', async () => {
  const org = fakeOrg({
    order: { Status: 'Activated' },
    items: [{ Id: '802A', Product2Id: '01tTBL', Product2: { Name: 'Demo Study Table' }, Quantity: 1, UnitPrice: 8999 }],
    refuse: (sobject, fields) => (sobject === 'Order' && fields.Status === 'Draft' ? 'This order cannot be changed back to Draft.' : null),
  });
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  await uploads.record({ invoice: { ...INVOICE, items: [{ name: 'Study Table', quantity: 2, sku: 'TD-STD-01', amount: 17998 }] }, file: FILE });

  assert.equal(updatesOf(org.log, 'OrderItem').length, 0);
  assert.deepEqual(updatesOf(org.log, 'Order').at(-1).fields, { Status: 'Activated' });
  const [task] = created(org.log, 'Task');
  assert.match(task.Description, /\n- Some products were not changed: This order cannot be changed back to Draft\.\n/);
});

test('the order id is never replaced, and the same invoice adds its notes once', async () => {
  const org = fakeOrg({ order: { ERP_Order_Id__c: 'TD-ORD-9999' } });
  const { uploads } = uploadsWith({ org, crm: fakeCrm({ byInvoice: [ORDER] }) });
  await uploads.record({ invoice: INVOICE, file: FILE });
  const first = updatesOf(org.log, 'Order')[0].fields;
  assert.equal(first.ERP_Order_Id__c, undefined);
  assert.match(created(org.log, 'Task')[0].Description, /The order id is TD-ORD-9999; the invoice shows TD-ORD-2010\. The order id was left as it is\./);

  await uploads.record({ invoice: INVOICE, file: FILE });
  assert.equal(updatesOf(org.log, 'Order').filter((u) => u.fields.Description).length, 1);
});

test('by the phone on the invoice, only a customer with exactly one recent order without another invoice number or order id is matched', async () => {
  const customer = { id: '003C', name: 'Asha Sharma', accountId: '001Z', mobile: '+919876500000' };
  const one = uploadsWith({
    org: fakeOrg({ contact: contactRow({ Id: '003C', MobilePhone: '+919876500000' }) }),
    crm: fakeCrm({ contacts: [customer], accountOrders: { '001Z': [ORDER, { id: '801Y', accountId: '001Z', invoiceNumber: 'INV-1' }, { id: '801X', accountId: '001Z', erpOrderId: 'TD-ORD-1' }] } }),
  });
  const result = await one.uploads.record({ invoice: INVOICE, file: FILE });
  assert.equal(result.matchedBy, 'mobile number');
  assert.equal(updatesOf(one.org.log, 'Order')[0].fields.CustomerAuthorizedById, '003C', 'the customer is a contact of the order\'s account');
  assert.deepEqual(one.crm.references, [], 'the phone comes before the order number and the order id');

  const two = uploadsWith({ crm: fakeCrm({ contacts: [customer], accountOrders: { '001Z': [ORDER, { id: '801Y', accountId: '001Z', invoiceNumber: null }] } }) });
  const unsure = await two.uploads.record({ invoice: INVOICE, file: FILE });
  assert.equal(unsure.matched, false, 'two orders on the number: neither is picked');
  const [task] = created(two.org.log, 'Task');
  assert.match(task.Description, /Asha Sharma \(mobile ending 0000\) has 2 recent orders\./);
});

test('an order is looked up by the invoice number, else the phone, else the order number, else the order id', async () => {
  const invoice = { ...INVOICE, invoiceNumber: 'INV-NEW', orderNumber: '00000130' };
  const byNumber = uploadsWith({ crm: fakeCrm({ byReference: (ref) => (ref === '00000130' ? [ORDER] : []) }) });
  assert.equal((await byNumber.uploads.record({ invoice, file: FILE })).matchedBy, 'order number');
  assert.deepEqual(byNumber.crm.references, ['00000130'], 'the order id is not needed once the order number found it');

  const byId = uploadsWith({ crm: fakeCrm({ byReference: (ref) => (ref === 'TD-ORD-2010' ? [ORDER] : []) }) });
  assert.equal((await byId.uploads.record({ invoice, file: FILE })).matchedBy, 'order id');
  assert.deepEqual(byId.crm.references, ['00000130', 'TD-ORD-2010']);
  assert.equal(created(byId.org.log, 'Order').length, 0, 'no order is added for an invoice that matches one');
});

test('an invoice that matches no order becomes a Draft order with its customer, its details and its products', async () => {
  const org = fakeOrg({ links: [LINK_TO_INVOICE_PHONE], waiting: [{ Id: '500W', CaseNumber: '00001290', ContactId: '003W', Invoice_Number__c: null, Order_Source__c: null }] });
  const { uploads, crm } = uploadsWith({ org });
  const invoice = { ...INVOICE, orderNumber: '00000999' };
  const result = await uploads.record({ invoice, file: FILE });
  assert.deepEqual(result, { matched: false, created: true, recorded: true, orderId: 'Order-1', orderName: 'TD-ORD-2010', linkedCases: ['00001290'] });

  assert.deepEqual(crm.customers, [{
    phone: '+919876500000', name: 'Asha Sharma', accountFields: addressOf('Billing'), contactFields: { Email: 'asha@example.com', ...addressOf('Mailing') },
  }], 'a new customer under the full name on the invoice, with its email and address');
  const [order] = created(org.log, 'Order');
  assert.deepEqual({ ...order, Description: undefined }, {
    AccountId: '001N', CustomerAuthorizedById: '003N', Status: 'Draft', EffectiveDate: '2026-10-08', Pricebook2Id: '01sSTD', Description: undefined,
    Invoice_Number__c: 'INV-2010', ERP_Order_Id__c: 'TD-ORD-2010', Order_Source__c: 'Website', ...addressOf('Shipping'), ...addressOf('Billing'),
  });
  assert.match(order.Description, /^Added from the invoice the customer uploaded on 14 October 2026 \(invoice INV-2010\), because no order matched it\. Check it against the attached invoice and activate it\.\nInvoice number: INV-2010\n/);
  assert.match(order.Description, /\nSold by: Tiffany Designs Private Limited\n/);
  assert.deepEqual(org.log.many, [{ sobject: 'OrderItem', records: [{ OrderId: 'Order-1', PricebookEntryId: '01uTBL', Quantity: 1, UnitPrice: 8999 }] }]);

  assert.equal(created(org.log, 'ContentVersion')[0].FirstPublishLocationId, 'Order-1');
  assert.deepEqual(updatesOf(org.log, 'Case')[0].fields, { Order__c: 'Order-1', Invoice_Number__c: 'INV-2010', Order_Source__c: 'Website' });
  const [task] = created(org.log, 'Task');
  assert.deepEqual([task.WhatId, task.WhoId, task.Subject, task.Status], ['Order-1', '003N', 'Order added from the uploaded invoice', 'Not Started']);
  assert.match(task.Description, /\nCustomer: Asha Sharma \(new customer\), mobile \+919876500000\.\nProducts:\n- Demo Study Table: added, quantity 1 at 8,999 rupees\n/);
  assert.match(task.Description, /\nCheck these:\n- The invoice shows order number 00000999, which no order has; this order's number is 00000130\.\n/);
  assert.match(updatesOf(org.log, 'Task')[0].fields.Description, /Invoice uploaded on 14 October 2026: no order matched; order TD-ORD-2010 was added from it\.$/);
  assert.equal(crm.cases.length, 0, 'no request is opened for it');

  // A customer already on record for the phone gets the order; a name that differs is noted.
  const known = uploadsWith({ crm: fakeCrm({ contacts: [{ id: '003K', name: 'Kiran Sharma', accountId: '001K', mobile: '+919876500000' }] }) });
  await known.uploads.record({ invoice, file: FILE });
  assert.deepEqual(known.crm.customers, []);
  assert.equal(created(known.org.log, 'Order')[0].AccountId, '001K');
  assert.match(created(known.org.log, 'Task')[0].Description, /- The invoice names Asha Sharma; the mobile number \+919876500000 belongs to Kiran Sharma, so the order is on that customer\./);

  // A value Salesforce refuses costs only the invoice's details on the order.
  const strict = fakeOrg();
  strict.salesforce.create = async (sobject, fields) => {
    if (sobject === 'Order' && fields.ERP_Order_Id__c) throw new Error('Salesforce request failed (400): [{"message":"duplicate value found: ERP_Order_Id__c"}]');
    const id = sobject + '-' + (strict.log.creates.length + 1);
    strict.log.creates.push({ sobject, fields, id });
    return { id };
  };
  const saved = await uploadsWith({ org: strict }).uploads.record({ invoice: INVOICE, file: FILE });
  assert.equal(saved.created, true);
  assert.equal(created(strict.log, 'Order')[0].ERP_Order_Id__c, undefined);
  assert.match(created(strict.log, 'Task')[0].Description, /- The order was saved without its invoice number, order id, channel and addresses, because Salesforce refused them: duplicate value found: ERP_Order_Id__c\n/);
});

test('no order is added from an invoice with a product not in the catalog, without its invoice number or products, or not sold by Tiffany Designs; nothing is saved', async () => {
  const lamp = { name: 'Mystery Lamp', quantity: 1, sku: 'XY-LAMP', amount: 999 };
  const org = fakeOrg({ links: [LINK_TO_INVOICE_PHONE], waiting: [{ Id: '500W', CaseNumber: '00001290', ContactId: '003W' }] });
  const { uploads, crm } = uploadsWith({ org });
  const result = await uploads.record({ invoice: { ...INVOICE, items: [...INVOICE.items, lamp] }, file: FILE });
  assert.deepEqual(result, { matched: false, created: false, recorded: false, refused: { reason: 'product_not_available', products: ['Mystery Lamp'] } });
  assert.deepEqual(org.log.creates, [], 'no customer, order, file or note');
  assert.deepEqual([org.log.many, crm.customers, crm.cases, updatesOf(org.log, 'Case')], [[], [], [], []]);
  assert.match(org.log.queries.find((q) => q.includes('FROM PricebookEntry')), /Product2\.IsActive = true/, 'an inactive product is not available');
  assert.deepEqual(updatesOf(org.log, 'Task'), [{
    sobject: 'Task',
    id: 'lnk1',
    fields: {
      Status: 'Not Started',
      Description: `${LINK_TO_INVOICE_PHONE.Description}\nInvoice uploaded on 14 October 2026: refused and nothing was saved, because "Mystery Lamp" is not in the product catalog. `
        + 'The customer was asked to upload the right invoice or call customer care.',
    },
  }], 'the link stays open for the right invoice');

  const refusal = async (invoice) => {
    const run = uploadsWith();
    const answer = await run.uploads.record({ invoice, file: FILE });
    assert.deepEqual([run.org.log.creates, run.crm.cases], [[], []]);
    return answer.refused;
  };
  assert.deepEqual(await refusal({ ...INVOICE, invoiceNumber: null }), { reason: 'invoice_number_missing' });
  assert.deepEqual(await refusal({ ...INVOICE, items: [] }), { reason: 'no_products' });
  assert.deepEqual(await refusal({ ...INVOICE, soldBy: 'Comfort Furniture Traders' }), { reason: 'not_tiffany_invoice' });
  assert.deepEqual(await refusal({ ...INVOICE, items: [lamp, { ...lamp, name: 'Garden Swing', sku: null }] }), { reason: 'product_not_available', products: ['Mystery Lamp', 'Garden Swing'] });
});

test('no order is added when its invoice number, order number or order id is already on more than one order: the service team gets it', async () => {
  const other = { ...ORDER, id: '801Q', accountId: '001Q', invoiceNumber: 'INV-2010' };
  const { org, uploads, crm } = uploadsWith({ crm: fakeCrm({ byInvoice: [{ ...ORDER, invoiceNumber: 'INV-2010' }, other] }) });
  const result = await uploads.record({ invoice: INVOICE, file: FILE });
  assert.deepEqual(result, { matched: false, recorded: true, caseNumber: '00001300' });
  assert.equal(created(org.log, 'Order').length, 0);
  assert.deepEqual(crm.customers, []);
  assert.match(crm.cases[0].description, /\n2 orders have invoice number INV-2010\.\nNo order was added from it, because invoice number INV-2010 is already on more than one order; another would enter it twice\.\n/);

  const twoIds = uploadsWith({ crm: fakeCrm({ byReference: (ref) => (ref === 'TD-ORD-2010' ? [ORDER, other] : []) }) });
  await twoIds.uploads.record({ invoice: INVOICE, file: FILE });
  assert.equal(created(twoIds.org.log, 'Order').length, 0);
  assert.match(twoIds.crm.cases[0].description, /because order id TD-ORD-2010 is already on more than one order/);
});

test('without a full name or a phone, no order is added: the invoice goes on the caller\'s waiting request, else a new web request, else nowhere', async () => {
  const unnamed = { ...INVOICE, customerName: 'Asha' };
  const org = fakeOrg({ links: [{ ...LINK_TO_INVOICE_PHONE, Description: 'Link sent.' }], waiting: [{ Id: '500W', CaseNumber: '00001290', ContactId: '003W' }] });
  const waiting = uploadsWith({ org });
  assert.deepEqual(await waiting.uploads.record({ invoice: unnamed, file: FILE }), { matched: false, recorded: true, caseNumber: '00001290' });
  assert.equal(created(org.log, 'Order').length, 0);
  assert.equal(created(org.log, 'ContentVersion')[0].FirstPublishLocationId, '500W');
  const [task] = created(org.log, 'Task');
  assert.deepEqual([task.WhatId, task.WhoId, task.Subject, task.Status], ['500W', '003W', 'Invoice uploaded: order not found', 'Not Started']);
  assert.match(task.Description, /\nNo order was added from it, because it shows no full name, first and last, for the customer\.\n/);
  assert.equal(waiting.crm.cases.length, 0);
  assert.deepEqual(updatesOf(org.log, 'Task')[0], {
    sobject: 'Task',
    id: 'lnk1',
    fields: { Status: 'Completed', Description: 'Link sent.\nInvoice uploaded on 14 October 2026: no order matched; the invoice is on request 00001290.', WhatId: '500W' },
  });

  const fresh = uploadsWith();
  await fresh.uploads.record({ invoice: unnamed, file: FILE });
  const [input] = fresh.crm.cases;
  assert.deepEqual({ ...input, description: undefined }, {
    issueType: 'general', description: undefined, phone: '+919876500000', customerName: 'Asha', customerOptional: true, invoiceNumber: 'INV-2010',
    orderSource: 'Website', city: 'Jaipur', state: 'Rajasthan', postalCode: '302006', origin: 'Web', capturedBy: 'Registered when the customer uploaded the invoice.',
  });
  assert.match(input.description, /no order could be matched to it\.\n.*\nNo order has this invoice number, order number or order id, and no single order is on the mobile number\./);
  assert.equal(created(fresh.org.log, 'ContentVersion')[0].FirstPublishLocationId, '500N');

  const nobody = uploadsWith();
  assert.deepEqual(await nobody.uploads.record({ invoice: { ...INVOICE, phone: null }, file: FILE }), { matched: false, recorded: false });
  assert.equal(nobody.org.log.creates.length + nobody.crm.cases.length, 0, 'an invoice with no order and no phone is not recorded');
});

test('an invoice line is matched to the catalog by product code, else by the product\'s name words, the most specific one', () => {
  const none = new Set();
  const name = (item, onOrder = none) => productFor({ sku: null, ...item }, ENTRIES, onOrder)?.Product2.Name || null;
  assert.equal(name({ name: 'Anything', sku: 'td-std-pr' }), 'Demo Premium Study Table');
  assert.equal(name({ name: 'Engineered Wood Study Table with Drawer, Walnut' }), 'Demo Study Table');
  assert.equal(name({ name: 'Premium Study Table, Teak' }), 'Demo Premium Study Table', 'the most specific product wins');
  assert.equal(name({ name: 'Shoe Cabinets (pack of 1)' }), 'Demo Shoe Cabinet', 'plurals count');
  assert.equal(name({ name: 'Study Lamp' }), null);
  assert.equal(name({ name: 'स्टडी टेबल' }), null, 'a name the catalog cannot be matched to is left for the team');
});

test('a request opened from an upload is a web request, not a phone one', async () => {
  const creates = [];
  const salesforce = {
    async query(soql) {
      if (soql.includes('FROM RecordType')) return [{ Id: '012G', DeveloperName: 'General_Service_Query' }];
      if (soql.includes('SELECT CaseNumber')) return [{ CaseNumber: '00001300' }];
      return [];
    },
    async search() { return []; },
    async create(sobject, fields) { creates.push({ sobject, fields }); return { id: `${sobject}-${creates.length}` }; },
  };
  const crm = createCrm({ salesforce, businessHours: { isOpen: async () => true } });
  await crm.createServiceCase({
    issueType: 'general', description: 'Invoice uploaded.', phone: '+919876543210', origin: 'Web', customerOptional: true, capturedBy: 'Registered when the customer uploaded the invoice.',
  });
  const fields = creates.find((c) => c.sobject === 'Case').fields;
  assert.equal(fields.Origin, 'Web');
  assert.match(fields.Description, /Invoice uploaded\.\nRegistered when the customer uploaded the invoice\.$/);
  assert.deepEqual(creates.map((c) => c.sobject), ['Case'], 'with no name to save, no customer is made up');
  assert.equal(fields.Customer_Mobile__c, '+919876543210');

  // On a call the agent can ask, so the same request without a name is refused until it has one.
  const refused = await crm.createServiceCase({ issueType: 'general', description: 'x', phone: '+919876543211' });
  assert.equal(refused.created, false);
  assert.match(refused.error, /full name, first and last, is needed/);
});
