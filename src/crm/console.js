const { escapeSoql, escapeSoqlLike, indianStatesOf } = require('./crm');
const { todayInIst } = require('../dates');

// Views of Salesforce for the staff console (web/): lists with filters and one-record details, and order edits.
// Every value placed in SOQL is escaped, and filters and edits are checked against the org's picklist values.

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 2000;

// Product2 has no family set, so products are grouped by what their names say, like the shop's categories.
const CATEGORIES = [
  ['Shoe Storage', /shoe/i],
  ['Bookshelves', /book\s?(shelf|case)/i],
  ['TV Cabinets', /\btv\b/i],
  ['Wardrobes', /wardrobe/i],
  ['Study Tables', /study table|desk/i],
  ['Chairs', /chair/i],
  ['Beds', /\bbed\b/i],
  ['Storage Cabinets', /storage|cabinet/i],
];

const ORDER_STATUSES = ['Draft', 'Activated'];
const DELIVERY_STATUSES = ['Processing', 'Shipped', 'Delivered', 'Returned'];
const ORDER_SOURCES = ['Amazon', 'Flipkart', 'FirstCry', 'Website', 'Showroom', 'Other'];
const CASE_STATUSES = ['New', 'Working', 'Escalated', 'Closed', 'AI Information Collection', 'Agent Review', 'Information Required', 'Assigned'];
const SERVICE_TYPES = ['Installation', 'Damage or Defect', 'Replacement', 'General Query'];
const CASE_ORIGINS = ['Phone', 'Email', 'Web'];
const ACTIVITY_KINDS = { call: "TaskSubtype = 'Call'", email: "TaskSubtype = 'Email'", todo: "TaskSubtype != 'Call' AND TaskSubtype != 'Email' AND IsClosed = false" };

const ORDER_LIST_FIELDS = 'Id, OrderNumber, ERP_Order_Id__c, Invoice_Number__c, Status, Delivery_Status__c, Order_Source__c, EffectiveDate, '
  + 'Delivery_Date__c, TotalAmount, CreatedDate, AccountId, Account.Name, CustomerAuthorizedById, CustomerAuthorizedBy.Name, ShippingCity, '
  + 'ShippingPostalCode, (SELECT Quantity, Product2.Name FROM OrderItems)';

const CASE_LIST_FIELDS = 'Id, CaseNumber, Subject, Status, Priority, Origin, IsClosed, Service_Type__c, Service_Sub_Type__c, Service_Route__c, '
  + 'Service_City__c, Service_PIN__c, ContactId, Contact.Name, AccountId, Account.Name, Order__c, Order__r.ERP_Order_Id__c, Order__r.OrderNumber, '
  + 'CreatedDate, ClosedDate';

const ACTIVITY_FIELDS = 'Id, Subject, TaskSubtype, Status, Priority, IsClosed, ActivityDate, CreatedDate, WhoId, Who.Name, WhatId, What.Name, '
  + 'What.Type, CallType, CallDisposition, CallDurationInSeconds, CallObject, Description';

const VISIT_FIELDS = 'Id, Name, Status__c, Scheduled_Start__c, Remarks__c, Technician__r.Name, Case__c, Case__r.CaseNumber, Case__r.Service_City__c, '
  + 'Case__r.Contact.Name';

const SHIPMENT_FIELDS = 'Id, Name, Shipment_Status__c, Courier__c, Tracking_Number__c, Tracking_URL__c, Dispatch_Date__c, Expected_Delivery_Date__c, '
  + 'Actual_Delivery_Date__c, Quantity__c, Component__r.Name, Component__r.Part_Number__c, Case__c, Case__r.CaseNumber, Case__r.Contact.Name';

// What staff may change on an order from the console, and the label each change is recorded under.
const ORDER_EDITS = {
  status: ['Status', 'Status'],
  deliveryStatus: ['Delivery_Status__c', 'Delivery status'],
  deliveryDate: ['Delivery_Date__c', 'Delivered on'],
  erpOrderId: ['ERP_Order_Id__c', 'Order id'],
  invoiceNumber: ['Invoice_Number__c', 'Invoice number'],
  source: ['Order_Source__c', 'Channel'],
  fulfilment: ['Fulfilment_Type__c', 'Fulfilment'],
  orderDate: ['EffectiveDate', 'Order date'],
  description: ['Description', 'Notes'],
  shippingStreet: ['ShippingStreet', 'Ship to street'],
  shippingCity: ['ShippingCity', 'Ship to city'],
  shippingState: ['ShippingStateCode', 'Ship to state'],
  shippingPostalCode: ['ShippingPostalCode', 'Ship to PIN code'],
};
const SCHEMA_TTL_MS = 60 * 60 * 1000;

