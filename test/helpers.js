const { createApp } = require('../src/app');
const { createScheduler, createMemoryJobStore } = require('../src/scheduler');
const { createJobHandlers } = require('../src/callFlows');
const { lastTenDigits } = require('../src/rules');

const SECRETS = { internalApiKey: 'internal-key', siteCallApiKey: 'site-key', agentToolSecret: 'agent-secret', webhookToken: 'hook-token', cronSecret: 'cron-secret' };

function testConfig(overrides = {}) {
  return {
    ...SECRETS,
    publicBaseUrl: 'https://voice.example.test',
    followUpDelayMinutes: 60,
    sarvam: { followUpCampaignId: 'camp-followup', callbackCampaignId: 'camp-callback', notifyCampaignId: 'camp-notify' },
    callbacks: { allowedNumbers: 'any', maxPerHour: 20, maxPerDay: 100 },
    ...overrides,
  };
}

// In-memory stand-in shaped like the Tiffany org: orders hang off accounts, customers quote TD-ORD ids.
function createFakeCrm({ now = () => Date.now() } = {}) {
  const contacts = [
    { id: '003A', name: 'Aarav Sharma', firstName: 'Aarav', accountId: '001A', mobile: '(987) 654-3210', phone: null },
    { id: '003B', name: 'Meera Iyer', firstName: 'Meera', accountId: '001B', mobile: null, phone: '+91 98200 11111' },
  ];
  const orders = [
    { id: '801A', orderNumber: '00000101', erpOrderId: 'TD-ORD-1001', invoiceNumber: 'INV-2001', orderSource: 'Website', deliveryStatus: 'Delivered', deliveryDate: '2026-10-14', accountId: '001A', accountName: 'Aarav Sharma', contactId: null, city: 'Delhi', postalCode: '110001', productSummary: 'Demo 3-Door Wardrobe' },
    { id: '801B', orderNumber: '00000114', erpOrderId: 'TD-ORD-1111', invoiceNumber: 'INV-1111', orderSource: 'Flipkart', deliveryStatus: 'Processing', deliveryDate: null, accountId: '001B', accountName: 'Meera Iyer', contactId: '003B', city: 'Jaipur', postalCode: '302012', productSummary: 'Demo Bookcase' },
    { id: '801C', orderNumber: '00000117', erpOrderId: 'TD-ORD-3333', invoiceNumber: 'INV-3333', orderSource: 'Showroom', deliveryStatus: 'Delivered', deliveryDate: '2026-10-14', accountId: '001C', accountName: 'No Phone Customer', contactId: null, city: null, postalCode: null, productSummary: 'Demo Desk' },
  ];
  const parts = [
    { name: 'Hardware Kit', partNumber: 'WRD-3D-HDW-001', productName: 'Demo 3-Door Wardrobe' },
    { name: 'Shelf', partNumber: 'WRD-3D-PNL-003', productName: 'Demo 3-Door Wardrobe' },
    { name: 'Side Panel', partNumber: 'BKC-01-PNL-002', productName: 'Demo Bookcase' },
  ];
  const serviceCases = [
    {
      id: '500X', caseNumber: '00001063', accountId: '001A', serviceType: 'Installation', status: 'Appointment Scheduled',
      phone: '+919876543210', customerName: 'Aarav Sharma', erpOrderId: 'TD-ORD-1001',
      visit: { status: 'Appointment Scheduled', scheduledStart: '2026-10-16T05:30:00.000Z', technician: 'Demo Tech - Vikram (Internal)' },
      shipment: null,
    },
    {
      id: '500Y', caseNumber: '00001060', accountId: '001B', serviceType: 'Damage or Defect', status: 'Replacement Dispatched',
      phone: '+91 98200 11111', customerName: 'Meera Iyer', erpOrderId: 'TD-ORD-1111',
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
  const state = { withinBusinessHours: true };

  return {
    created,
    tasks,
    state,
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
    async getOrderByInvoice(invoiceNumber) {
      return orders.find((o) => o.invoiceNumber === invoiceNumber) || null;
    },
    async findRecentOrdersForAccount(accountId, limit = 5) {
      return orders.filter((o) => o.accountId === accountId).slice(0, limit);
    },
    async getOrderContact(order) {
      return contacts.find((c) => c.id === order.contactId) || contacts.find((c) => c.accountId === order.accountId) || null;
    },
    async verifyOrder(reference, verification) {
      const orderNumber = /^\d{1,10}$/.test(String(reference)) ? String(reference).padStart(8, '0') : null;
      const order = orders.find((o) => o.erpOrderId === reference || (orderNumber && o.orderNumber === orderNumber));
      if (!order || !verification) return { found: false };
      const byInvoice = order.invoiceNumber.toLowerCase() === String(verification).toLowerCase();
      const byPhone = contacts.some((c) => c.accountId === order.accountId && [c.mobile, c.phone].some((p) => p && lastTenDigits(p) === lastTenDigits(verification)));
      if (!byInvoice && !byPhone) return { found: false };
      return { found: true, customerName: order.accountName, orderSource: order.orderSource, deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate, order };
    },
    async findParts({ erpOrderId, productName }) {
      if (erpOrderId) {
        const order = orders.find((o) => o.erpOrderId === erpOrderId);
        return order ? parts.filter((p) => p.productName === order.productSummary) : [];
      }
      return parts.filter((p) => p.productName.toLowerCase().includes(String(productName).toLowerCase()));
    },
    async createServiceCase(input) {
      if (!input.phone && !(input.erpOrderId && (input.verification || input.invoiceNumber))) {
        return { created: false, error: 'Customer mobile or email (or a verifiable order) is required.' };
      }
      const verified = input.erpOrderId ? (await this.verifyOrder(input.erpOrderId, input.verification || input.invoiceNumber || input.phone)).found : false;
      const order = verified ? orders.find((o) => o.erpOrderId === input.erpOrderId) : null;
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

function createFakeSarvam({ canStartCalls = true } = {}) {
  const calls = [];
  const started = [];
  return {
    calls,
    started,
    canStartCalls,
    failNext: 0,
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

async function startTestServer({ nowMs = Date.parse('2026-10-14T06:30:00Z'), config = testConfig(), instantCalls = true } = {}) {
  const clock = { now: nowMs };
  const now = () => clock.now;
  const crm = createFakeCrm({ now });
  const sarvam = createFakeSarvam({ canStartCalls: instantCalls });
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
    checkSalesforce: async () => ({ dailyApiRequests: { Max: 15000, Remaining: 14999 } }),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
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
