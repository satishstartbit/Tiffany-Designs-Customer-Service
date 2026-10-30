const { createApp } = require('../src/app');
const { createScheduler, createMemoryJobStore } = require('../src/scheduler');
const { createJobHandlers } = require('../src/callFlows');
const { lastTenDigits, nameWords, namesMatch, sameReference } = require('../src/rules');
const { SERVICE_TYPES, requestKind, findOrderFromReferences } = require('../src/crm/crm');

const SECRETS = { internalApiKey: 'internal-key', siteCallApiKey: 'site-key', agentToolSecret: 'agent-secret', webhookToken: 'hook-token', cronSecret: 'cron-secret' };

function testConfig(overrides = {}) {
  return {
    ...SECRETS,
    publicBaseUrl: 'https://voice.example.test',
    followUpDelayMinutes: 60,
    sarvam: {
      orgId: 'org-1',
      workspaceId: 'ws-1',
      agentId: 'Tiffany-Test-Agent',
      appVersion: 3,
      followUpCampaignId: 'camp-followup',
      callbackCampaignId: 'camp-callback',
      notifyCampaignId: 'camp-notify',
    },
    callbacks: { allowedNumbers: 'any', maxPerHour: 20, maxPerDay: 100 },
    webCalls: { maxPerHour: 30, maxPerDay: 200 },
    ...overrides,
  };
}