// Salesforce answers a refused save with "Salesforce request failed (400): [{message, errorCode, fields}]".
// Returns the message and, when Salesforce names one, the edit field it is about.
function salesforceRefusal(err) {
  const match = /^Salesforce request failed \((4\d\d)\): (.*)$/s.exec(err?.message || '');
  if (!match) return null;
  let errors = [];
  try { errors = [].concat(JSON.parse(match[2]) || []); } catch { /* not JSON */ }
  // The order id is the only unique field that can be edited.
  if (errors.some((e) => e.errorCode === 'DUPLICATE_VALUE')) return { message: 'Another order already uses this order id.', field: 'erpOrderId' };
  const named = errors.flatMap((e) => e.fields || []);
  const field = Object.keys(ORDER_EDITS).find((key) => named.includes(ORDER_EDITS[key][0])) || null;
  return { message: errors.map((e) => e.message).filter(Boolean).join(' ') || `Salesforce refused the change (${match[1]}).`, field };
}

const isId = (value) => /^[a-zA-Z0-9]{15,18}$/.test(String(value || ''));
const quoted = (value) => `'${escapeSoql(value)}'`;
const like = (value) => `'%${escapeSoqlLike(String(value).trim())}%'`;
const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);

function categoryOf(name) {
  return (CATEGORIES.find(([, pattern]) => pattern.test(name || '')) || ['Other'])[0];
}

function paging({ page, pageSize } = {}) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || PAGE_SIZE));
  const number = Math.max(1, Number.parseInt(page, 10) || 1);
  return { page: number, pageSize: size, offset: Math.min(MAX_OFFSET, (number - 1) * size) };
}

// One row more than the page shows whether another page follows.
function pageOf(rows, { page, pageSize }) {
  return { records: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize };
}

const where = (conditions) => (conditions.filter(Boolean).length ? ` WHERE ${conditions.filter(Boolean).join(' AND ')}` : '');

function toOrderRow(r) {
  const items = r.OrderItems?.records || [];
  return {
    id: r.Id,
    orderNumber: r.OrderNumber,
    erpOrderId: r.ERP_Order_Id__c || null,
    invoiceNumber: r.Invoice_Number__c || null,
    status: r.Status,
    deliveryStatus: r.Delivery_Status__c || null,
    source: r.Order_Source__c || null,
    orderDate: r.EffectiveDate || null,
    deliveryDate: r.Delivery_Date__c || null,
    total: r.TotalAmount ?? null,
    createdDate: r.CreatedDate,
    accountId: r.AccountId || null,
    customerName: r.Account?.Name || r.CustomerAuthorizedBy?.Name || null,
    contactId: r.CustomerAuthorizedById || null,
    contactName: r.CustomerAuthorizedBy?.Name || null,
    city: r.ShippingCity || null,
    postalCode: r.ShippingPostalCode || null,
    itemCount: items.reduce((sum, i) => sum + (i.Quantity || 0), 0),
    products: items.map((i) => i.Product2?.Name).filter(Boolean),
  };
}

function toCaseRow(r) {
  return {
    id: r.Id,
    caseNumber: r.CaseNumber,
    subject: r.Subject || null,
    status: r.Status,
    priority: r.Priority || null,
    origin: r.Origin || null,
    closed: Boolean(r.IsClosed),
    serviceType: r.Service_Type__c || null,
    subType: r.Service_Sub_Type__c || null,
    route: r.Service_Route__c || null,
    city: r.Service_City__c || null,
    postalCode: r.Service_PIN__c || null,
    contactId: r.ContactId || null,
    contactName: r.Contact?.Name || null,
    accountId: r.AccountId || null,
    accountName: r.Account?.Name || null,
    orderId: r.Order__c || null,
    orderReference: r.Order__r?.ERP_Order_Id__c || r.Order__r?.OrderNumber || null,
    createdDate: r.CreatedDate,
    closedDate: r.ClosedDate || null,
  };
}

function toActivity(r) {
  return {
    id: r.Id,
    subject: r.Subject || null,
    kind: r.TaskSubtype === 'Call' ? 'call' : r.TaskSubtype === 'Email' ? 'email' : 'todo',
    status: r.Status,
    priority: r.Priority || null,
    closed: Boolean(r.IsClosed),
    date: r.ActivityDate || r.CreatedDate,
    createdDate: r.CreatedDate,
    whoId: r.WhoId || null,
    whoName: r.Who?.Name || null,
    whatId: r.WhatId || null,
    whatName: r.What?.Name || null,
    whatType: r.What?.Type || null,
    direction: r.CallType || null,
    outcome: r.CallDisposition || null,
    durationSeconds: r.CallDurationInSeconds ?? null,
    callId: r.CallObject || null,
    description: r.Description ? String(r.Description).slice(0, 2000) : null,
  };
}

