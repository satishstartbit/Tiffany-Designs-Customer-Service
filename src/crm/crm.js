const { lastTenDigits, normalizePhone, nameWords, namesMatch, joinDigits, trailingNumber, sameReference } = require('../rules');
const { todayInIst } = require('../dates');
const { createBusinessHours } = require('./businessHours');
const { parseItems } = require('./orderItems');

// Limits on what the voice agent may order in one call; bigger orders go to the sales team.
const MAX_ORDER_LINES = 10;
const MAX_LINE_QUANTITY = 10;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const STATE_ALIASES = { 'new delhi': 'delhi', 'nct of delhi': 'delhi', orissa: 'odisha', pondicherry: 'puducherry' };
// Words that say nothing about which product is meant; a query of only these lists the whole catalog.
const GENERIC_WORDS = new Set([
  'furniture', 'product', 'item', 'thing', 'all', 'any', 'anything', 'everything', 'something', 'the', 'and', 'for',
  'with', 'want', 'need', 'buy', 'order', 'new', 'tiffany', 'design', 'demo', 'have', 'you', 'what', 'which', 'show',
]);

// Case record type for each Service_Type__c, by developer name.
const RECORD_TYPE_BY_SERVICE_TYPE = {
  Installation: 'Installation_Request',
  'Damage or Defect': 'Damage_Defect_Complaint',
  Replacement: 'Replacement_Request',
  'General Query': 'General_Service_Query',
};

// Requests that need no visit or pickup, so no address.
const ADDRESS_FREE_ISSUES = new Set(['general', 'escalation']);

// Voice issue types -> the org's restricted Service_Type__c / Service_Sub_Type__c values.
const SERVICE_TYPES = {
  installation: { serviceType: 'Installation', subType: 'Initial Installation' },
  installation_reschedule: { serviceType: 'Installation', subType: 'Installation Rescheduling' },
  installation_followup: { serviceType: 'Installation', subType: 'Installation Follow-up' },
  reinstallation: { serviceType: 'Installation', subType: 'Re-installation' },
  damaged: { serviceType: 'Damage or Defect', subType: 'Damaged Component' },
  delivery_damage: { serviceType: 'Damage or Defect', subType: 'Damage During Delivery' },
  defective: { serviceType: 'Damage or Defect', subType: 'Defective Component' },
  missing_parts: { serviceType: 'Damage or Defect', subType: 'Missing Component' },
  wrong_part: { serviceType: 'Damage or Defect', subType: 'Wrong Component' },
  quality_issue: { serviceType: 'Damage or Defect', subType: 'Product Quality Issue' },
  replacement: { serviceType: 'Replacement', subType: null },
  return: { serviceType: 'Replacement', subType: null },
  general: { serviceType: 'General Query', subType: null },
  escalation: { serviceType: 'General Query', subType: null },
};

// What a request is about: installation, installation_followup, damage or replacement. A new request of the same kind
// as one open on the same order is registered only when the caller wants a second one. Older cases often have no sub
// type, so kinds are broad; general queries and call backs are not compared.
function requestKind(serviceType, subType) {
  if (serviceType === 'Installation') return ['Installation Follow-up', 'Re-installation'].includes(subType) ? 'installation_followup' : 'installation';
  if (serviceType === 'Damage or Defect') return 'damage';
  if (serviceType === 'Replacement') return 'replacement';
  return null;
}

// The languages the voice agent speaks, as Salesforce stores a caller's choice.
const AGENT_LANGUAGES = ['English', 'Hindi', 'Bengali', 'Gujarati', 'Kannada', 'Malayalam', 'Marathi', 'Odia', 'Punjabi', 'Tamil', 'Telugu'];

const ORDER_FIELDS = [
  'Id', 'OrderNumber', 'ERP_Order_Id__c', 'Invoice_Number__c', 'Order_Source__c', 'Delivery_Status__c',
  'Delivery_Date__c', 'AccountId', 'Account.Name', 'CustomerAuthorizedById', 'ShippingStreet', 'ShippingCity', 'ShippingPostalCode',
  'ShippingState',
].join(', ');

const CONTACT_FIELDS = 'Id, FirstName, LastName, AccountId, MobilePhone, Phone, MailingStreet, MailingCity, MailingState, MailingPostalCode';

const VISIT_SUBQUERY = '(SELECT Id, Status__c, Scheduled_Start__c, Technician__r.Name FROM Service_Visits__r ORDER BY Scheduled_Start__c DESC NULLS LAST LIMIT 1)';
const SHIPMENT_SUBQUERY = '(SELECT Id, Shipment_Status__c, Expected_Delivery_Date__c, Courier__c, Tracking_Number__c, Component__r.Name FROM Replacement_Shipments__r ORDER BY CreatedDate DESC LIMIT 1)';