// In-memory stand-in shaped like the Tiffany org: orders hang off accounts, customers quote TD-ORD ids.
function createFakeCrm({ now = () => Date.now() } = {}) {
  const contacts = [
    { id: '003A', name: 'Aarav Sharma', firstName: 'Aarav', accountId: '001A', mobile: '(987) 654-3210', phone: null, postalCode: '110001' },
    { id: '003B', name: 'Meera Iyer', firstName: 'Meera', accountId: '001B', mobile: null, phone: '+91 98200 11111', postalCode: '600001' },
  ];
  const orders = [
    { id: '801A', orderNumber: '00000101', erpOrderId: 'TD-ORD-1001', invoiceNumber: 'INV-2001', orderSource: 'Website', deliveryStatus: 'Delivered', deliveryDate: '2026-10-14', accountId: '001A', accountName: 'Aarav Sharma', contactId: null, street: '12 Lodhi Road', city: 'Delhi', postalCode: '110001', productSummary: 'Demo 3-Door Wardrobe' },
    { id: '801B', orderNumber: '00000114', erpOrderId: 'TD-ORD-1111', invoiceNumber: 'INV-1111', orderSource: 'Flipkart', deliveryStatus: 'Processing', deliveryDate: null, accountId: '001B', accountName: 'Meera Iyer', contactId: '003B', street: '4 MI Road', city: 'Jaipur', postalCode: '302012', productSummary: 'Demo Bookcase' },
    { id: '801C', orderNumber: '00000117', erpOrderId: 'TD-ORD-3333', invoiceNumber: 'INV-3333', orderSource: 'Showroom', deliveryStatus: 'Delivered', deliveryDate: '2026-10-14', accountId: '001C', accountName: 'No Phone Customer', contactId: null, city: null, postalCode: null, productSummary: 'Demo Desk' },
    // A phone order: no ERP id or invoice yet, only the Salesforce order number.
    // Two orders sharing one invoice number, as the org has (INV-2006).
    { id: '801E', orderNumber: '00000105', erpOrderId: 'TD-ORD-1006', invoiceNumber: 'INV-7777', orderSource: 'Website', deliveryStatus: 'Delivered', deliveryDate: '2026-10-01', accountId: '001C', accountName: 'No Phone Customer', contactId: null, city: null, postalCode: null, productSummary: 'Demo Desk' },
    { id: '801F', orderNumber: '00000120', erpOrderId: 'TD-ORD-1008', invoiceNumber: 'INV-7777', orderSource: 'Website', deliveryStatus: 'Delivered', deliveryDate: '2026-10-02', accountId: '001C', accountName: 'No Phone Customer', contactId: null, city: null, postalCode: null, productSummary: 'Demo Desk' },
    { id: '801D', orderNumber: '00000122', erpOrderId: null, invoiceNumber: null, orderSource: 'Other', deliveryStatus: null, deliveryDate: null, accountId: '001B', accountName: 'Meera Iyer', contactId: '003B', street: '4 MI Road', city: 'Jaipur', postalCode: '302012', productSummary: 'Demo Kids Bed' },
  ];
  const parts = [
    { name: 'Hardware Kit', partNumber: 'WRD-3D-HDW-001', productName: 'Demo 3-Door Wardrobe' },
    { name: 'Shelf', partNumber: 'WRD-3D-PNL-003', productName: 'Demo 3-Door Wardrobe' },
    { name: 'Side Panel', partNumber: 'BKC-01-PNL-002', productName: 'Demo Bookcase' },
  ];
  const serviceCases = [
    {
      id: '500X', caseNumber: '00001063', accountId: '001A', serviceType: 'Installation', status: 'Appointment Scheduled',
      phone: '+919876543210', customerName: 'Aarav Sharma', contactName: 'Aarav Sharma', accountName: 'Demo Customer - Aarav Sharma', erpOrderId: 'TD-ORD-1001',
      visit: { status: 'Appointment Scheduled', scheduledStart: '2026-10-16T05:30:00.000Z', technician: 'Demo Tech - Vikram (Internal)' },
      shipment: null,
    },
    {
      id: '500Y', caseNumber: '00001060', accountId: '001B', serviceType: 'Damage or Defect', status: 'Replacement Dispatched',
      phone: '+91 98200 11111', customerName: 'Meera Iyer', contactName: 'Meera Iyer', accountName: 'Demo Customer - Meera Iyer', erpOrderId: 'TD-ORD-1111',
      visit: null,
      shipment: { id: 'a01', status: 'Dispatched', expectedDate: '2026-10-18', courier: 'BlueDart', trackingNumber: 'BD123', component: 'Demo Bookcase - Side Panel' },
    },
  ];
  const products = [
    { name: 'Demo Study Table', productCode: 'TD-STD-01', unitPrice: 8999 },
    { name: 'Demo Premium Study Table', productCode: 'TD-STD-PR', unitPrice: 15999 },
    { name: 'Demo Study Chair', productCode: 'TD-CHR-01', unitPrice: 4999 },
    { name: 'Demo Bookcase', productCode: 'TD-BKC-01', unitPrice: 7499 },
    { name: 'Demo Shoe Cabinet', productCode: 'TD-SHC-01', unitPrice: 6999 },
    { name: 'Demo Storage Cabinet', productCode: 'TD-STC-01', unitPrice: 9999 },
    { name: 'Demo TV Cabinet', productCode: 'TD-TVC-01', unitPrice: 12999 },
  ];
  const ncr = ['delhi', 'new delhi', 'noida', 'gurugram', 'gurgaon', 'ghaziabad', 'faridabad', 'greater noida'];
  const placedOrders = [];
  const created = [];
  const tasks = [];
  const savedCustomers = [];
  // Open requests on orders as the duplicate check sees them, newest first; tests add their own.
  const openRequests = [];
  const savedLanguages = [];
  const weekly = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((day) => ({ day, window: day === 'Sunday' ? null : { start: 9 * 60, end: 18 * 60 } }));
  const state = {
    withinBusinessHours: true,
    // Wednesday 14 October 2026: open until 18:00 IST; when closed, back on Thursday at 09:00 IST.
    serviceHours: { configured: true, open: true, closesAt: '2026-10-14T12:30:00.000Z', opensAt: null, holidayName: null, weekly },
  };
  const history = {
    '001A': {
      cases: [
        { caseNumber: '00001063', serviceType: 'Installation', subType: 'Initial Installation', status: 'Appointment Scheduled', closed: false, createdDate: '2026-10-12T05:00:00.000Z' },
        { caseNumber: '00001040', serviceType: 'Damage or Defect', subType: 'Missing Component', status: 'Closed', closed: true, createdDate: '2026-09-20T05:00:00.000Z' },
      ],
      calls: [{ direction: 'Outbound', outcome: 'delivered_ok', date: '2026-10-13' }, { direction: 'Inbound', outcome: 'Not connected: busy', date: '2026-10-10' }],
    },
  };

  return {
    created,
    tasks,
    state,
    savedCustomers,
    openRequests,
    savedLanguages,
    async getOpenRequests(orderId) {
      return openRequests.filter((r) => r.orderId === orderId);
    },
    async savePreferredLanguage(contactId, language) {
      savedLanguages.push({ contactId, language });
      return { saved: true, language };
    },
    async getServiceHours() {
      return state.serviceHours;
    },
    async checkServiceArea({ city, postalCode }) {
      const pin = String(postalCode || '').replace(/\D/g, '');
      if (postalCode && !/^[1-9]\d{5}$/.test(pin)) return { valid: false, reason: 'pin' };
      if (!city && !pin) return { valid: false, reason: 'missing' };
      const inNcr = ncr.includes(String(city || '').trim().toLowerCase()) || ['110', '121', '122', '201'].includes(pin.slice(0, 3));
      return { valid: true, route: inNcr ? 'Internal' : 'External Provider', city: city ? String(city).trim() : null, postalCode: pin || null };
    },
    async saveCustomerDetails(input) {
      const existing = await this.findContactByPhone(input.phone);
      if (!existing && !input.customerName) return { saved: false, error: "The customer's name is needed to save a new customer." };
      savedCustomers.push({ input, existing: Boolean(existing) });
      return existing
        ? { saved: true, newCustomer: false, name: existing.name, contactId: existing.id }
        : { saved: true, newCustomer: true, name: input.customerName, contactId: `003S${savedCustomers.length}` };
    },
    async getServiceHistory({ accountId }) {
      return history[accountId] || { cases: [], calls: [] };
    },
    async findContactByPhone(phone) {
      return contacts.find((c) => [c.mobile, c.phone].some((p) => p && lastTenDigits(p) === lastTenDigits(phone))) || null;
    },
    async getContactById(id) {
      return contacts.find((c) => c.id === id) || null;
    },
    async getOrderById(id) {
      return orders.find((o) => o.id === id) || null;
    },
    async getOrderByErpId(erpOrderId) {
      return orders.find((o) => o.erpOrderId === erpOrderId) || null;
    },
    async findOrdersByInvoice(invoiceNumber) {
      const plain = (v) => String(v || '').toUpperCase().replace(/[\s_-]+/g, '');
      const exact = orders.filter((o) => o.invoiceNumber && plain(o.invoiceNumber) === plain(invoiceNumber));
      return exact.length ? exact : orders.filter((o) => sameReference(invoiceNumber, o.invoiceNumber));
    },
    async getOrderByInvoice(invoiceNumber) {
      return orders.find((o) => o.invoiceNumber && o.invoiceNumber.toLowerCase() === String(invoiceNumber).trim().toLowerCase()) || null;
    },
    async findRecentOrdersForAccount(accountId, limit = 5) {
      return orders.filter((o) => o.accountId === accountId).slice(0, limit);
    },
    async getOrderContact(order) {
      return contacts.find((c) => c.id === order.contactId) || contacts.find((c) => c.accountId === order.accountId) || null;
    },
    // Like the real one: the exact ERP id first, else the order number or ERP ids ending in the number said.
    async findOrdersByReference(reference) {
      const ref = String(reference || '').trim();
      const plain = (v) => String(v || '').toUpperCase().replace(/[\s_-]+/g, '');
      const exact = orders.filter((o) => o.erpOrderId && plain(o.erpOrderId) === plain(ref));
      if (exact.length) return exact;
      const digits = (/^(?:ord(?:er)?)?(?:\s*(?:no|number))?[\s.#:-]*([\d\s]{1,14})$/i.exec(ref) || [])[1];
      const orderNumber = digits ? digits.replace(/\D/g, '').padStart(8, '0') : null;
      return orders.filter((o) => (orderNumber && o.orderNumber === orderNumber) || (o.erpOrderId && sameReference(ref, o.erpOrderId)));
    },
    async findOrderByReference(reference) {
      const matches = await this.findOrdersByReference(reference);
      return matches.length === 1 ? matches[0] : null;
    },
    async verifyOrder(reference, verification, { customerName } = {}) {
      const factors = [].concat(verification).map((f) => String(f ?? '').trim()).filter(Boolean);
      const order = await this.findOrderByReference(reference);
      if (!order || (!factors.length && !customerName)) return { found: false };
      const byInvoice = Boolean(order.invoiceNumber) && factors.some((f) => order.invoiceNumber.toLowerCase() === f.toLowerCase());
      const byPhone = contacts.some((c) => c.accountId === order.accountId && [c.mobile, c.phone].some((p) => p && factors.some((f) => lastTenDigits(f) && lastTenDigits(p) === lastTenDigits(f))));
      const byName = Boolean(customerName) && (namesMatch(customerName, order.accountName)
        || contacts.some((c) => c.accountId === order.accountId && namesMatch(customerName, c.name)));
      if (!byInvoice && !byPhone && !byName) return { found: false };
      const verifiedBy = byInvoice ? 'invoice' : byPhone ? 'phone' : 'name';
      return { found: true, customerName: order.accountName, orderSource: order.orderSource, deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate, order, verifiedBy };
    },
    async findCustomerByNameAndPin(customerName, postalCode) {
      const pin = String(postalCode || '').replace(/\D/g, '');
      if (nameWords(customerName).length < 2 || !/^[1-9]\d{5}$/.test(pin)) return { status: 'invalid' };
      const matches = contacts.filter((c) => namesMatch(customerName, c.name) && c.postalCode === pin);
      if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'none' };
      return { status: 'found', contact: matches[0] };
    },
    async findParts({ erpOrderId, productName }) {
      if (erpOrderId) {
        const order = orders.find((o) => o.erpOrderId === erpOrderId);
        return order ? parts.filter((p) => p.productName === order.productSummary) : [];
      }
      return parts.filter((p) => p.productName.toLowerCase().includes(String(productName).toLowerCase()));
    },
    async getDetailsOnFile({ order, contact }) {
      const person = order ? await this.getOrderContact(order) : contact;
      return {
        contactId: person?.id || null,
        accountId: order?.accountId || person?.accountId || null,
        name: person?.name || order?.accountName || null,
        mobile: person?.mobile || person?.phone || null,
        street: order ? order.street || null : person?.street || null,
        city: order ? order.city : person?.city || null,
        state: null,
        postalCode: order ? order.postalCode : person?.postalCode || null,
      };
    },
    // Like the real one: a number on the order's customer record (a contact of its account or its own contact).
    async confirmOrderNumber(order, phones) {
      const onRecord = contacts.filter((c) => c.accountId === order.accountId || c.id === order.contactId)
        .flatMap((c) => [c.mobile, c.phone]).map(lastTenDigits).filter(Boolean);
      const match = phones.map(lastTenDigits).find((p) => p && onRecord.includes(p));
      return { onRecord: onRecord.length > 0, confirmed: Boolean(match), phone: match ? `+91${match}` : null };
    },
    async createServiceCase(input) {
      const { serviceType, subType } = SERVICE_TYPES[input.issueType];
      // Like the real one: installation, damage and replacement requests need an order found by any of its numbers,
      // confirmed by a number on its customer record.
      const { order: found } = await findOrderFromReferences(this, {
        orderId: input.erpOrderId, orderNumber: input.orderNumber, invoiceNumber: input.invoiceNumber, phone: input.phone,
      });
      if (!found && serviceType !== 'General Query') {
        return { created: false, error: 'An installation, damage or replacement request is registered only for an order.' };
      }
      const check = found ? await this.confirmOrderNumber(found, [input.phone, input.orderPhone, input.callerPhone]) : null;
      if (found && !check.confirmed && serviceType !== 'General Query') {
        return { created: false, error: check.onRecord ? "Nothing was registered, because the order is not confirmed as the customer's yet." : 'Nothing was registered: no mobile number is on record for this order.' };
      }
      const linked = check?.confirmed ? found : null;
      if (!input.phone && !(linked && input.useDetailsOnFile)) {
        return { created: false, error: 'A mobile number is needed to register the request.' };
      }
      // Like the real one: a new request of a kind already open on the order is refused unless the caller wants a second.
      const kind = input.issueType === 'installation_reschedule' ? null : requestKind(serviceType, subType);
      const existing = linked && kind && !input.newRequest ? openRequests.find((r) => r.orderId === linked.id && r.kind === kind) : null;
      if (existing) return { created: false, existingRequest: existing, error: `Request ${existing.caseNumber} of this kind is already open for the order.` };
      const verified = Boolean(linked);
      const order = linked;
      const city = (input.city || order?.city || '').toLowerCase();
      const pin = String(input.postalCode || order?.postalCode || '');
      const route = !city && !pin ? null : ncr.includes(city) || ['110', '121', '122', '201'].includes(pin.slice(0, 3)) ? 'Internal' : 'External Provider';
      const record = { caseId: `500${created.length}`, caseNumber: String(1100 + created.length).padStart(8, '0'), input, createdAt: now() };
      created.push(record);
      return { created: true, caseId: record.caseId, caseNumber: record.caseNumber, serviceRoute: route, withinBusinessHours: state.withinBusinessHours, orderVerified: verified };
    },
    async getCaseStatus({ caseNumber, accountId }) {
      if (caseNumber) return serviceCases.filter((c) => c.caseNumber === String(caseNumber).padStart(8, '0'));
      return serviceCases.filter((c) => c.accountId === accountId);
    },
    async getCaseNotice({ caseId, caseNumber }) {
      return serviceCases.find((c) => c.id === caseId || (caseNumber && c.caseNumber === String(caseNumber).padStart(8, '0'))) || null;
    },
    placedOrders,
    async findProducts(query) {
      const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      return words.length ? products.filter((p) => words.every((w) => p.name.toLowerCase().includes(w))) : products;
    },
    async createOrder(input) {
      if (!input.items) return { created: false, error: 'No product was given. Ask which product and how many.' };
      const contact = await this.findContactByPhone(input.phone);
      const record = {
        orderId: `801N${placedOrders.length}`,
        orderNumber: String(120 + placedOrders.length).padStart(8, '0'),
        contactId: contact?.id || `003N${placedOrders.length}`,
        createdAt: now(),
        input,
      };
      placedOrders.push(record);
      return {
        created: true,
        orderId: record.orderId,
        orderNumber: record.orderNumber,
        total: 18997,
        lines: [
          { name: 'Demo Study Table', productCode: 'TD-STD-01', quantity: 1, unitPrice: 8999 },
          { name: 'Demo Study Chair', productCode: 'TD-CHR-01', quantity: 2, unitPrice: 4999 },
        ],
        newCustomer: !contact,
      };
    },
    async findVoiceOrderSince({ orderNumber, contactId, since }) {
      const recent = placedOrders.filter((o) => o.createdAt >= Date.parse(since)).reverse();
      const padded = String(orderNumber || '').replace(/\D/g, '').padStart(8, '0');
      const match = recent.find((o) => orderNumber && o.orderNumber === padded) || recent.find((o) => contactId && o.contactId === contactId);
      return match ? { id: match.orderId, orderNumber: match.orderNumber } : null;
    },
    async findVoiceCaseSince(phone, since) {
      const match = [...created].reverse().find((c) => c.input.phone === phone && c.createdAt >= Date.parse(since));
      return match ? { id: match.caseId, caseNumber: match.caseNumber } : null;
    },
    async logCall(input) {
      tasks.push(input);
      return { id: `00T${tasks.length}` };
    },
  };
}

function createFakeSarvam({ canStartCalls = true, canStartWebCalls = true } = {}) {
  const calls = [];
  const started = [];
  const webSessions = [];
  return {
    calls,
    started,
    webSessions,
    canStartCalls,
    canStartWebCalls,
    failNext: 0,
    webResponse: { status: 200, body: JSON.stringify({ url: 'wss://apps.sarvam.test/session?token=t1', reference_id: 'ref-1', expires_at: '2026-10-14T07:00:00Z' }), retryAfter: null },
    async getWebCallUrl(query) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('Sarvam unavailable');
      }
      webSessions.push(query);
      return this.webResponse;
    },
    async addToCampaign(campaignId, label, users) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('Sarvam unavailable');
      }
      calls.push({ campaignId, label, users });
      return { status: 'processing', cohort_id: `cohort-${calls.length}` };
    },
    async startCall(call) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('Sarvam unavailable');
      }
      started.push(call);
      return { attemptId: `attempt-${started.length}` };
    },
  };
}