function toVisit(r) {
  return {
    id: r.Id,
    name: r.Name,
    status: r.Status__c || null,
    scheduledStart: r.Scheduled_Start__c || null,
    remarks: r.Remarks__c || null,
    technician: r.Technician__r?.Name || null,
    caseId: r.Case__c || null,
    caseNumber: r.Case__r?.CaseNumber || null,
    city: r.Case__r?.Service_City__c || null,
    customerName: r.Case__r?.Contact?.Name || null,
  };
}

function toShipment(r) {
  return {
    id: r.Id,
    name: r.Name,
    status: r.Shipment_Status__c || null,
    courier: r.Courier__c || null,
    trackingNumber: r.Tracking_Number__c || null,
    trackingUrl: /^https?:\/\//i.test(r.Tracking_URL__c || '') ? r.Tracking_URL__c : null,
    dispatchDate: r.Dispatch_Date__c || null,
    expectedDate: r.Expected_Delivery_Date__c || null,
    deliveredDate: r.Actual_Delivery_Date__c || null,
    quantity: r.Quantity__c ?? null,
    component: r.Component__r?.Name || null,
    partNumber: r.Component__r?.Part_Number__c || null,
    caseId: r.Case__c || null,
    caseNumber: r.Case__r?.CaseNumber || null,
    customerName: r.Case__r?.Contact?.Name || null,
  };
}

function toContactRow(r) {
  return {
    id: r.Id,
    name: r.Name,
    accountId: r.AccountId || null,
    accountName: r.Account?.Name || null,
    mobile: r.MobilePhone || null,
    phone: r.Phone || null,
    email: r.Email || null,
    city: r.MailingCity || null,
    postalCode: r.MailingPostalCode || null,
    createdDate: r.CreatedDate,
  };
}

