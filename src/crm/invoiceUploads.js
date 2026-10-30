const { escapeSoql, escapeSoqlLike, soqlDateTime } = require('./crm');
const { formatRupees } = require('./orderItems');
const { normalizePhone, lastTenDigits, namesMatch, sameReference, fullName } = require('../rules');
const { todayInIst } = require('../dates');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DESCRIPTION_MAX = 32000;
// Each link sent is a task with the number in its subject, so an upload can find it from a phone number alone.
const LINK_SUBJECT = 'Invoice upload link sent on WhatsApp to';
const FILE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

// The order, its customer and its address fields as the invoice update reads and labels them.
const ORDER_FIELDS = 'Id, OrderNumber, Status, Pricebook2Id, EffectiveDate, ERP_Order_Id__c, Invoice_Number__c, Order_Source__c, Description, '
  + 'AccountId, Account.Name, CustomerAuthorizedById, ShippingStreet, ShippingCity, ShippingPostalCode, ShippingStateCode, ShippingCountryCode, '
  + 'BillingStreet, BillingCity, BillingPostalCode, BillingStateCode, BillingCountryCode';
const CONTACT_FIELDS = 'Id, AccountId, FirstName, LastName, MobilePhone, Email, MailingStreet, MailingCity, MailingPostalCode, MailingStateCode, MailingCountryCode';
const ADDRESS_PARTS = { Street: 'street', City: 'city', PostalCode: 'PIN code', StateCode: 'state', CountryCode: 'country' };
const LABELS = {
  Invoice_Number__c: 'Invoice number',
  ERP_Order_Id__c: 'Order id',
  Order_Source__c: 'Channel',
  EffectiveDate: 'Order date',
  CustomerAuthorizedById: 'Customer contact',
  FirstName: 'First name',
  LastName: 'Last name',
  MobilePhone: 'Mobile',
  Email: 'Email',
  ...Object.fromEntries(['Shipping', 'Billing', 'Mailing'].flatMap((prefix) => Object.entries(ADDRESS_PARTS)
    .map(([part, label]) => [`${prefix}${part}`, `${{ Shipping: 'Delivery', Billing: 'Billing', Mailing: 'Address' }[prefix]} ${label}`]))),
};
// Words that do not tell one product from another, for matching invoice lines to the catalog.
const PRODUCT_FILLER = new Set(['demo', 'tiffany', 'design', 'designs', 'the', 'and', 'with', 'for', 'set', 'pack', 'piece', 'pcs']);

function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function longDate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value));
}

const addressLine = (a) => [a?.street, a?.city, a?.state, a?.postalCode].filter(Boolean).join(', ');
const hasAddress = (a) => Boolean(a && (a.city || a.postalCode));

// Everything read from the invoice, one line each, for the order's notes, the task and the case.
function invoiceLines(invoice) {
  const items = invoice.items.map((i) => `- ${i.name}${i.sku ? ` (${i.sku})` : ''}${i.quantity != null ? `, quantity ${i.quantity}` : ''}`
    + `${i.amount != null ? `, ${formatRupees(i.amount)}` : ''}`);
  return [
    invoice.invoiceNumber && `Invoice number: ${invoice.invoiceNumber}`,
    invoice.orderId && `Order id on the invoice: ${invoice.orderId}`,
    invoice.orderNumber && `Order number on the invoice: ${invoice.orderNumber}`,
    invoice.invoiceDate && `Invoice date: ${longDate(invoice.invoiceDate)}`,
    invoice.orderDate && `Order date: ${longDate(invoice.orderDate)}`,
    invoice.soldBy && `Sold by: ${invoice.soldBy}`,
    (invoice.platform || invoice.seller) && `Bought from: ${[invoice.platform, invoice.seller && `seller ${invoice.seller}`].filter(Boolean).join(', ')}`,
    (invoice.customerName || invoice.phone || invoice.email) && `Customer: ${[invoice.customerName, invoice.phone, invoice.email].filter(Boolean).join(', ')}`,
    hasAddress(invoice.address) && `Delivery address: ${addressLine(invoice.address)}`,
    hasAddress(invoice.billingAddress) && `Billing address: ${addressLine(invoice.billingAddress)}`,
    items.length && 'Products:',
    ...items,
    invoice.total != null && `Total: ${formatRupees(invoice.total)}`,
  ].filter(Boolean);
}

// "Salesforce request failed (400): [{message}]" -> the messages.
function refusal(err) {
  const match = /^Salesforce request failed \(\d+\): (.*)$/s.exec(err?.message || '');
  try {
    return [].concat(JSON.parse(match[1])).map((e) => e.message).filter(Boolean).join(' ') || err.message;
  } catch {
    return err?.message || String(err);
  }
}