// `crm` replaces the in-memory fake, for example with the real one over a fake Salesforce.
async function startTestServer({
  nowMs = Date.parse('2026-10-14T06:30:00Z'), config = testConfig(), instantCalls = true, webCalls = true, consoleData, crm: realCrm, invoices,
} = {}) {
  const clock = { now: nowMs };
  const now = () => clock.now;
  const crm = realCrm || createFakeCrm({ now });
  const sarvam = createFakeSarvam({ canStartCalls: instantCalls, canStartWebCalls: webCalls });
  const logger = { error() {}, warn() {}, log() {} };
  const scheduler = createScheduler({
    store: createMemoryJobStore(),
    handlers: createJobHandlers({ sarvam, config }),
    now,
    logger,
  });
  const app = createApp({
    crm,
    sarvam,
    scheduler,
    config,
    now,
    logger,
    consoleData,
    invoices: typeof invoices === 'function' ? invoices({ now, crm }) : invoices,
    checkSalesforce: async () => ({ dailyApiRequests: { Max: 15000, Remaining: 14999 } }),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, headers = {} } = {}) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body);
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    clock,
    crm,
    sarvam,
    scheduler,
    call,
    internal: { 'x-api-key': SECRETS.internalApiKey },
    site: { 'x-api-key': SECRETS.siteCallApiKey },
    agent: { 'x-agent-secret': SECRETS.agentToolSecret },
    cron: { authorization: `Bearer ${SECRETS.cronSecret}` },
    hookPath: (path) => `${path}?token=${SECRETS.webhookToken}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startTestServer, testConfig, createFakeCrm, createFakeSarvam, SECRETS };