function createConsoleData({ salesforce, crm, scheduler, productCodePrefix = 'TD-', now = () => Date.now(), logger = console }) {
  let schemaCache = null;

  // The org's own rules for each editable Order field: type, length, whether it may be empty, allowed values.
  async function orderSchema() {
    if (schemaCache && now() - schemaCache.loadedAt < SCHEMA_TTL_MS) return schemaCache;
    const described = await salesforce.describe('Order');
    const fields = Object.fromEntries(Object.values(ORDER_EDITS).map(([name]) => {
      const f = described.fields.find((x) => x.name === name) || {};
      return [name, {
        type: f.type,
        length: f.length || 0,
        nillable: f.nillable !== false,
        updateable: f.updateable !== false,
        values: (f.picklistValues || []).filter((p) => p.active).map((p) => p.value),
      }];
    }));
    schemaCache = { loadedAt: now(), fields, states: indianStatesOf(described) };
    return schemaCache;
  }

  const count = async (soql) => {
    const [row] = await salesforce.query(soql);
    return Number(row?.n || 0);
  };
  const codeFilter = productCodePrefix ? `Product2.ProductCode LIKE '${escapeSoqlLike(productCodePrefix)}%'` : null;

  // Active catalog products with their standard list price, the shop's categories and how many parts they have.
  async function productRows(extra) {
    const [entries, parts] = await Promise.all([
      salesforce.query(
        'SELECT Id, UnitPrice, Product2Id, Product2.Name, Product2.ProductCode, Product2.Description, Product2.DisplayUrl, Product2.IsActive, '
        + `Product2.CreatedDate FROM PricebookEntry${where(['Pricebook2.IsStandard = true', 'IsActive = true', codeFilter, extra])} ORDER BY Product2.Name LIMIT 500`,
      ),
      salesforce.query('SELECT Product__c, COUNT(Id) n FROM Product_Component__c GROUP BY Product__c'),
    ]);
    const partCounts = new Map(parts.map((p) => [p.Product__c, Number(p.n || 0)]));
    return entries.map((e) => ({
      id: e.Product2Id,
      name: e.Product2?.Name,
      code: e.Product2?.ProductCode,
      description: e.Product2?.Description || null,
      imageUrl: /^https:\/\//i.test(e.Product2?.DisplayUrl || '') ? e.Product2.DisplayUrl : null,
      active: Boolean(e.Product2?.IsActive),
      price: e.UnitPrice ?? null,
      category: categoryOf(e.Product2?.Name),
      partCount: partCounts.get(e.Product2Id) || 0,
    }));
  }

  async function listProducts({ q, category } = {}) {
    const words = String(q || '').trim();
    let products = await productRows(words ? `(Product2.Name LIKE ${like(words)} OR Product2.ProductCode LIKE ${like(words)})` : null);
    const categories = [...new Set((words ? await productRows(null) : products).map((p) => p.category))].sort();
    if (category) products = products.filter((p) => p.category === category);
    return { products, categories };
  }

  async function getProduct(id) {
    if (!isId(id)) return null;
    const [product] = await productRows(`Product2Id = ${quoted(id)}`);
    if (!product) return null;
    const [parts, sold, recentLines] = await Promise.all([
      salesforce.query(`SELECT Id, Name, Part_Number__c FROM Product_Component__c WHERE Product__c = ${quoted(id)} ORDER BY Name LIMIT 100`),
      salesforce.query(`SELECT SUM(Quantity) n, COUNT(Id) lines FROM OrderItem WHERE Product2Id = ${quoted(id)}`),
      salesforce.query(
        'SELECT OrderId, Order.OrderNumber, Order.ERP_Order_Id__c, Order.Account.Name, Order.EffectiveDate, Order.Status, Quantity, TotalPrice '
        + `FROM OrderItem WHERE Product2Id = ${quoted(id)} ORDER BY Order.EffectiveDate DESC NULLS LAST LIMIT 10`,
      ),
    ]);
    return {
      ...product,
      parts: parts.map((p) => ({ id: p.Id, name: String(p.Name || '').split(' - ').pop(), partNumber: p.Part_Number__c || null })),
      unitsOrdered: Number(sold[0]?.n || 0),
      orderLines: Number(sold[0]?.lines || 0),
      recentOrders: recentLines.map((l) => ({
        orderId: l.OrderId,
        orderNumber: l.Order?.OrderNumber || null,
        erpOrderId: l.Order?.ERP_Order_Id__c || null,
        customerName: l.Order?.Account?.Name || null,
        orderDate: l.Order?.EffectiveDate || null,
        status: l.Order?.Status || null,
        quantity: l.Quantity,
        total: l.TotalPrice ?? null,
      })),
    };
  }

  async function listOrders(filters = {}) {
    const p = paging(filters);
    const q = String(filters.q || '').trim();
    const conditions = [
      oneOf(filters.status, ORDER_STATUSES) && `Status = ${quoted(filters.status)}`,
      oneOf(filters.delivery, DELIVERY_STATUSES) && `Delivery_Status__c = ${quoted(filters.delivery)}`,
      oneOf(filters.source, ORDER_SOURCES) && `Order_Source__c = ${quoted(filters.source)}`,
      q && `(OrderNumber LIKE ${like(q)} OR ERP_Order_Id__c LIKE ${like(q)} OR Invoice_Number__c LIKE ${like(q)} OR Account.Name LIKE ${like(q)})`,
    ];
    const rows = await salesforce.query(
      `SELECT ${ORDER_LIST_FIELDS} FROM Order${where(conditions)} ORDER BY CreatedDate DESC LIMIT ${p.pageSize + 1} OFFSET ${p.offset}`,
    );
    return { ...pageOf(rows.map(toOrderRow), p), filters: { statuses: ORDER_STATUSES, deliveryStatuses: DELIVERY_STATUSES, sources: ORDER_SOURCES } };
  }

  async function getOrder(id) {
    if (!isId(id)) return null;
    const [row] = await salesforce.query(
      `SELECT ${ORDER_LIST_FIELDS.replace(', (SELECT Quantity, Product2.Name FROM OrderItems)', '')}, Description, Fulfilment_Type__c, `
      + 'ShippingStreet, ShippingState, ShippingCountry, BillingStreet, BillingCity, BillingState, BillingPostalCode, '
      + 'CustomerAuthorizedBy.MobilePhone, CustomerAuthorizedBy.Phone, CustomerAuthorizedBy.Email '
      + `FROM Order WHERE Id = ${quoted(id)} LIMIT 1`,
    );
    if (!row) return null;
    const [items, cases, activities] = await Promise.all([
      salesforce.query(
        'SELECT Id, Product2Id, Product2.Name, Product2.ProductCode, Quantity, UnitPrice, TotalPrice, Description '
        + `FROM OrderItem WHERE OrderId = ${quoted(id)} ORDER BY CreatedDate`,
      ),
      salesforce.query(`SELECT ${CASE_LIST_FIELDS} FROM Case WHERE Order__c = ${quoted(id)} ORDER BY CreatedDate DESC LIMIT 20`),
      salesforce.query(`SELECT ${ACTIVITY_FIELDS} FROM Task WHERE WhatId = ${quoted(id)} ORDER BY CreatedDate DESC LIMIT 20`),
    ]);
    const address = (prefix) => [row[`${prefix}Street`], row[`${prefix}City`], row[`${prefix}State`], row[`${prefix}PostalCode`]].filter(Boolean).join(', ') || null;
    return {
      ...toOrderRow({ ...row, OrderItems: { records: items } }),
      description: row.Description || null,
      fulfilment: row.Fulfilment_Type__c || null,
      shippingAddress: address('Shipping'),
      billingAddress: address('Billing'),
      contact: row.CustomerAuthorizedById ? {
        id: row.CustomerAuthorizedById,
        name: row.CustomerAuthorizedBy?.Name || null,
        mobile: row.CustomerAuthorizedBy?.MobilePhone || null,
        phone: row.CustomerAuthorizedBy?.Phone || null,
        email: row.CustomerAuthorizedBy?.Email || null,
      } : null,
      items: items.map((i) => ({
        id: i.Id,
        productId: i.Product2Id,
        name: i.Product2?.Name || null,
        code: i.Product2?.ProductCode || null,
        quantity: i.Quantity,
        unitPrice: i.UnitPrice ?? null,
        total: i.TotalPrice ?? null,
        note: i.Description || null,
      })),
      cases: cases.map(toCaseRow),
      activities: activities.map(toActivity),
    };
  }

  const EDIT_FIELDS = Object.values(ORDER_EDITS).map(([name]) => name);

  async function editableOrder(id) {
    const [row] = await salesforce.query(
      `SELECT Id, OrderNumber, Account.Name, CustomerAuthorizedById, ShippingCountryCode, ${EDIT_FIELDS.join(', ')} FROM Order WHERE Id = ${quoted(id)} LIMIT 1`,
    );
    return row || null;
  }

  // The order's current values, the allowed choices and the limits, for the console's edit form.
  async function getOrderForEdit(id) {
    if (!isId(id)) return null;
    const [row, schema] = await Promise.all([editableOrder(id), orderSchema()]);
    if (!row) return null;
    const meta = (key) => schema.fields[ORDER_EDITS[key][0]];
    return {
      id: row.Id,
      orderNumber: row.OrderNumber,
      customerName: row.Account?.Name || null,
      values: Object.fromEntries(Object.entries(ORDER_EDITS).map(([key, [name]]) => [key, row[name] ?? null])),
      options: {
        statuses: meta('status').values,
        deliveryStatuses: meta('deliveryStatus').values,
        sources: meta('source').values,
        fulfilmentTypes: meta('fulfilment').values,
        states: schema.states,
      },
      maxLengths: Object.fromEntries(Object.keys(ORDER_EDITS).filter((k) => ['string', 'textarea'].includes(meta(k).type)).map((k) => [k, meta(k).length])),
      required: Object.keys(ORDER_EDITS).filter((k) => !meta(k).nillable),
    };
  }

  function checkValue(key, raw, schema, row) {
    const [name, label] = ORDER_EDITS[key];
    const meta = schema.fields[name];
    if (raw !== null && typeof raw !== 'string') return { error: `${label} must be text.` };
    const value = raw === null ? null : raw.replace(/\r\n?/g, '\n').trim() || null;
    if (value === null) return meta.nillable ? { value } : { error: `${label} cannot be empty.` };
    if (meta.type === 'date') {
      const day = new Date(`${value}T00:00:00Z`);
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
      return valid ? { value } : { error: `${label} must be a date.` };
    }
    if (name === 'ShippingStateCode') return schema.states.some((s) => s.value === value) ? { value } : { error: `${label} must be a state of India.` };
    if (meta.type === 'picklist') return meta.values.includes(value) ? { value } : { error: `${label} must be one of: ${meta.values.join(', ')}.` };
    if (meta.length && value.length > meta.length) return { error: `${label} can be at most ${meta.length} characters.` };
    if (name === 'ShippingPostalCode' && [null, undefined, 'IN'].includes(row.ShippingCountryCode) && !/^[1-9]\d{5}$/.test(value)) {
      return { error: `${label} must be a six digit PIN code.` };
    }
    return { value };
  }

  // Saves what staff changed on an order. Only the fields listed in ORDER_EDITS are accepted, each value is checked
  // against the org's own rules first, only real changes are sent, and a completed task on the order records who
  // changed what (every console save reaches Salesforce as the integration user).
  async function updateOrder(id, changes, { editedBy = 'The service console' } = {}) {
    if (!isId(id)) return null;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return { error: 'invalid', message: 'Send the changes as a JSON object.' };
    }
    const unknown = Object.keys(changes).filter((k) => !Object.hasOwn(ORDER_EDITS, k));
    if (unknown.length) return { error: 'invalid', field: unknown[0], message: `These cannot be changed here: ${unknown.join(', ')}.` };

    const [row, schema] = await Promise.all([editableOrder(id), orderSchema()]);
    if (!row) return null;
    const stateName = (code) => schema.states.find((s) => s.value === code)?.label || code;

    const fields = {};
    const changed = [];
    for (const [key, raw] of Object.entries(changes)) {
      if (raw === undefined) continue;
      const [name, label] = ORDER_EDITS[key];
      const checked = checkValue(key, raw, schema, row);
      if (checked.error) return { error: 'invalid', field: key, message: checked.error };
      const before = row[name] ?? null;
      if (checked.value === before) continue;
      fields[name] = checked.value;
      changed.push({ field: key, label, from: before, to: checked.value });
    }
    if (!changed.length) return { updated: false, changes: [], order: await getOrder(id) };
    if (fields.ShippingStateCode && !row.ShippingCountryCode) fields.ShippingCountryCode = 'IN';

    try {
      await salesforce.update('Order', id, fields);
    } catch (err) {
      const refusal = salesforceRefusal(err);
      if (refusal) return { error: 'rejected', ...refusal };
      throw err;
    }

    const shown = (c, value) => {
      if (value === null) return '(empty)';
      const text = c.field === 'shippingState' ? stateName(value) : String(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    };
    await salesforce.create('Task', Object.fromEntries(Object.entries({
      WhatId: id,
      WhoId: row.CustomerAuthorizedById,
      Subject: 'Order edited in the service console',
      Description: [`${editedBy} changed:`, ...changed.map((c) => `- ${c.label}: ${shown(c, c.from)} → ${shown(c, c.to)}`)].join('\n'),
      Status: 'Completed',
      Priority: 'Normal',
      ActivityDate: todayInIst(now()).toISOString().slice(0, 10),
    }).filter(([, v]) => v))).catch((err) => logger.error(`Order ${id} was saved, but its history note failed: ${err.message}`));

    return { updated: true, changes: changed, order: await getOrder(id) };
  }

  async function listCustomers(filters = {}) {
    const p = paging(filters);
    const q = String(filters.q || '').trim();
    const digits = q.replace(/\D/g, '');
    const conditions = [
      q && `(Name LIKE ${like(q)} OR Email LIKE ${like(q)} OR Account.Name LIKE ${like(q)} OR MailingCity LIKE ${like(q)}`
        + `${digits.length >= 4 ? ` OR MobilePhone LIKE ${like(digits)} OR Phone LIKE ${like(digits)}` : ''})`,
    ];
    const rows = await salesforce.query(
      'SELECT Id, Name, AccountId, Account.Name, MobilePhone, Phone, Email, MailingCity, MailingPostalCode, CreatedDate '
      + `FROM Contact${where(conditions)} ORDER BY CreatedDate DESC LIMIT ${p.pageSize + 1} OFFSET ${p.offset}`,
    );
    return pageOf(rows.map(toContactRow), p);
  }

  async function getCustomer(id) {
    if (!isId(id)) return null;
    const [row] = await salesforce.query(
      'SELECT Id, Name, AccountId, Account.Name, MobilePhone, Phone, OtherPhone, Email, MailingStreet, MailingCity, MailingState, '
      + `MailingPostalCode, Languages__c, Description, CreatedDate FROM Contact WHERE Id = ${quoted(id)} LIMIT 1`,
    );
    if (!row) return null;
    const owner = row.AccountId ? `AccountId = ${quoted(row.AccountId)}` : `ContactId = ${quoted(id)}`;
    const [orders, cases, activities] = await Promise.all([
      row.AccountId
        ? salesforce.query(`SELECT ${ORDER_LIST_FIELDS} FROM Order WHERE AccountId = ${quoted(row.AccountId)} ORDER BY CreatedDate DESC LIMIT 20`)
        : [],
      salesforce.query(`SELECT ${CASE_LIST_FIELDS} FROM Case WHERE ${owner} ORDER BY CreatedDate DESC LIMIT 20`),
      salesforce.query(`SELECT ${ACTIVITY_FIELDS} FROM Task WHERE WhoId = ${quoted(id)} ORDER BY CreatedDate DESC LIMIT 20`),
    ]);
    return {
      ...toContactRow(row),
      otherPhone: row.OtherPhone || null,
      address: [row.MailingStreet, row.MailingCity, row.MailingState, row.MailingPostalCode].filter(Boolean).join(', ') || null,
      languages: row.Languages__c || null,
      description: row.Description || null,
      orders: orders.map(toOrderRow),
      cases: cases.map(toCaseRow),
      activities: activities.map(toActivity),
    };
  }

  async function listCases(filters = {}) {
    const p = paging(filters);
    const q = String(filters.q || '').trim();
    const conditions = [
      filters.state === 'open' && 'IsClosed = false',
      filters.state === 'closed' && 'IsClosed = true',
      oneOf(filters.status, CASE_STATUSES) && `Status = ${quoted(filters.status)}`,
      oneOf(filters.type, SERVICE_TYPES) && `Service_Type__c = ${quoted(filters.type)}`,
      oneOf(filters.origin, CASE_ORIGINS) && `Origin = ${quoted(filters.origin)}`,
      q && `(CaseNumber LIKE ${like(q)} OR Subject LIKE ${like(q)} OR Contact.Name LIKE ${like(q)} OR Account.Name LIKE ${like(q)} OR Service_City__c LIKE ${like(q)})`,
    ];
    const rows = await salesforce.query(
      `SELECT ${CASE_LIST_FIELDS} FROM Case${where(conditions)} ORDER BY CreatedDate DESC LIMIT ${p.pageSize + 1} OFFSET ${p.offset}`,
    );
    return { ...pageOf(rows.map(toCaseRow), p), filters: { statuses: CASE_STATUSES, serviceTypes: SERVICE_TYPES, origins: CASE_ORIGINS } };
  }

  async function getCase(id) {
    if (!isId(id)) return null;
    const [row] = await salesforce.query(
      `SELECT ${CASE_LIST_FIELDS}, Description, Customer_Mobile__c, Invoice_Number__c, Order_Source__c, Service_State__c, `
      + 'Damaged_Component__r.Name, Damaged_Component__r.Part_Number__c, Technician__r.Name, Service_Provider__r.Name, '
      + `Contact.MobilePhone, Contact.Email FROM Case WHERE Id = ${quoted(id)} LIMIT 1`,
    );
    if (!row) return null;
    const [visits, shipments, activities] = await Promise.all([
      salesforce.query(`SELECT ${VISIT_FIELDS} FROM Service_Visit__c WHERE Case__c = ${quoted(id)} ORDER BY Scheduled_Start__c DESC NULLS LAST LIMIT 20`),
      salesforce.query(`SELECT ${SHIPMENT_FIELDS} FROM Replacement_Shipment__c WHERE Case__c = ${quoted(id)} ORDER BY CreatedDate DESC LIMIT 20`),
      salesforce.query(`SELECT ${ACTIVITY_FIELDS} FROM Task WHERE WhatId = ${quoted(id)} ORDER BY CreatedDate DESC LIMIT 20`),
    ]);
    return {
      ...toCaseRow(row),
      description: row.Description || null,
      mobile: row.Customer_Mobile__c || row.Contact?.MobilePhone || null,
      email: row.Contact?.Email || null,
      invoiceNumber: row.Invoice_Number__c || null,
      orderSource: row.Order_Source__c || null,
      state: row.Service_State__c || null,
      component: row.Damaged_Component__r ? { name: row.Damaged_Component__r.Name, partNumber: row.Damaged_Component__r.Part_Number__c || null } : null,
      technician: row.Technician__r?.Name || null,
      serviceProvider: row.Service_Provider__r?.Name || null,
      visits: visits.map(toVisit),
      shipments: shipments.map(toShipment),
      activities: activities.map(toActivity),
    };
  }

  // Technician visits and replacement part shipments, newest first.
  async function listFieldService() {
    const [visits, shipments] = await Promise.all([
      salesforce.query(`SELECT ${VISIT_FIELDS} FROM Service_Visit__c ORDER BY Scheduled_Start__c DESC NULLS LAST LIMIT 100`),
      salesforce.query(`SELECT ${SHIPMENT_FIELDS} FROM Replacement_Shipment__c ORDER BY CreatedDate DESC LIMIT 100`),
    ]);
    return { visits: visits.map(toVisit), shipments: shipments.map(toShipment) };
  }

  async function listActivities(filters = {}) {
    const p = paging(filters);
    const kind = ACTIVITY_KINDS[filters.kind] || null;
    const rows = await salesforce.query(
      `SELECT ${ACTIVITY_FIELDS} FROM Task${where([kind])} ORDER BY CreatedDate DESC LIMIT ${p.pageSize + 1} OFFSET ${p.offset}`,
    );
    return pageOf(rows.map(toActivity), p);
  }

  // Calls the server has scheduled (follow-ups, callbacks, notifications) and the open to-dos for the service team.
  async function listRequests() {
    const [jobs, todos, escalated] = await Promise.all([
      scheduler ? scheduler.list() : [],
      salesforce.query(`SELECT ${ACTIVITY_FIELDS} FROM Task WHERE IsClosed = false AND TaskSubtype != 'Call' AND TaskSubtype != 'Email' ORDER BY CreatedDate DESC LIMIT 50`),
      salesforce.query(`SELECT ${CASE_LIST_FIELDS} FROM Case WHERE Status = 'Escalated' ORDER BY CreatedDate DESC LIMIT 50`),
    ]);
    return {
      scheduledCalls: jobs
        .map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          runAt: j.runAt || null,
          completedAt: j.completedAt || null,
          attempts: j.attempts || 0,
          lastError: j.lastError || null,
          customerName: j.payload?.customerName || null,
          reference: j.payload?.erpOrderId || j.payload?.caseNumber || null,
          orderId: j.payload?.orderId || null,
          caseId: j.payload?.caseId || null,
        }))
        .sort((a, b) => String(b.runAt).localeCompare(String(a.runAt))),
      todos: todos.map(toActivity),
      callbacks: escalated.map(toCaseRow),
    };
  }

  async function serviceSetup() {
    const [hours, regions] = await Promise.all([
      crm.getServiceHours().catch(() => null),
      salesforce.query('SELECT MasterLabel, Match_Type__c, Match_Value__c FROM Service_Region__mdt ORDER BY Match_Type__c, Match_Value__c'),
    ]);
    return {
      hours,
      regions: regions.map((r) => ({ label: r.MasterLabel || null, type: r.Match_Type__c, value: r.Match_Value__c })),
    };
  }

  async function summary() {
    const [orders, draftOrders, revenue, openCases, escalated, newToday, customers, products, byType, recentOrders, recentCases, hours, jobs] = await Promise.all([
      count('SELECT COUNT(Id) n FROM Order'),
      count("SELECT COUNT(Id) n FROM Order WHERE Status = 'Draft'"),
      salesforce.query('SELECT SUM(TotalAmount) n FROM Order').then(([r]) => Number(r?.n || 0)),
      count('SELECT COUNT(Id) n FROM Case WHERE IsClosed = false'),
      count("SELECT COUNT(Id) n FROM Case WHERE Status = 'Escalated'"),
      count('SELECT COUNT(Id) n FROM Case WHERE CreatedDate = TODAY'),
      count('SELECT COUNT(Id) n FROM Contact'),
      productRows(null).then((rows) => rows.length),
      salesforce.query('SELECT Service_Type__c serviceType, COUNT(Id) n FROM Case WHERE IsClosed = false GROUP BY Service_Type__c'),
      salesforce.query(`SELECT ${ORDER_LIST_FIELDS} FROM Order ORDER BY CreatedDate DESC LIMIT 5`),
      salesforce.query(`SELECT ${CASE_LIST_FIELDS} FROM Case WHERE IsClosed = false ORDER BY CreatedDate DESC LIMIT 6`),
      crm.getServiceHours().catch(() => null),
      scheduler ? scheduler.list() : [],
    ]);
    return {
      counts: {
        orders,
        draftOrders,
        revenue,
        openCases,
        escalatedCases: escalated,
        casesToday: newToday,
        customers,
        products,
        scheduledCalls: jobs.filter((j) => j.status === 'pending').length,
      },
      openCasesByType: byType.map((r) => ({ type: r.serviceType || 'Not set', count: Number(r.n || 0) })).sort((a, b) => b.count - a.count),
      recentOrders: recentOrders.map(toOrderRow),
      recentCases: recentCases.map(toCaseRow),
      hours,
    };
  }

  return {
    summary,
    listProducts,
    getProduct,
    listOrders,
    getOrder,
    getOrderForEdit,
    updateOrder,
    listCustomers,
    getCustomer,
    listCases,
    getCase,
    listFieldService,
    listActivities,
    listRequests,
    serviceSetup,
  };
}

module.exports = { createConsoleData, categoryOf, isId, ORDER_EDITS };