const sameValue = (field, before, after) => {
  if (field === 'MobilePhone') return lastTenDigits(before) === lastTenDigits(after);
  if (field === 'Invoice_Number__c') return sameReference(after, before);
  return String(before ?? '').trim().toLowerCase() === String(after ?? '').trim().toLowerCase();
};

// The invoice's values that differ from the record: { fields, changes }. Empty values on the invoice change nothing.
function differences(record, wanted) {
  const fields = {};
  const changes = [];
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined || value === null || value === '') continue;
    const before = record?.[field] ?? null;
    if (sameValue(field, before, value)) continue;
    fields[field] = value;
    changes.push({ field, label: LABELS[field] || field, from: before, to: value });
  }
  return { fields, changes };
}

const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 3 && !PRODUCT_FILLER.has(w))
  .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
const plainCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The price book entry an invoice line names: by product code, else the product whose every name word is in the line
// ("Demo Study Table" for "Engineered Wood Study Table, Walnut"), the most specific one, preferring the order's own.
function productFor(item, entries, onOrder) {
  if (item.sku) {
    const byCode = entries.filter((e) => plainCode(e.Product2?.ProductCode) && plainCode(e.Product2.ProductCode) === plainCode(item.sku));
    if (byCode.length === 1) return byCode[0];
  }
  const said = new Set(words(item.name));
  const fits = entries.map((e) => ({ e, w: words(e.Product2?.Name) })).filter((x) => x.w.length && x.w.every((w) => said.has(w)));
  if (!fits.length) return null;
  const most = Math.max(...fits.map((x) => x.w.length));
  let best = fits.filter((x) => x.w.length === most);
  if (best.length > 1) {
    const own = best.filter((x) => onOrder.has(x.e.Product2Id));
    if (own.length === 1) best = own;
  }
  return best.length === 1 ? best[0].e : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const section = (title, lines) => (lines.length ? [title, ...lines] : []);
// "142" and "00000142" are the same Salesforce order number.
const sameOrderNumber = (a, b) => String(a || '').replace(/\D/g, '').replace(/^0+/, '') === String(b || '').replace(/\D/g, '').replace(/^0+/, '');

// What happens to an invoice a customer uploads on the website's /invoice page (the route has already checked that
// Tiffany Designs sold it): the order it belongs to is looked up by the invoice number, else the phone on the invoice,
// else the order number, else the order id. A matched order is brought in line with the invoice: its details, its
// customer and its products (every change is noted, old value and new), it gets the file, and the caller's requests
// that were registered without an order. No order is ever added for an invoice that matches one. An invoice that
// matches no order becomes a new Draft order with its customer, its details and its products; only when no customer
// can be saved for it (no phone, or no full name) does it go to the service team on a request instead.
// The upload page asks for nothing but the file, so the WhatsApp link an upload answers is found from the invoice:
// a link sent in the last `linkDays` to the phone on the invoice or to the customer of the matched order.
function createInvoiceUploads({ salesforce, crm, linkDays = 7, productCodePrefix = 'TD-', now = () => Date.now(), logger = console }) {
  const today = () => todayInIst(now()).toISOString().slice(0, 10);

  // Notes that the voice agent sent the upload page to this number (+91 form), as an open task for the service team
  // that the upload completes. Returns the task id.
  async function linkSent({ phone, customerName, reference }) {
    const contact = await crm.findContactByPhone(phone);
    const created = await salesforce.create('Task', compact({
      WhoId: contact?.id,
      Subject: `${LINK_SUBJECT} ${phone}`,
      Description: [
        `The AI voice agent found no order for the caller and sent the invoice upload page on WhatsApp to ${phone}.`,
        customerName && `Customer name: ${String(customerName).trim().slice(0, 80)}`,
        reference && `Order reference given on the call: ${String(reference).trim().slice(0, 60)}`,
        'This task is completed when the customer uploads the invoice.',
      ].filter(Boolean).join('\n'),
      Status: 'Not Started',
      Priority: 'Normal',
      ActivityDate: today(),
    }));
    return created.id;
  }

  const linkFailed = (taskId) => salesforce.remove('Task', taskId);

  // The newest link sent in the last `linkDays` to any of these numbers (+91 form), or null.
  async function findLink(phones) {
    const subjects = [...new Set(phones.filter(Boolean))].map((p) => `'${escapeSoql(`${LINK_SUBJECT} ${p}`)}'`);
    if (!subjects.length) return null;
    const [row] = await salesforce.query(
      `SELECT Id, Subject, Description, CreatedDate FROM Task WHERE Subject IN (${subjects.join(', ')}) `
      + `AND CreatedDate >= ${soqlDateTime(now() - linkDays * DAY_MS)} ORDER BY CreatedDate DESC LIMIT 1`,
    );
    if (!row) return null;
    const line = (label) => new RegExp(`^${label}: (.+)$`, 'm').exec(row.Description || '')?.[1].trim() || null;
    return {
      id: row.Id,
      phone: row.Subject.slice(LINK_SUBJECT.length).trim(),
      customerName: line('Customer name'),
      reference: line('Order reference given on the call'),
      issuedAt: row.CreatedDate,
      details: row.Description || '',
    };
  }

  async function closeLink(link, outcome) {
    const note = `Invoice uploaded on ${longDate(now())}: ${outcome}`;
    await salesforce.update('Task', link.id, { Status: 'Completed', Description: `${link.details}\n${note}`.slice(0, DESCRIPTION_MAX) })
      .catch((err) => logger.error(`Completing the invoice upload link task ${link.id} failed: ${err.message}`));
  }

  // The customers the invoice's phone number and the caller's WhatsApp number belong to.
  async function contactsFor(phones) {
    const found = [];
    for (const phone of phones) {
      const contact = await crm.findContactByPhone(phone);
      if (contact && !found.some((c) => c.id === contact.id)) found.push(contact);
    }
    return found;
  }

  async function findOrder(invoice, contacts) {
    const accounts = new Set(contacts.map((c) => c.accountId).filter(Boolean));
    // One invoice number can be on several orders; the customer's own account picks theirs.
    const narrow = (matches) => {
      const own = matches.filter((o) => accounts.has(o.accountId));
      return matches.length > 1 && own.length ? own : matches;
    };
    const notes = [];
    if (invoice.invoiceNumber) {
      const matches = narrow(await crm.findOrdersByInvoice(invoice.invoiceNumber));
      if (matches.length === 1) return { order: matches[0], matchedBy: 'invoice number' };
      if (matches.length > 1) notes.push(`${matches.length} orders have invoice number ${invoice.invoiceNumber}.`);
    }
    // By mobile only when the customer has exactly one recent order that carries no other invoice number, order id
    // or order number than the invoice's.
    const other = (o) => (invoice.invoiceNumber && o.invoiceNumber && !sameReference(invoice.invoiceNumber, o.invoiceNumber))
      || (invoice.orderId && o.erpOrderId && !sameReference(invoice.orderId, o.erpOrderId))
      || (invoice.orderNumber && o.orderNumber && !sameOrderNumber(invoice.orderNumber, o.orderNumber));
    for (const contact of contacts.filter((c) => c.accountId)) {
      const orders = (await crm.findRecentOrdersForAccount(contact.accountId, 5)).filter((o) => !other(o));
      if (orders.length === 1) return { order: orders[0], matchedBy: 'mobile number' };
      if (orders.length > 1) notes.push(`${contact.name || 'The customer'} (mobile ending ${lastTenDigits(contact.mobile || contact.phone)?.slice(-4)}) has ${orders.length} recent orders.`);
    }
    for (const [reference, label] of [[invoice.orderNumber, 'order number'], [invoice.orderId, 'order id']]) {
      if (!reference) continue;
      const matches = narrow(await crm.findOrdersByReference(reference));
      if (matches.length === 1) return { order: matches[0], matchedBy: label };
      if (matches.length > 1) notes.push(`${matches.length} orders match ${label} ${reference}.`);
    }
    if (!notes.length) notes.push('No order has this invoice number, order number or order id, and no single order is on the mobile number.');
    return { order: null, notes };
  }

  // Requests the caller registered without an order since the link was sent (or just before): the voice agent sends
  // the link and then registers the installation, on the WhatsApp number or the caller's contact.
  async function waitingCases(link, caller) {
    const ten = lastTenDigits(link.phone);
    const who = [`Customer_Mobile__c IN ('+91${ten}', '${ten}')`, caller && `ContactId = '${escapeSoql(caller.id)}'`].filter(Boolean).join(' OR ');
    return salesforce.query(
      'SELECT Id, CaseNumber, ContactId, Invoice_Number__c, Order_Source__c FROM Case WHERE IsClosed = false AND Order__c = null '
      + `AND (${who}) AND CreatedDate >= ${soqlDateTime(Date.parse(link.issuedAt) - HOUR_MS)} ORDER BY CreatedDate DESC LIMIT 5`,
    );
  }

  async function attach(file, parentId) {
    const day = today();
    try {
      const created = await salesforce.create('ContentVersion', {
        Title: `Invoice uploaded by the customer, ${longDate(day)}`,
        PathOnClient: `invoice-${day}.${FILE_EXTENSIONS[file.contentType] || 'bin'}`,
        VersionData: Buffer.from(file.data).toString('base64'),
        FirstPublishLocationId: parentId,
      });
      return created.id;
    } catch (err) {
      logger.error(`Saving the uploaded invoice on ${parentId} failed: ${err.message}`);
      return null;
    }
  }

  async function note({ whatId, whoId, subject, lines, open }) {
    try {
      const created = await salesforce.create('Task', compact({
        WhatId: whatId,
        WhoId: whoId,
        Subject: subject,
        Description: lines.join('\n').slice(0, DESCRIPTION_MAX),
        Status: open ? 'Not Started' : 'Completed',
        Priority: 'Normal',
        ActivityDate: today(),
      }));
      return created.id;
    } catch (err) {
      logger.error(`Saving the invoice upload note on ${whatId} failed: ${err.message}`);
      return null;
    }
  }

  // Saves the fields in one call; when Salesforce refuses, each field (an address as a whole) is tried on its own, so
  // one value it will not take costs only that value. Returns the refused fields with Salesforce's reason.
  async function save(sobject, id, fields) {
    if (!Object.keys(fields).length) return [];
    try {
      await salesforce.update(sobject, id, fields);
      return [];
    } catch (err) {
      logger.error(`Updating ${sobject} ${id} from an uploaded invoice failed: ${err.message}`);
    }
    const groups = new Map();
    for (const [field, value] of Object.entries(fields)) {
      const key = /^(Shipping|Billing|Mailing)/.exec(field)?.[1] || field;
      groups.set(key, { ...groups.get(key), [field]: value });
    }
    const refused = [];
    for (const group of groups.values()) {
      try {
        await salesforce.update(sobject, id, group);
      } catch (err) {
        refused.push(...Object.keys(group).map((field) => ({ field, reason: refusal(err) })));
      }
    }
    return refused;
  }

  async function addressFields(prefix, a, record) {
    if (!hasAddress(a)) return {};
    const stateCode = await crm.indianStateCode(a.state).catch(() => undefined);
    return {
      [`${prefix}Street`]: a.street,
      [`${prefix}City`]: a.city,
      [`${prefix}PostalCode`]: a.postalCode,
      [`${prefix}StateCode`]: stateCode,
      [`${prefix}CountryCode`]: 'IN',
    };
  }

  // The order's customer: its contact, else a contact of its account with the invoice's or the caller's number, else a
  // new contact from the invoice. The contact then takes the invoice's name, mobile, email and address.
  async function updateCustomer(row, invoice, link, contacts) {
    const changes = [];
    const problems = [];
    let contact = null;
    if (row.CustomerAuthorizedById) {
      [contact] = await salesforce.query(`SELECT ${CONTACT_FIELDS} FROM Contact WHERE Id = '${escapeSoql(row.CustomerAuthorizedById)}' LIMIT 1`);
    }
    const name = invoice.customerName || link?.customerName;
    const nameParts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const named = nameParts.length
      ? { FirstName: nameParts.length > 1 ? nameParts[0] : undefined, LastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0] }
      : {};
    const mailing = await addressFields('Mailing', hasAddress(invoice.billingAddress) ? invoice.billingAddress : invoice.address, contact);

    if (!contact && row.AccountId) {
      const own = contacts.find((c) => c.accountId === row.AccountId);
      if (!own && contacts.length) {
        problems.push(`The mobile number belongs to ${contacts[0].name || 'a customer'} on another account, so no contact was set on the order.`);
        return { contactId: null, changes, problems };
      }
      if (!own) {
        if (!named.LastName) return { contactId: null, changes, problems };
        const created = await salesforce.create('Contact', compact({
          AccountId: row.AccountId, ...named, MobilePhone: invoice.phone || link?.phone, Email: invoice.email, ...mailing,
        }));
        changes.push({ label: 'Customer contact', from: null, to: `${name} (new contact)` });
        return { contactId: created.id, changes, problems, linkContact: created.id };
      }
      [contact] = await salesforce.query(`SELECT ${CONTACT_FIELDS} FROM Contact WHERE Id = '${escapeSoql(own.id)}' LIMIT 1`);
      changes.push({ label: 'Customer contact', from: null, to: own.name || own.id });
    }
    if (!contact) return { contactId: null, changes, problems };

    const currentName = [contact.FirstName, contact.LastName].filter(Boolean).join(' ');
    const wanted = {
      ...(name && !namesMatch(name, currentName) ? named : {}),
      MobilePhone: invoice.phone,
      Email: invoice.email,
      ...mailing,
    };
    const diff = differences(contact, wanted);
    const refused = await save('Contact', contact.Id, diff.fields);
    changes.push(...diff.changes.filter((c) => !refused.some((r) => r.field === c.field)));
    problems.push(...refused.map((r) => `${LABELS[r.field] || r.field} was not changed: ${r.reason}`));
    return { contactId: contact.Id, changes, problems, linkContact: row.CustomerAuthorizedById ? null : contact.Id };
  }

  // Brings the order's products in line with the invoice: quantities and prices of the products on both, and the
  // invoice's other products added. Salesforce changes products only on a Draft order, so an activated order is made
  // Draft for the change and activated again (the purchase recommendation flow has already run for it and sends
  // nothing twice). Products not in the catalog, and products only on the order, are left for the team.
  async function updateProducts(row, invoice) {
    const result = { changes: [], problems: [] };
    if (!invoice.items.length) return result;
    // Only Tiffany's own products: the price book also holds the org's sample products.
    const ownProducts = productCodePrefix ? ` AND Product2.ProductCode LIKE '${escapeSoqlLike(productCodePrefix)}%'` : '';
    const [entries, items] = await Promise.all([
      salesforce.query(
        'SELECT Id, UnitPrice, Product2Id, Product2.Name, Product2.ProductCode FROM PricebookEntry '
        + `WHERE Pricebook2Id = '${escapeSoql(row.Pricebook2Id)}' AND IsActive = true${ownProducts} LIMIT 500`,
      ),
      salesforce.query(`SELECT Id, Product2Id, Product2.Name, Quantity, UnitPrice FROM OrderItem WHERE OrderId = '${escapeSoql(row.Id)}'`),
    ]);
    const onOrder = new Set(items.map((i) => i.Product2Id));
    const used = new Set();
    const updates = [];
    const additions = [];
    for (const item of invoice.items) {
      const entry = productFor(item, entries, onOrder);
      if (!entry) {
        result.problems.push(`"${item.name}" on the invoice is not in the product catalog, so it was not added.`);
        continue;
      }
      const name = entry.Product2?.Name || item.name;
      const quantity = item.quantity != null && item.quantity > 0 ? item.quantity : null;
      const unitPrice = item.amount != null ? round2(item.amount / (quantity || 1)) : null;
      const existing = items.find((i) => i.Product2Id === entry.Product2Id && !used.has(i.Id));
      if (existing) {
        used.add(existing.Id);
        const fields = {};
        if (quantity != null && quantity !== existing.Quantity) fields.Quantity = quantity;
        if (unitPrice != null && Math.abs(unitPrice - existing.UnitPrice) >= 0.01) fields.UnitPrice = unitPrice;
        if (Object.keys(fields).length) {
          updates.push({
            id: existing.Id,
            fields,
            change: `${name}: ${[fields.Quantity != null && `quantity ${existing.Quantity} → ${fields.Quantity}`,
              fields.UnitPrice != null && `price ${formatRupees(existing.UnitPrice)} → ${formatRupees(fields.UnitPrice)}`].filter(Boolean).join(', ')}`,
          });
        }
      } else {
        const price = unitPrice ?? entry.UnitPrice;
        additions.push({
          record: { OrderId: row.Id, PricebookEntryId: entry.Id, Quantity: quantity || 1, UnitPrice: price },
          change: `${name}: added, quantity ${quantity || 1} at ${formatRupees(price)}`,
        });
      }
    }
    for (const item of items.filter((i) => !used.has(i.Id))) {
      result.problems.push(`${item.Product2?.Name || 'A product'} is on the order but not on the invoice; it was left as it is.`);
    }
    if (!updates.length && !additions.length) return result;

    const reactivate = row.Status === 'Activated';
    try {
      if (reactivate) await salesforce.update('Order', row.Id, { Status: 'Draft' });
      for (const u of updates) {
        await salesforce.update('OrderItem', u.id, u.fields);
        result.changes.push(u.change);
      }
      if (additions.length) {
        await salesforce.createMany('OrderItem', additions.map((a) => a.record));
        result.changes.push(...additions.map((a) => a.change));
      }
    } catch (err) {
      logger.error(`Updating the products of order ${row.Id} from an uploaded invoice failed: ${err.message}`);
      result.problems.push(`Some products were not changed: ${refusal(err)}`);
    } finally {
      if (reactivate) {
        await salesforce.update('Order', row.Id, { Status: 'Activated' }).catch((err) => {
          logger.error(`Activating order ${row.Id} again failed: ${err.message}`);
          result.problems.push(`The order was made Draft to change its products and could not be activated again: ${refusal(err)} Activate it by hand.`);
        });
      }
    }
    return result;
  }

  // Brings the matched order in line with the invoice: its details (invoice number, channel, order date, delivery and
  // billing address), its customer and its products. The invoice wins; every change is returned as old and new value.
  async function updateOrder(orderId, invoice, link, contacts) {
    const [row] = await salesforce.query(`SELECT ${ORDER_FIELDS} FROM Order WHERE Id = '${escapeSoql(orderId)}' LIMIT 1`);
    const problems = [];

    const customer = await updateCustomer(row, invoice, link, contacts);
    problems.push(...customer.problems);

    const wanted = {
      Invoice_Number__c: invoice.invoiceNumber,
      // The order id is the key callers and other systems use, so it is only ever filled in.
      ERP_Order_Id__c: row.ERP_Order_Id__c ? undefined : invoice.orderId,
      Order_Source__c: invoice.platform,
      EffectiveDate: invoice.orderDate || invoice.invoiceDate,
      CustomerAuthorizedById: customer.linkContact,
      ...(await addressFields('Shipping', invoice.address, row)),
      ...(await addressFields('Billing', hasAddress(invoice.billingAddress) ? invoice.billingAddress : null, row)),
    };
    if (invoice.orderId && row.ERP_Order_Id__c && !sameReference(invoice.orderId, row.ERP_Order_Id__c)) {
      problems.push(`The order id is ${row.ERP_Order_Id__c}; the invoice shows ${invoice.orderId}. The order id was left as it is.`);
    }
    if (invoice.customerName && row.Account?.Name && !namesMatch(invoice.customerName, row.Account.Name)) {
      problems.push(`The order's account is ${row.Account.Name}; the invoice names ${invoice.customerName}.`);
    }
    const diff = differences(row, wanted);
    const marker = `(invoice ${invoice.invoiceNumber || invoice.orderId || today()})`;
    if (!String(row.Description || '').includes(marker)) {
      const block = [`Invoice details read by AI from the invoice the customer uploaded on ${longDate(now())} ${marker}:`, ...invoiceLines(invoice)].join('\n');
      diff.fields.Description = [row.Description, block].filter(Boolean).join('\n\n').slice(0, DESCRIPTION_MAX);
    }
    const refused = await save('Order', row.Id, diff.fields);
    problems.push(...refused.map((r) => `${LABELS[r.field] || r.field} was not changed: ${r.reason}`));
    const orderChanges = diff.changes.filter((c) => !refused.some((r) => r.field === c.field) && c.field !== 'CustomerAuthorizedById');

    const products = await updateProducts(row, invoice);
    problems.push(...products.problems);

    return {
      id: row.Id,
      name: row.ERP_Order_Id__c || `order number ${row.OrderNumber}`,
      invoiceNumber: refused.some((r) => r.field === 'Invoice_Number__c') ? row.Invoice_Number__c : invoice.invoiceNumber || row.Invoice_Number__c || null,
      orderSource: refused.some((r) => r.field === 'Order_Source__c') ? row.Order_Source__c : invoice.platform || row.Order_Source__c || null,
      contactId: customer.contactId,
      orderChanges,
      customerChanges: customer.changes,
      productChanges: products.changes,
      notesAdded: Boolean(diff.fields.Description) && !refused.some((r) => r.field === 'Description'),
      problems,
    };
  }

  // An invoice that matches no order becomes a Draft order, for the service team to check against the invoice and
  // activate. Its customer is the one the phone on the invoice (else the caller's WhatsApp number) belongs to, else a
  // new customer under the full name on the invoice or given on the call, with the invoice's email and address. The
  // order takes every detail the invoice shows and the products it can match in the catalog.
  // Returns { added } or { reason } when no customer can be saved for it.
  async function addOrder(invoice, link) {
    const phone = normalizePhone(invoice.phone) || link?.phone || null;
    if (!phone) return { reason: 'No order was added from it, because it shows no phone number for the customer.' };
    const billed = hasAddress(invoice.billingAddress) ? invoice.billingAddress : invoice.address;
    const customer = await crm.resolveOrCreateContact(
      phone,
      fullName(invoice.customerName) || fullName(link?.customerName),
      await addressFields('Billing', billed),
      compact({ Email: invoice.email, ...(await addressFields('Mailing', billed)) }),
    );
    if (!customer) return { reason: 'No order was added from it, because it shows no full name, first and last, for the customer.' };
    if (!customer.accountId) return { reason: `No order was added from it, because the customer record for ${phone} has no account.` };

    const problems = [];
    if (invoice.customerName && customer.name && !namesMatch(invoice.customerName, customer.name)) {
      problems.push(`The invoice names ${invoice.customerName}; the mobile number ${phone} belongs to ${customer.name}, so the order is on that customer.`);
    }
    const [pricebook] = await salesforce.query('SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1');
    const marker = `(invoice ${invoice.invoiceNumber || invoice.orderId || today()})`;
    const essentials = compact({
      AccountId: customer.accountId,
      CustomerAuthorizedById: customer.id,
      Status: 'Draft',
      EffectiveDate: invoice.orderDate || invoice.invoiceDate || today(),
      Pricebook2Id: pricebook?.Id,
      Description: [
        `Added from the invoice the customer uploaded on ${longDate(now())} ${marker}, because no order matched it. Check it against the attached invoice and activate it.`,
        ...invoiceLines(invoice),
      ].join('\n').slice(0, DESCRIPTION_MAX),
    });
    const details = compact({
      Invoice_Number__c: invoice.invoiceNumber,
      ERP_Order_Id__c: invoice.orderId,
      Order_Source__c: invoice.platform,
      ...(await addressFields('Shipping', invoice.address)),
      ...(await addressFields('Billing', billed)),
    });
    let created;
    try {
      created = await salesforce.create('Order', { ...essentials, ...details });
    } catch (err) {
      // A value Salesforce refuses costs only the invoice's details, which are in the notes and filled in by the team.
      logger.error(`Adding an order from an uploaded invoice failed: ${err.message}`);
      problems.push(`The order was saved without its invoice number, order id, channel and addresses, because Salesforce refused them: ${refusal(err)}`);
      created = await salesforce.create('Order', essentials);
    }

    const products = pricebook?.Id
      ? await updateProducts({ Id: created.id, Pricebook2Id: pricebook.Id, Status: 'Draft' }, invoice)
      : { changes: [], problems: invoice.items.length ? ['No standard price book was found, so no products were added.'] : [] };
    problems.push(...products.problems);
    const [saved] = await salesforce.query(`SELECT OrderNumber FROM Order WHERE Id = '${escapeSoql(created.id)}' LIMIT 1`);
    return {
      added: {
        id: created.id,
        name: invoice.orderId || `order number ${saved?.OrderNumber || created.id}`,
        invoiceNumber: invoice.invoiceNumber || null,
        orderSource: invoice.platform || null,
        contactId: customer.id,
        customer: `${customer.name}${customer.created ? ' (new customer)' : ''}, mobile ${phone}`,
        productChanges: products.changes,
        problems,
      },
    };
  }

  async function linkCases(cases, order) {
    const linked = [];
    for (const c of cases) {
      try {
        await salesforce.update('Case', c.Id, compact({
          Order__c: order.id,
          Invoice_Number__c: c.Invoice_Number__c ? undefined : order.invoiceNumber,
          Order_Source__c: c.Order_Source__c ? undefined : order.orderSource,
        }));
        linked.push(c.CaseNumber);
      } catch (err) {
        logger.error(`Linking case ${c.Id} to order ${order.id} failed: ${err.message}`);
      }
    }
    return linked;
  }

  const changeLine = (c) => `- ${c.label}: ${c.from ?? '(empty)'} → ${c.to}`;

  // An uploaded invoice (`file` is { data, contentType }). The page sends nothing else, so the customer is found from
  // the invoice: the phone printed on it, and the WhatsApp link sent to that phone or to the matched order's customer.
  // Returns { matched, created, recorded, ... }: matched for an order found, created for an order added from the
  // invoice; an invoice with no order and no phone to reach anyone on is not recorded.
  async function record({ invoice, file }) {
    const invoicePhone = normalizePhone(invoice.phone);
    const contacts = await contactsFor([invoicePhone].filter(Boolean));
    const found = await findOrder(invoice, contacts);
    const orderCustomer = found.order ? await crm.getOrderContact(found.order) : null;
    const link = await findLink([invoicePhone, normalizePhone(orderCustomer?.mobile), normalizePhone(orderCustomer?.phone)]);
    if (link && !contacts.some((c) => [c.mobile, c.phone].some((p) => p && lastTenDigits(p) === lastTenDigits(link.phone)))) {
      contacts.push(...(await contactsFor([link.phone])).filter((c) => !contacts.some((k) => k.id === c.id)));
    }
    const caller = link ? contacts.find((c) => [c.mobile, c.phone].some((p) => p && lastTenDigits(p) === lastTenDigits(link.phone))) || null : null;
    const waiting = link ? await waitingCases(link, caller) : [];
    const sentTo = link
      ? `Upload link sent on WhatsApp to ${link.phone}${link.customerName ? ` for ${link.customerName}` : ''}`
        + `${link.reference ? `; on the call the customer gave ${link.reference}` : ''}.`
      : 'No WhatsApp link from the voice agent was found for the phone on the invoice or the order\'s customer.';

    if (found.order) {
      const order = await updateOrder(found.order.id, invoice, link, contacts);
      const linked = await linkCases(waiting, order);
      const fileId = await attach(file, order.id);
      await note({
        whatId: order.id,
        whoId: order.contactId || caller?.id,
        subject: 'Order updated from the uploaded invoice',
        open: order.problems.length > 0,
        lines: [
          `The customer uploaded an invoice, matched to this order by its ${found.matchedBy}. The order was updated from it.`,
          sentTo,
          ...section('Order:', order.orderChanges.map(changeLine)),
          ...section('Customer:', order.customerChanges.map(changeLine)),
          ...section('Products:', order.productChanges.map((c) => `- ${c}`)),
          order.notesAdded ? 'Everything read from the invoice was added to the order\'s notes.' : null,
          !order.orderChanges.length && !order.customerChanges.length && !order.productChanges.length ? 'The order already matched the invoice.' : null,
          linked.length ? `Requests linked to the order: ${linked.join(', ')}.` : null,
          ...section('Check these:', order.problems.map((p) => `- ${p}`)),
          fileId ? 'The invoice file is attached to the order.' : 'The invoice file could not be attached.',
          '',
          'Read from the invoice:',
          ...invoiceLines(invoice),
        ].filter((line) => line !== null),
      });
      if (link) await closeLink(link, `matched to order ${order.name} by its ${found.matchedBy}; the order was updated from it.`);
      const changed = [...order.orderChanges.map((c) => c.label), ...order.customerChanges.map((c) => c.label), ...order.productChanges];
      return { matched: true, recorded: true, matchedBy: found.matchedBy, orderId: order.id, orderName: order.name, linkedCases: linked, changed };
    }

    const { added, reason } = await addOrder(invoice, link);
    if (added) {
      const linked = await linkCases(waiting, added);
      const fileId = await attach(file, added.id);
      await note({
        whatId: added.id,
        whoId: added.contactId,
        subject: 'Order added from the uploaded invoice',
        open: true,
        lines: [
          'The customer uploaded an invoice that matched no order, so this order was added from it as a Draft. Check it against the attached invoice and activate it.',
          sentTo,
          ...found.notes,
          `Customer: ${added.customer}.`,
          ...section('Products:', added.productChanges.map((c) => `- ${c}`)),
          linked.length ? `Requests linked to the order: ${linked.join(', ')}.` : null,
          ...section('Check these:', added.problems.map((p) => `- ${p}`)),
          fileId ? 'The invoice file is attached to the order.' : 'The invoice file could not be attached.',
          '',
          'Read from the invoice:',
          ...invoiceLines(invoice),
        ].filter((line) => line !== null),
      });
      if (link) await closeLink(link, `no order matched; order ${added.name} was added from it.`);
      return { matched: false, created: true, recorded: true, orderId: added.id, orderName: added.name, linkedCases: linked };
    }

    const phone = link?.phone || invoicePhone;
    if (!phone) return { matched: false, recorded: false };
    const details = [
      'The customer uploaded an invoice on the invoice upload page, and no order could be matched to it.',
      sentTo,
      ...found.notes,
      reason,
      'Find the order, link it to this request and fill in its details from the attached invoice.',
      '',
      'Read from the invoice:',
      ...invoiceLines(invoice),
    ];
    if (waiting.length) {
      const [latest] = waiting;
      await attach(file, latest.Id);
      await note({ whatId: latest.Id, whoId: latest.ContactId || caller?.id, subject: 'Invoice uploaded: order not found', open: true, lines: details });
      await closeLink(link, `no order matched; the invoice is on request ${latest.CaseNumber}.`);
      return { matched: false, recorded: true, caseNumber: latest.CaseNumber };
    }

    const created = await crm.createServiceCase({
      issueType: 'general',
      description: details.join('\n'),
      phone,
      customerName: link?.customerName || invoice.customerName,
      customerOptional: true,
      invoiceNumber: invoice.invoiceNumber,
      orderSource: invoice.platform,
      city: invoice.address.city,
      state: invoice.address.state,
      postalCode: invoice.address.postalCode,
      origin: 'Web',
      capturedBy: 'Registered when the customer uploaded the invoice.',
    });
    if (!created.created) throw new Error(`The request for an unmatched invoice was not saved: ${created.error}`);
    await attach(file, created.caseId);
    if (link) await closeLink(link, `no order matched; the invoice is on new request ${created.caseNumber}.`);
    return { matched: false, recorded: true, caseNumber: created.caseNumber };
  }

  return { linkSent, linkFailed, findLink, record };
}

module.exports = { createInvoiceUploads, invoiceLines, productFor, LINK_SUBJECT };