function escapeSoql(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeSoqlLike(value) {
  return escapeSoql(value).replace(/[%_]/g, '\\$&');
}

function escapeSosl(value) {
  return String(value).replace(/[?&|!{}[\]()^~*:\\"'+-]/g, '\\$&');
}

function soqlDateTime(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toOrder(row, items = []) {
  if (!row) return null;
  return {
    id: row.Id,
    orderNumber: row.OrderNumber,
    erpOrderId: row.ERP_Order_Id__c,
    invoiceNumber: row.Invoice_Number__c,
    orderSource: row.Order_Source__c,
    deliveryStatus: row.Delivery_Status__c,
    deliveryDate: row.Delivery_Date__c,
    accountId: row.AccountId,
    accountName: row.Account?.Name || null,
    contactId: row.CustomerAuthorizedById,
    street: row.ShippingStreet,
    city: row.ShippingCity,
    postalCode: row.ShippingPostalCode,
    state: row.ShippingState,
    items,
    productSummary: items.map((i) => i.productName).filter(Boolean).join(', '),
  };
}

function toContact(row) {
  if (!row) return null;
  return {
    id: row.Id,
    name: [row.FirstName, row.LastName].filter(Boolean).join(' '),
    firstName: row.FirstName,
    accountId: row.AccountId,
    mobile: row.MobilePhone,
    phone: row.Phone,
    street: row.MailingStreet,
    city: row.MailingCity,
    state: row.MailingState,
    postalCode: row.MailingPostalCode,
  };
}

function toVisit(record) {
  if (!record) return null;
  return { status: record.Status__c, scheduledStart: record.Scheduled_Start__c, technician: record.Technician__r?.Name || null };
}

function toShipment(record) {
  if (!record) return null;
  return {
    id: record.Id,
    status: record.Shipment_Status__c,
    expectedDate: record.Expected_Delivery_Date__c,
    courier: record.Courier__c,
    trackingNumber: record.Tracking_Number__c,
    component: record.Component__r?.Name || null,
  };
}

// The ways a caller says one id ("td ord 1001", "TD-ORD-1001"), as SOQL literals; SOQL equality ignores case.
function idForms(value) {
  const raw = String(value || '').trim();
  const dashed = raw.toUpperCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-');
  return [...new Set([raw, dashed].filter(Boolean))].map((f) => `'${escapeSoql(f)}'`).join(', ');
}

// Salesforce order number as stored (8 digits) from "122", "00000122", "ORD-00000122" or "order number 122".
function orderNumberOf(reference) {
  const match = /^(?:ord(?:er)?)?(?:\s*(?:no|number))?[\s.#:-]*([\d\s]{1,14})$/i.exec(String(reference || '').trim());
  const digits = match ? match[1].replace(/\D/g, '') : '';
  return digits && digits.length <= 10 ? digits.padStart(8, '0') : null;
}

// Salesforce's state picklist entries that belong to India (the org uses state and country picklists).
function indianStatesOf(described) {
  const field = (n) => described.fields.find((f) => f.name === n)?.picklistValues || [];
  const india = field('ShippingCountryCode').findIndex((c) => c.value === 'IN');
  if (india < 0) return [];
  return field('ShippingStateCode')
    .filter((state) => {
      const bits = state.validFor ? Buffer.from(state.validFor, 'base64') : null;
      return state.active && bits && (bits[india >> 3] & (0x80 >> (india % 8)));
    })
    .map((state) => ({ value: state.value, label: state.label }));
}

function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function createCrm({
  salesforce,
  now = () => Date.now(),
  businessHours = createBusinessHours({ salesforce, now }),
  customerAccountRecordType = '',
  productCodePrefix = 'TD-',
}) {
  let recordTypes = null;
  let customerRecordTypeId;
  let catalogCache = null;
  let regionCache = null;
  let indianStates = null;

  // Without a configured customer record type, new accounts get the org default (today "Service Provider").
  async function accountRecordTypeId() {
    if (!customerAccountRecordType) return undefined;
    if (customerRecordTypeId === undefined) {
      const [row] = await salesforce.query(
        `SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND DeveloperName = '${escapeSoql(customerAccountRecordType)}' AND IsActive = true LIMIT 1`,
      );
      customerRecordTypeId = row?.Id || null;
    }
    return customerRecordTypeId || undefined;
  }

  async function caseRecordTypeId(serviceType) {
    if (!recordTypes) {
      const rows = await salesforce.query("SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = 'Case' AND IsActive = true");
      recordTypes = Object.fromEntries(rows.map((r) => [r.DeveloperName, r.Id]));
    }
    return recordTypes[RECORD_TYPE_BY_SERVICE_TYPE[serviceType]] || null;
  }

  async function findContactByPhone(phone) {
    const digits = lastTenDigits(phone);
    if (!digits) return null;
    const results = await salesforce.search(
      `FIND {${escapeSosl(digits)}} IN PHONE FIELDS RETURNING Contact(${CONTACT_FIELDS} ORDER BY CreatedDate) LIMIT 5`,
    );
    const match = results.find((r) => [r.MobilePhone, r.Phone].some((p) => lastTenDigits(p) === digits));
    if (match) return toContact(match);
    // Search indexing lags behind new records, so a contact created moments ago in this call is matched exactly.
    const forms = [`+91${digits}`, digits].map((f) => `'${f}'`).join(', ');
    const rows = await salesforce.query(
      `SELECT ${CONTACT_FIELDS} FROM Contact WHERE MobilePhone IN (${forms}) OR Phone IN (${forms}) ORDER BY CreatedDate LIMIT 1`,
    );
    return toContact(rows[0] || null);
  }

  async function getContactById(contactId) {
    const rows = await salesforce.query(`SELECT ${CONTACT_FIELDS} FROM Contact WHERE Id = '${escapeSoql(contactId)}' LIMIT 1`);
    return toContact(rows[0]);
  }

  async function getAccountContact(accountId) {
    const rows = await salesforce.query(
      `SELECT ${CONTACT_FIELDS} FROM Contact WHERE AccountId = '${escapeSoql(accountId)}' AND (MobilePhone != null OR Phone != null) ORDER BY CreatedDate LIMIT 1`,
    );
    return toContact(rows[0]);
  }

  async function getOrderItems(orderId) {
    const rows = await salesforce.query(
      `SELECT Product2Id, Product2.Name, Product2.ProductCode, Quantity FROM OrderItem WHERE OrderId = '${escapeSoql(orderId)}'`,
    );
    return rows.map((r) => ({ productId: r.Product2Id, productName: r.Product2?.Name, productCode: r.Product2?.ProductCode, quantity: r.Quantity }));
  }

  async function queryOrder(where) {
    const rows = await salesforce.query(`SELECT ${ORDER_FIELDS} FROM Order WHERE ${where} LIMIT 1`);
    if (!rows[0]) return null;
    return toOrder(rows[0], await getOrderItems(rows[0].Id));
  }

  const getOrderById = (orderId) => queryOrder(`Id = '${escapeSoql(orderId)}'`);
  const getOrderByErpId = (erpOrderId) => queryOrder(`ERP_Order_Id__c = '${escapeSoql(String(erpOrderId).trim())}'`);
  const getOrderByInvoice = (invoiceNumber) => queryOrder(`Invoice_Number__c IN (${idForms(invoiceNumber)})`);

  // Every order an invoice number names (the org has duplicates); line items are not loaded. The exact number
  // first ("INV-009", "inv 009"); else the invoices ending in the number the caller said ("009" or "9" for INV-009).
  async function findOrdersByInvoice(invoiceNumber) {
    const ref = joinDigits(invoiceNumber);
    if (!ref) return [];
    const exact = await salesforce.query(
      `SELECT ${ORDER_FIELDS} FROM Order WHERE Invoice_Number__c IN (${idForms(ref)}) ORDER BY CreatedDate DESC LIMIT 5`,
    );
    if (exact.length) return exact.map((r) => toOrder(r));
    const number = trailingNumber(ref);
    if (!number) return [];
    const rows = await salesforce.query(
      `SELECT ${ORDER_FIELDS} FROM Order WHERE Invoice_Number__c LIKE '%${number}%' ORDER BY CreatedDate DESC LIMIT 50`,
    );
    return rows.filter((r) => sameReference(ref, r.Invoice_Number__c)).slice(0, 5).map((r) => toOrder(r));
  }

  async function findRecentOrdersForAccount(accountId, limit = 5) {
    const rows = await salesforce.query(
      `SELECT ${ORDER_FIELDS} FROM Order WHERE AccountId = '${escapeSoql(accountId)}' ORDER BY EffectiveDate DESC NULLS LAST LIMIT ${limit}`,
    );
    return rows.map((r) => toOrder(r));
  }

  // Customer to call about an order: the authorising contact, else the account's first contact with a number.
  async function getOrderContact(order) {
    const contact = order.contactId ? await getContactById(order.contactId) : null;
    if (contact && (contact.mobile || contact.phone)) return contact;
    return order.accountId ? getAccountContact(order.accountId) : contact;
  }

  async function accountContacts(accountId) {
    const rows = await salesforce.query(
      `SELECT ${CONTACT_FIELDS} FROM Contact WHERE AccountId = '${escapeSoql(accountId)}' ORDER BY CreatedDate LIMIT 20`,
    );
    return rows.map(toContact);
  }

  // An order is shown only to someone who also has its invoice number or a mobile on the order's account.
  // Unknown and unverified orders give the same answer, so order ids cannot be probed.
  // A caller without the mobile or invoice can give the full name on the order instead (first and last name).
  // `verification` is one factor or a list (invoice numbers and mobiles); any one of them is enough.
  // Every order a caller may mean by a reference, the surest kind first. The exact ERP id ("TD-ORD-1009",
  // "td ord 1009"; "ORD-010" is an ERP id, not order number 10); else every order whose Salesforce order number is
  // the number said ("120", "ORD-00000120") or whose ERP id ends in it ("1009" or "ORD 1009" for TD-ORD-1009,
  // "9" for ORD-009). More than one means the caller has to say more. No ownership check; line items are not loaded.
  async function findOrdersByReference(reference) {
    const ref = joinDigits(reference);
    if (!ref) return [];
    const exact = await salesforce.query(`SELECT ${ORDER_FIELDS} FROM Order WHERE ERP_Order_Id__c IN (${idForms(ref)}) LIMIT 2`);
    if (exact.length) return exact.map((r) => toOrder(r));
    const number = trailingNumber(ref);
    if (!number) return [];
    const orderNumber = orderNumberOf(ref);
    const rows = await salesforce.query(
      `SELECT ${ORDER_FIELDS} FROM Order WHERE ${orderNumber ? `OrderNumber = '${orderNumber}' OR ` : ''}`
      + `ERP_Order_Id__c LIKE '%${number}%' ORDER BY CreatedDate DESC LIMIT 50`,
    );
    return rows
      .filter((r) => (orderNumber && r.OrderNumber === orderNumber) || (r.ERP_Order_Id__c && sameReference(ref, r.ERP_Order_Id__c)))
      .map((r) => toOrder(r));
  }

  // The one order a reference names, or null when none or several do.
  async function findOrderByReference(reference) {
    const matches = await findOrdersByReference(reference);
    return matches.length === 1 ? matches[0] : null;
  }

  async function verifyOrder(erpOrderId, verification, { customerName } = {}) {
    const factors = [].concat(verification).map((f) => String(f ?? '').trim()).filter(Boolean);
    if (!erpOrderId || (!factors.length && !customerName)) return { found: false };
    const order = await findOrderByReference(erpOrderId);
    if (!order) return { found: false };

    const byInvoice = Boolean(order.invoiceNumber) && factors.some((f) => sameReference(f, order.invoiceNumber));
    const contacts = order.accountId ? await accountContacts(order.accountId) : [];
    const mobiles = factors.map(lastTenDigits).filter(Boolean);
    const matched = contacts.find((c) => [c.mobile, c.phone].some((p) => p && mobiles.includes(lastTenDigits(p))));
    const named = !byInvoice && !matched && customerName
      ? contacts.find((c) => namesMatch(customerName, c.name)) || (namesMatch(customerName, order.accountName) ? contacts[0] || {} : null)
      : null;
    if (!byInvoice && !matched && !named) return { found: false };

    return {
      found: true,
      customerName: order.accountName,
      orderSource: order.orderSource,
      deliveryStatus: order.deliveryStatus,
      deliveryDate: order.deliveryDate,
      order,
      contactId: (matched || named || contacts[0])?.id || null,
      verifiedBy: byInvoice ? 'invoice' : matched ? 'phone' : 'name',
    };
  }

  // Finds the caller by full name and a PIN code on their record (address or an order's delivery PIN) when they do
  // not know the registered mobile. Only one customer may match; otherwise nothing is returned.
  async function findCustomerByNameAndPin(customerName, postalCode) {
    const pin = String(postalCode || '').replace(/\D/g, '');
    const words = nameWords(customerName);
    if (words.length < 2 || !/^[1-9]\d{5}$/.test(pin)) return { status: 'invalid' };

    const terms = words.map((w) => escapeSosl(w)).join(' OR ');
    const rows = await salesforce.search(
      `FIND {${terms}} IN NAME FIELDS RETURNING Contact(${CONTACT_FIELDS}, Account.Name, Account.BillingPostalCode, Account.ShippingPostalCode) LIMIT 50`,
    );
    const named = rows.filter((r) => namesMatch(customerName, [r.FirstName, r.LastName].filter(Boolean).join(' ')));
    if (!named.length) return { status: 'none' };

    const digitsOf = (value) => String(value || '').replace(/\D/g, '');
    let matches = named.filter((r) => [r.MailingPostalCode, r.Account?.BillingPostalCode, r.Account?.ShippingPostalCode].some((p) => digitsOf(p) === pin));
    if (!matches.length) {
      const accountIds = [...new Set(named.map((r) => r.AccountId).filter(Boolean))];
      const delivered = accountIds.length
        ? await salesforce.query(
          `SELECT AccountId FROM Order WHERE AccountId IN (${accountIds.map((id) => `'${escapeSoql(id)}'`).join(', ')}) AND ShippingPostalCode = '${pin}' LIMIT 50`,
        )
        : [];
      const shippedTo = new Set(delivered.map((o) => o.AccountId));
      matches = named.filter((r) => shippedTo.has(r.AccountId));
    }
    const accounts = new Set(matches.map((r) => r.AccountId || r.Id));
    if (accounts.size !== 1) return { status: matches.length ? 'ambiguous' : 'none' };
    return { status: 'found', contact: toContact(matches[0]) };
  }

  async function createCustomer(phone, customerName, accountFields = {}, contactFields = {}) {
    const fullName = String(customerName || '').trim() || 'Unknown Customer';
    const words = fullName.split(/\s+/);
    const account = await salesforce.create('Account', compact({ Name: fullName, RecordTypeId: await accountRecordTypeId(), ...accountFields }));
    const contact = await salesforce.create('Contact', compact({
      AccountId: account.id,
      FirstName: words.length > 1 ? words[0] : undefined,
      LastName: words.length > 1 ? words.slice(1).join(' ') : words[0],
      MobilePhone: phone,
      ...contactFields,
    }));
    return { id: contact.id, accountId: account.id, name: fullName, created: true };
  }

  async function resolveOrCreateContact(phone, customerName, accountFields = {}) {
    const existing = await findContactByPhone(phone);
    if (existing) return { ...existing, created: false };
    return createCustomer(phone, customerName, accountFields);
  }

  async function accountAddress(accountId) {
    if (!accountId) return {};
    const [account] = await salesforce.query(
      `SELECT BillingStreet, BillingCity, BillingState, BillingPostalCode FROM Account WHERE Id = '${escapeSoql(accountId)}' LIMIT 1`,
    );
    return { street: account?.BillingStreet, city: account?.BillingCity, state: account?.BillingState, postalCode: account?.BillingPostalCode };
  }

  async function serviceLocation(input, order) {
    if (input.city || input.postalCode) return { city: input.city, state: input.state, postalCode: input.postalCode };
    if (!order) return {};
    if (order.city || order.postalCode) return { city: order.city, state: order.state, postalCode: order.postalCode };
    const { city, state, postalCode } = await accountAddress(order.accountId);
    return { city, state, postalCode };
  }

  // What Salesforce holds for an order (its customer's mobile and the delivery address) or for a customer (mobile and
  // mailing address), with the account's billing address when the record has none. The agent confirms these with the
  // caller instead of asking again; it hears only the last digits of the mobile, the city and the PIN code.
  async function getDetailsOnFile({ order, contact }) {
    const person = order ? await getOrderContact(order) : contact;
    const accountId = order?.accountId || person?.accountId || null;
    let address = order
      ? { street: order.street, city: order.city, state: order.state, postalCode: order.postalCode }
      : { street: person?.street, city: person?.city, state: person?.state, postalCode: person?.postalCode };
    if (!address.city && !address.postalCode) address = await accountAddress(accountId);
    return {
      contactId: person?.id || null,
      accountId,
      name: person?.name || order?.accountName || null,
      mobile: normalizePhone(person?.mobile) || normalizePhone(person?.phone) || null,
      street: address.street || null,
      city: address.city || null,
      state: address.state || null,
      postalCode: address.postalCode || null,
    };
  }

  async function componentId(partNumber) {
    if (!partNumber) return null;
    const [row] = await salesforce.query(
      `SELECT Id FROM Product_Component__c WHERE Part_Number__c = '${escapeSoql(String(partNumber).trim())}' LIMIT 1`,
    );
    return row?.Id || null;
  }

  // Active products with a list price in the standard price book, limited to Tiffany's own product codes.
  async function catalog() {
    if (catalogCache && now() - catalogCache.loadedAt < CATALOG_TTL_MS) return catalogCache.entries;
    const prefix = productCodePrefix ? ` AND Product2.ProductCode LIKE '${escapeSoqlLike(productCodePrefix)}%'` : '';
    const rows = await salesforce.query(
      'SELECT Id, UnitPrice, Pricebook2Id, Product2Id, Product2.Name, Product2.ProductCode FROM PricebookEntry '
      + `WHERE Pricebook2.IsStandard = true AND IsActive = true AND Product2.IsActive = true${prefix} ORDER BY Product2.Name`,
    );
    const entries = rows.map((r) => ({
      pricebookEntryId: r.Id,
      pricebookId: r.Pricebook2Id,
      productId: r.Product2Id,
      name: r.Product2?.Name,
      productCode: r.Product2?.ProductCode,
      unitPrice: r.UnitPrice,
    }));
    catalogCache = { loadedAt: now(), entries };
    return entries;
  }

  async function findProducts(query) {
    const entries = await catalog();
    const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
      .filter((w) => !GENERIC_WORDS.has(w));
    if (!words.length) return entries;
    const text = (e) => `${e.name} ${e.productCode}`.toLowerCase();
    const everyWord = entries.filter((e) => words.every((w) => text(e).includes(w)));
    return everyWord.length ? everyWord : entries.filter((e) => words.some((w) => text(e).includes(w)));
  }

  // Salesforce's state picklist for India, label or code to code; an unknown state is left out of the address.
  async function indianStateCode(name) {
    if (!name) return undefined;
    if (!indianStates) {
      indianStates = new Map();
      for (const state of indianStatesOf(await salesforce.describe('Order'))) {
        indianStates.set(state.label.toLowerCase(), state.value);
        indianStates.set(state.value.toLowerCase(), state.value);
      }
    }
    const key = String(name).trim().toLowerCase();
    return indianStates.get(STATE_ALIASES[key] || key);
  }

  // A phone order is saved as a Draft for the sales team to confirm price, delivery and payment before activating it.
  async function createOrder(input) {
    if (!input.phone) return { created: false, error: 'A valid mobile number is needed to place the order.' };
    const parsed = parseItems(input.items);
    if (parsed.error) return { created: false, error: parsed.error };
    if (!parsed.items.length) return { created: false, error: 'No product was given. Ask which product and how many.' };
    if (parsed.items.length > MAX_ORDER_LINES) {
      return { created: false, error: `Up to ${MAX_ORDER_LINES} different products can be ordered by phone. Offer a call back from the sales team for larger orders.` };
    }

    const entries = await catalog();
    const lines = [];
    for (const item of parsed.items) {
      const entry = entries.find((e) => String(e.productCode).toUpperCase() === item.productCode);
      if (!entry) return { created: false, error: `Product code ${item.productCode} is not in the catalog. Check the product with find_products.` };
      if (item.quantity < 1 || item.quantity > MAX_LINE_QUANTITY) {
        return { created: false, error: `Quantities from 1 to ${MAX_LINE_QUANTITY} can be ordered by phone. Offer a call back from the sales team for larger quantities.` };
      }
      lines.push({ ...entry, quantity: item.quantity });
    }

    const pin = String(input.postalCode || '').replace(/\D/g, '');
    if (!String(input.address || '').trim() || !String(input.city || '').trim()) {
      return { created: false, error: 'The delivery address and city are needed.' };
    }
    if (!/^[1-9]\d{5}$/.test(pin)) return { created: false, error: 'A valid six digit PIN code is needed for delivery.' };

    const stateCode = await indianStateCode(input.state).catch(() => undefined);
    const address = compact({
      Street: String(input.address).trim(),
      City: String(input.city).trim(),
      PostalCode: pin,
      CountryCode: 'IN',
      StateCode: stateCode,
    });
    const prefixed = (prefix) => Object.fromEntries(Object.entries(address).map(([k, v]) => [`${prefix}${k}`, v]));
    const customer = await resolveOrCreateContact(input.phone, input.customerName, prefixed('Billing'));
    const givenName = String(input.customerName || '').trim();

    const order = await salesforce.create('Order', compact({
      AccountId: customer.accountId,
      CustomerAuthorizedById: customer.id,
      EffectiveDate: todayInIst(now()).toISOString().slice(0, 10),
      Status: 'Draft',
      Pricebook2Id: lines[0].pricebookId,
      Order_Source__c: 'Other',
      Description: [
        'Placed by phone through the AI voice agent.',
        'Confirm the final price, delivery charges, delivery date and payment with the customer before activating.',
        !customer.created && givenName && givenName.toLowerCase() !== String(customer.name || '').toLowerCase()
          ? `The caller gave the name ${givenName}; the mobile belongs to ${customer.name}.`
          : null,
        input.notes ? `Customer notes: ${input.notes}` : null,
      ].filter(Boolean).join('\n'),
      ...prefixed('Shipping'),
    }));

    try {
      await salesforce.createMany('OrderItem', lines.map((l) => ({
        OrderId: order.id,
        PricebookEntryId: l.pricebookEntryId,
        Quantity: l.quantity,
        UnitPrice: l.unitPrice,
      })));
    } catch (err) {
      await salesforce.remove('Order', order.id).catch(() => {});
      throw err;
    }

    const [saved] = await salesforce.query(`SELECT OrderNumber, TotalAmount FROM Order WHERE Id = '${escapeSoql(order.id)}'`);
    return {
      created: true,
      orderId: order.id,
      orderNumber: saved?.OrderNumber || null,
      total: saved?.TotalAmount ?? lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
      lines: lines.map(({ name, productCode, quantity, unitPrice }) => ({ name, productCode, quantity, unitPrice })),
      newCustomer: customer.created,
    };
  }

  // The order placed during a call: by the number the agent noted, else the caller's newest order. Only orders
  // created since the call began qualify, so a misheard number cannot link someone else's older order.
  async function findVoiceOrderSince({ orderNumber, contactId, since }) {
    if (!since || Number.isNaN(Date.parse(since))) return null;
    const newest = async (where) => {
      const [row] = await salesforce.query(
        `SELECT Id, OrderNumber FROM Order WHERE ${where} AND CreatedDate >= ${soqlDateTime(since)} ORDER BY CreatedDate DESC LIMIT 1`,
      );
      return row ? { id: row.Id, orderNumber: row.OrderNumber } : null;
    };
    const digits = String(orderNumber || '').replace(/\D/g, '');
    const byNumber = digits && digits.length <= 8 ? await newest(`OrderNumber = '${digits.padStart(8, '0')}'`) : null;
    if (byNumber || !contactId) return byNumber;
    return newest(`CustomerAuthorizedById = '${escapeSoql(contactId)}'`);
  }

  // Parts of the products on an order, or of products whose name matches.
  async function findParts({ erpOrderId, productName }) {
    let where;
    if (erpOrderId) {
      const found = await findOrderByReference(erpOrderId);
      const order = found ? await getOrderById(found.id) : null;
      const productIds = (order?.items || []).map((i) => i.productId).filter(Boolean);
      if (!productIds.length) return [];
      where = `Product__c IN (${productIds.map((id) => `'${escapeSoql(id)}'`).join(', ')})`;
    } else if (productName && String(productName).trim()) {
      where = `Product__r.Name LIKE '%${escapeSoqlLike(String(productName).trim())}%'`;
    } else {
      return [];
    }
    const rows = await salesforce.query(
      `SELECT Name, Part_Number__c, Product__r.Name FROM Product_Component__c WHERE ${where} ORDER BY Product__r.Name, Name LIMIT 20`,
    );
    return rows.map((r) => ({
      name: String(r.Name || '').split(' - ').pop(),
      partNumber: r.Part_Number__c,
      productName: r.Product__r?.Name || null,
    }));
  }

  // Classifies the request, links order, contact and part, and saves the Case. Salesforce's
  // Case_Service_Routing flow then sets Service_Route__c and the owning queue from the city and PIN.
  async function createServiceCase(input) {
    const mapping = SERVICE_TYPES[input.issueType];
    if (!mapping) throw new Error(`Unknown issue type: ${input.issueType}`);
    if (!String(input.description || '').trim()) return { created: false, error: 'A description of the issue is required.' };

    const verified = input.erpOrderId
      ? await verifyOrder(input.erpOrderId, [input.verification, input.invoiceNumber, input.phone])
      : { found: false };
    // The order the caller named is linked even when their mobile is not on it; the caller stays the case contact.
    const order = verified.found ? verified.order : input.erpOrderId ? await findOrderByReference(input.erpOrderId) : null;

    // A reschedule changes the open installation request, so only new requests are compared.
    const kind = input.issueType === 'installation_reschedule' ? null : requestKind(mapping.serviceType, mapping.subType);
    if (order && kind && !input.newRequest) {
      const existing = (await getOpenRequests(order.id)).find((r) => r.kind === kind);
      if (existing) {
        return { created: false, existingRequest: existing, error: `Request ${existing.caseNumber} of this kind is already open for the order.` };
      }
    }

    // When the caller agreed to use the details on file (for the order, or for the caller's own number), they are used;
    // a number or address the caller gives instead replaces them for this request only.
    let onFile = null;
    if (input.useDetailsOnFile) {
      if (order) onFile = await getDetailsOnFile({ order });
      else if (input.phone) {
        const known = await findContactByPhone(input.phone);
        if (known) onFile = await getDetailsOnFile({ contact: known });
      }
    }
    const mobile = input.phone || onFile?.mobile || null;
    if (!order && !mobile) {
      return { created: false, error: 'A mobile number is needed to register the request.' };
    }
    if (onFile && !mobile) {
      return { created: false, error: 'No mobile number is on file for this order. Ask the customer for a mobile number to reach them on.' };
    }

    // The caller chose the address the order was delivered to, or the customer's address on file when the order has
    // none; any address given with it is ignored.
    let delivery = null;
    if (input.atDeliveryAddress) {
      if (!order) return { created: false, error: 'The order is needed to use its delivery address. Ask for the order id, order number or invoice number.' };
      delivery = onFile || await getDetailsOnFile({ order });
      if (!delivery.city && !delivery.postalCode) {
        return { created: false, error: 'No delivery address is on record for this order. Ask for the house, street and area, the city and the six digit PIN code.' };
      }
    }
    const addressSource = !delivery ? null : order.city || order.postalCode ? 'delivery' : 'customer';

    const givenPlace = !delivery && Boolean(input.city || input.postalCode);
    const fromFile = delivery || (!givenPlace && (onFile?.city || onFile?.postalCode) ? onFile : null);
    const location = fromFile
      ? { city: fromFile.city, state: fromFile.state, postalCode: fromFile.postalCode }
      : await serviceLocation(input, order);
    if (onFile && !ADDRESS_FREE_ISSUES.has(input.issueType) && !location.city && !location.postalCode) {
      return { created: false, error: 'No address is on file for this order. Ask for the house, street and area, the city and the six digit PIN code.' };
    }
    // A new city or PIN code means a new address, so the street on file no longer applies.
    const street = delivery ? delivery.street : input.address || (onFile && !givenPlace ? onFile.street : null);

    let customer;
    if (verified.found) customer = { id: verified.contactId, accountId: order.accountId };
    // The order's own customer; a different number given for this request does not make a new customer.
    else if (onFile && (order || onFile.contactId)) customer = { id: onFile.contactId, accountId: onFile.accountId || order?.accountId };
    else if (input.phone) customer = await resolveOrCreateContact(input.phone, input.customerName);
    else customer = { id: (await getOrderContact(order))?.id || null, accountId: order.accountId };

    const changed = [
      onFile && input.phone && onFile.mobile && lastTenDigits(input.phone) !== lastTenDigits(onFile.mobile) && 'mobile number',
      onFile && !delivery && (givenPlace || input.address) && 'address',
    ].filter(Boolean);
    const detailsNote = !onFile ? null : changed.length
      ? `The customer gave a new ${changed.join(' and ')} for this request; the details on file are unchanged.`
      : 'The customer confirmed the mobile number and address on file.';
    const placeNote = addressSource === 'delivery' ? 'The customer chose the delivery address of the order.'
      : addressSource === 'customer' ? 'The customer chose their address on file; the order has no delivery address.' : null;
    const withinBusinessHours = await businessHours.isOpen(new Date(now())).catch(() => true);

    const description = [
      withinBusinessHours ? null : '[Received outside business hours]',
      input.issueType === 'return' ? 'Customer requests a return.' : null,
      input.issueType === 'escalation' ? 'Customer asked for a service team member to call back.' : null,
      input.description,
      input.partName && `Part / component: ${input.partName}`,
      input.partNumber && `Part number: ${input.partNumber}`,
      input.quantity && `Quantity: ${input.quantity}`,
      input.productName && `Product: ${input.productName}`,
      input.erpOrderId && `Order id given: ${input.erpOrderId}`,
      street && `Address: ${street}`,
      (input.preferredDate || input.preferredTime) && `Preferred slot: ${[input.preferredDate, input.preferredTime].filter(Boolean).join(' ')}`,
      placeNote,
      detailsNote,
      input.capturedBy || 'Captured by the AI voice agent.',
    ].filter(Boolean).join('\n');

    const fields = compact({
      RecordTypeId: await caseRecordTypeId(mapping.serviceType),
      Subject: `${mapping.serviceType}${order?.erpOrderId ? ` - ${order.erpOrderId}` : ''}`,
      Description: description,
      Origin: input.origin || 'Phone',
      Status: input.issueType === 'escalation' ? 'Escalated' : undefined,
      ContactId: customer.id,
      AccountId: customer.id ? undefined : customer.accountId,
      Service_Type__c: mapping.serviceType,
      Service_Sub_Type__c: mapping.subType,
      Order__c: order?.id,
      Invoice_Number__c: order ? order.invoiceNumber : input.invoiceNumber,
      Order_Source__c: order ? order.orderSource : input.orderSource,
      Customer_Mobile__c: mobile,
      Damaged_Component__c: await componentId(input.partNumber),
      Service_City__c: location.city,
      Service_State__c: location.state,
      Service_PIN__c: location.postalCode,
    });

    const created = await salesforce.create('Case', fields);
    const [saved] = await salesforce.query(`SELECT CaseNumber, Service_Route__c FROM Case WHERE Id = '${escapeSoql(created.id)}'`);
    return {
      created: true,
      caseId: created.id,
      caseNumber: saved?.CaseNumber || null,
      serviceRoute: saved?.Service_Route__c || null,
      withinBusinessHours,
      orderVerified: verified.found,
      orderLinked: Boolean(order),
      ...(onFile ? { usedDetailsOnFile: true } : {}),
      ...(addressSource ? { addressSource } : {}),
    };
  }

  function caseWhere({ caseId, caseNumber }) {
    if (caseId) return `Id = '${escapeSoql(caseId)}'`;
    if (caseNumber) return `CaseNumber = '${escapeSoql(String(caseNumber).replace(/\D/g, '').padStart(8, '0'))}'`;
    return null;
  }

  async function getCaseStatus({ caseNumber, accountId }) {
    let where = caseWhere({ caseNumber });
    if (!where && accountId) where = `AccountId = '${escapeSoql(accountId)}' AND IsClosed = false`;
    if (!where) return [];
    const rows = await salesforce.query(
      `SELECT Id, CaseNumber, Service_Type__c, Service_Sub_Type__c, Status, CreatedDate, AccountId, Account.Name, Contact.Name, Order__r.ERP_Order_Id__c, `
      + `${VISIT_SUBQUERY}, ${SHIPMENT_SUBQUERY} FROM Case WHERE ${where} ORDER BY CreatedDate DESC LIMIT 3`,
    );
    return rows.map((r) => ({
      id: r.Id,
      caseNumber: r.CaseNumber,
      accountId: r.AccountId,
      accountName: r.Account?.Name || null,
      contactName: r.Contact?.Name || null,
      serviceType: r.Service_Type__c,
      subType: r.Service_Sub_Type__c,
      status: r.Status,
      createdDate: r.CreatedDate,
      erpOrderId: r.Order__r?.ERP_Order_Id__c || null,
      visit: toVisit(r.Service_Visits__r?.records?.[0]),
      shipment: toShipment(r.Replacement_Shipments__r?.records?.[0]),
    }));
  }

  // The order's open installation, damage and replacement requests, newest first.
  async function getOpenRequests(orderId) {
    if (!orderId) return [];
    const rows = await salesforce.query(
      'SELECT Id, CaseNumber, Service_Type__c, Service_Sub_Type__c, Status, CreatedDate FROM Case '
      + `WHERE Order__c = '${escapeSoql(orderId)}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 20`,
    );
    return rows
      .map((r) => ({
        id: r.Id,
        caseNumber: r.CaseNumber,
        serviceType: r.Service_Type__c,
        subType: r.Service_Sub_Type__c,
        status: r.Status,
        createdDate: r.CreatedDate,
        kind: requestKind(r.Service_Type__c, r.Service_Sub_Type__c),
      }))
      .filter((r) => r.kind);
  }

  // The language a caller chose on a voice call, saved on their contact so staff (and later calls) know it.
  async function savePreferredLanguage(contactId, language) {
    const name = AGENT_LANGUAGES.find((l) => l.toLowerCase() === String(language || '').trim().toLowerCase());
    if (!contactId || !name) return { saved: false };
    const [row] = await salesforce.query(`SELECT Languages__c FROM Contact WHERE Id = '${escapeSoql(contactId)}' LIMIT 1`);
    if (!row) return { saved: false };
    if (row.Languages__c === name) return { saved: false, language: name };
    await salesforce.update('Contact', contactId, { Languages__c: name });
    return { saved: true, language: name };
  }

  // Everything a notification call needs: who to call and what changed.
  async function getCaseNotice(ref) {
    const where = caseWhere(ref);
    if (!where) return null;
    const rows = await salesforce.query(
      'SELECT Id, CaseNumber, Service_Type__c, Status, Customer_Mobile__c, ContactId, Contact.FirstName, Contact.LastName, '
      + `Contact.MobilePhone, Contact.Phone, Order__r.ERP_Order_Id__c, ${VISIT_SUBQUERY}, ${SHIPMENT_SUBQUERY} FROM Case WHERE ${where} LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.Id,
      caseNumber: r.CaseNumber,
      serviceType: r.Service_Type__c,
      status: r.Status,
      phone: r.Customer_Mobile__c || r.Contact?.MobilePhone || r.Contact?.Phone || null,
      customerName: [r.Contact?.FirstName, r.Contact?.LastName].filter(Boolean).join(' ') || null,
      contactId: r.ContactId,
      erpOrderId: r.Order__r?.ERP_Order_Id__c || null,
      visit: toVisit(r.Service_Visits__r?.records?.[0]),
      shipment: toShipment(r.Replacement_Shipments__r?.records?.[0]),
    };
  }

  // The newest phone case for this mobile since a moment; used to avoid duplicating a case the agent already created.
  async function findVoiceCaseSince(phone, since) {
    if (!phone || !since || Number.isNaN(Date.parse(since))) return null;
    const rows = await salesforce.query(
      `SELECT Id, CaseNumber FROM Case WHERE Origin = 'Phone' AND Customer_Mobile__c = '${escapeSoql(phone)}' `
      + `AND CreatedDate >= ${soqlDateTime(since)} ORDER BY CreatedDate DESC LIMIT 1`,
    );
    return rows[0] ? { id: rows[0].Id, caseNumber: rows[0].CaseNumber } : null;
  }

  const getServiceHours = () => businessHours.getStatus();

  async function serviceRegions() {
    if (regionCache && now() - regionCache.loadedAt < CATALOG_TTL_MS) return regionCache.rows;
    const rows = await salesforce.query('SELECT Match_Type__c, Match_Value__c FROM Service_Region__mdt');
    regionCache = { loadedAt: now(), rows };
    return rows;
  }

  // Mirrors the Case_Service_Routing flow: a Delhi NCR city, or a PIN starting with a Delhi NCR prefix, goes to the
  // internal team; any other location goes to a service partner.
  async function checkServiceArea({ city, postalCode }) {
    const cityName = String(city || '').trim();
    const pin = String(postalCode || '').replace(/\D/g, '');
    if (String(postalCode || '').trim() && !/^[1-9]\d{5}$/.test(pin)) return { valid: false, reason: 'pin' };
    if (!cityName && !pin) return { valid: false, reason: 'missing' };
    const regions = await serviceRegions();
    const listed = (type, value) => regions.some((r) => r.Match_Type__c === type && String(r.Match_Value__c || '').toLowerCase() === value.toLowerCase());
    const inNcr = Boolean((cityName && listed('City', cityName)) || (pin && listed('PIN Prefix', pin.slice(0, 3))));
    return { valid: true, route: inNcr ? 'Internal' : 'External Provider', city: cityName || null, postalCode: pin || null };
  }

  // A new caller gets an account and contact. A caller cannot prove they own a number, so an existing record is never
  // changed: the details go to the service team as a task to check with the customer.
  async function saveCustomerDetails(input) {
    if (!input.phone) return { saved: false, error: 'A valid mobile number is needed.' };
    const name = String(input.customerName || '').trim();
    const email = String(input.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { saved: false, error: 'The email address does not look complete. Ask the customer to spell it again.' };
    }
    const otherPhone = input.alternatePhone ? normalizePhone(input.alternatePhone) : null;
    if (input.alternatePhone && !otherPhone) return { saved: false, error: 'The other phone number is not valid. Ask for it again.' };
    const pin = String(input.postalCode || '').replace(/\D/g, '');
    if (String(input.postalCode || '').trim() && !/^[1-9]\d{5}$/.test(pin)) return { saved: false, error: 'A valid six digit PIN code is needed.' };
    const street = String(input.address || '').trim();
    const cityName = String(input.city || '').trim();

    const existing = await findContactByPhone(input.phone);
    if (!existing) {
      if (!name) return { saved: false, error: "The customer's name is needed to save a new customer." };
      const stateCode = await indianStateCode(input.state).catch(() => undefined);
      const address = compact({ Street: street, City: cityName, PostalCode: pin, StateCode: stateCode, CountryCode: street || cityName || pin ? 'IN' : undefined });
      const prefixed = (prefix) => Object.fromEntries(Object.entries(address).map(([k, v]) => [`${prefix}${k}`, v]));
      const customer = await createCustomer(input.phone, name, prefixed('Billing'), compact({ Email: email, OtherPhone: otherPhone, ...prefixed('Mailing') }));
      return { saved: true, newCustomer: true, name: customer.name, contactId: customer.id };
    }

    const details = [
      name && `Name: ${name}`,
      email && `Email: ${email}`,
      otherPhone && `Other phone: ${otherPhone}`,
      (street || cityName || input.state || pin) && `Address: ${[street, cityName, input.state, pin].filter(Boolean).join(', ')}`,
    ].filter(Boolean);
    if (!details.length) return { saved: false, error: 'No details were given to save. Ask what should be saved.' };
    await salesforce.create('Task', compact({
      WhoId: existing.id,
      Subject: 'Customer details to update',
      Description: ['The caller gave these details on a voice agent call. Confirm them with the customer before changing the record.', ...details].join('\n'),
      Status: 'Not Started',
      Priority: 'Normal',
      ActivityDate: todayInIst(now()).toISOString().slice(0, 10),
    }));
    return { saved: true, newCustomer: false, name: existing.name, contactId: existing.id };
  }

  // The customer's latest requests, open or closed, and the latest logged calls.
  async function getServiceHistory({ accountId, contactId }) {
    if (!accountId && !contactId) return { cases: [], calls: [] };
    const owner = accountId ? `AccountId = '${escapeSoql(accountId)}'` : null;
    const cases = await salesforce.query(
      'SELECT CaseNumber, Service_Type__c, Service_Sub_Type__c, Status, IsClosed, CreatedDate, ClosedDate FROM Case '
      + `WHERE ${owner || `ContactId = '${escapeSoql(contactId)}'`} ORDER BY CreatedDate DESC LIMIT 5`,
    );
    const calls = await salesforce.query(
      'SELECT CallType, CallDisposition, ActivityDate, CreatedDate FROM Task '
      + `WHERE TaskSubtype = 'Call' AND ${owner || `WhoId = '${escapeSoql(contactId)}'`} ORDER BY CreatedDate DESC LIMIT 3`,
    );
    return {
      cases: cases.map((r) => ({
        caseNumber: r.CaseNumber,
        serviceType: r.Service_Type__c,
        subType: r.Service_Sub_Type__c,
        status: r.Status,
        closed: r.IsClosed,
        createdDate: r.CreatedDate,
        closedDate: r.ClosedDate,
      })),
      calls: calls.map((r) => ({ direction: r.CallType, outcome: r.CallDisposition, date: r.ActivityDate || r.CreatedDate })),
    };
  }

  async function logCall(input) {
    const fields = Object.fromEntries(Object.entries({
      Subject: input.subject,
      Description: input.description,
      WhoId: input.contactId,
      WhatId: input.relatedId,
      Status: 'Completed',
      TaskSubtype: 'Call',
      ActivityDate: input.activityDate,
      CallType: input.direction === 'inbound' ? 'Inbound' : 'Outbound',
      CallDisposition: input.disposition ? String(input.disposition).slice(0, 255) : undefined,
      CallObject: input.callId,
      CallDurationInSeconds: input.durationSeconds != null ? Math.round(input.durationSeconds) : undefined,
    }).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const created = await salesforce.create('Task', fields);
    return { id: created.id };
  }

  return {
    findContactByPhone,
    getContactById,
    getOrderById,
    getOrderByErpId,
    getOrderByInvoice,
    findRecentOrdersForAccount,
    getOrderContact,
    verifyOrder,
    findOrderByReference,
    findOrdersByReference,
    findOrdersByInvoice,
    getDetailsOnFile,
    findCustomerByNameAndPin,
    findParts,
    findProducts,
    indianStateCode,
    createOrder,
    findVoiceOrderSince,
    createServiceCase,
    getCaseStatus,
    getOpenRequests,
    getCaseNotice,
    findVoiceCaseSince,
    getServiceHours,
    checkServiceArea,
    saveCustomerDetails,
    savePreferredLanguage,
    getServiceHistory,
    logCall,
  };
}

module.exports = {
  createCrm, SERVICE_TYPES, AGENT_LANGUAGES, requestKind, escapeSoql, escapeSoqlLike, escapeSosl, soqlDateTime, indianStatesOf,
};
