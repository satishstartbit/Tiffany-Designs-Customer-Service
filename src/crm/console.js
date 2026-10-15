const { escapeSoql, escapeSoqlLike } = require('./crm');

// Read-only views of Salesforce for the staff console (web/): lists with filters and one-record details.
// Every value placed in SOQL is escaped, and filters are checked against the org's picklist values.

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

function createConsoleData({ salesforce, crm, scheduler, productCodePrefix = 'TD-' }) {
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

module.exports = { createConsoleData, categoryOf, isId };
