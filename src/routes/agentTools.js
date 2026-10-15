const express = require('express');
const { normalizePhone, normalizeIssueType, namesMatch, lastTenDigits } = require('../rules');
const { formatDate, formatDateTime, formatClock, describeWeek, spokenCaseNumber, shortName } = require('../speech');
const { resolveDate, todayInIst, MAX_DAYS_AHEAD } = require('../dates');
const { formatRupees } = require('../crm/orderItems');

const MAX_PRODUCTS_SPOKEN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Call dispositions written by the call-end webhook, as a phrase the agent can say.
const CALL_OUTCOMES = {
  request_registered: 'a service request was registered',
  installation_requested: 'installation was requested',
  order_placed: 'an order was placed',
  details_saved: 'customer details were noted',
  delivery_confirmed: 'the delivery was confirmed',
  delivered_ok: 'the delivery was confirmed',
  issue_reported: 'an issue was reported',
  not_delivered: 'the order had not arrived',
  information_given: 'information was given',
  human_callback: 'a call back was arranged',
  call_back_later: 'the customer asked to be called later',
  wrong_person: 'the customer was not reached',
  not_resolved: 'nothing was resolved',
};

// "302021" as "3 0 2 0 2 1", so the voice reads digits rather than a large number.
const spokenDigits = (value) => String(value || '').replace(/\D/g, '').split('').join(' ');

function callOutcome(disposition) {
  if (!disposition) return 'no outcome recorded';
  if (/^not connected/i.test(disposition)) return 'not answered';
  return CALL_OUTCOMES[disposition] || String(disposition).replace(/_/g, ' ').toLowerCase();
}

// "today at 9 am", "tomorrow at 9 am" or "on Monday, 19 October at 9 am", in India time.
function describeWhen(value, nowMs) {
  const days = Math.round((todayInIst(value) - todayInIst(nowMs)) / DAY_MS);
  return `${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${formatDate(value)}`} at ${formatClock(value)}`;
}

function dateProblem(resolved) {
  if (resolved.reason === 'past') return `${resolved.spoken} has already passed. Ask for a later date.`;
  if (resolved.reason === 'too_far') return `${resolved.spoken} is more than ${Math.round(MAX_DAYS_AHEAD / 30)} months away. Ask for a nearer date.`;
  return 'The date was not understood. Ask for the day and the month, for example 17 October.';
}

function describeOrder({ orderId, products, deliveryStatus, deliveryDate }) {
  const what = `Order ${orderId}${products ? ` for ${products}` : ''}`;
  if (deliveryStatus === 'Delivered') return `${what} was delivered${deliveryDate ? ` on ${formatDate(deliveryDate)}` : ''}.`;
  return `${what} is ${deliveryStatus ? deliveryStatus.toLowerCase() : 'being processed'}.`;
}

function caseSummary(c) {
  const parts = [`Request ${spokenCaseNumber(c.caseNumber)} for ${c.serviceType || 'service'} is ${c.status}.`];
  if (c.visit?.scheduledStart) {
    const tech = shortName(c.visit.technician);
    parts.push(`A service visit is ${c.visit.status ? c.visit.status.toLowerCase() : 'planned'} for ${formatDateTime(c.visit.scheduledStart)}${tech ? ` with technician ${tech}` : ''}.`);
  } else if (c.visit?.status) {
    parts.push(`Service visit status: ${c.visit.status}.`);
  }
  if (c.shipment) {
    const expected = formatDate(c.shipment.expectedDate);
    parts.push(`Replacement part status: ${c.shipment.status}${expected ? `, expected by ${expected}` : ''}.`);
  }
  return parts.join(' ');
}

// Refusals are HTTP 200 so the agent hears the reason; a non-2xx makes Sarvam speak the generic failure line.
function refused(res, message) {
  return res.json({ created: false, case_number: null, message });
}

function caseResponse(res, result, successMessage) {
  if (!result.created) return refused(res, result.error);
  return res.json({
    created: true,
    case_id: result.caseId,
    case_number: result.caseNumber,
    spoken_case_number: spokenCaseNumber(result.caseNumber),
    service_route: result.serviceRoute,
    within_business_hours: result.withinBusinessHours,
    order_verified: result.orderVerified,
    message: `${successMessage(spokenCaseNumber(result.caseNumber))}${result.withinBusinessHours ? '' : ' The service team will follow up on the next working day.'}`,
  });
}

// Endpoints the Sarvam agent calls mid-conversation as API tools.
// Responses are flat, snake_case and include a short `message` the agent can relay.
module.exports = function agentToolsRouter({ crm, now = () => Date.now() }) {
  const router = express.Router();

  // The model does no calendar arithmetic; every spoken date is resolved here, in IST.
  router.post('/resolve-date', (req, res) => {
    const resolved = resolveDate(req.body?.date_text, now());
    if (!resolved.ok) return res.json({ valid: false, date: null, spoken_date: null, message: dateProblem(resolved) });
    return res.json({
      valid: true,
      date: resolved.date,
      spoken_date: resolved.spoken,
      message: `That is ${resolved.isToday ? 'today, ' : ''}${resolved.spoken}. Use ${resolved.date} as the preferred date.`,
    });
  });

  function caseInput(body, issueType) {
    return {
      issueType,
      description: body.description,
      phone: normalizePhone(body.phone),
      customerName: body.customer_name,
      erpOrderId: body.order_id,
      verification: body.verification,
      invoiceNumber: body.invoice_number,
      orderSource: body.order_source,
      partNumber: body.part_number,
      partName: body.part_name,
      quantity: body.quantity,
      productName: body.product_name,
      address: body.address,
      city: body.city,
      state: body.state,
      postalCode: body.postal_code,
      preferredDate: body.preferred_date,
      preferredTime: body.preferred_time,
      useDetailsOnFile: body.use_details_on_file === true || body.use_details_on_file === 'true',
    };
  }

  router.post('/customer-lookup', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const { customer_name: customerName, postal_code: postalCode } = req.body || {};
    let contact;
    if (phone) {
      contact = await crm.findContactByPhone(phone);
      if (!contact) return res.json({ found: false, message: 'No customer record matches this number.' });
    } else if (customerName && postalCode) {
      const match = await crm.findCustomerByNameAndPin(customerName, postalCode);
      if (match.status === 'invalid') {
        return res.json({ found: false, message: 'Without the mobile number, the first and last name and the six digit PIN code are needed.' });
      }
      // Unknown and ambiguous give the same answer, so names cannot be probed.
      if (match.status !== 'found') {
        return res.json({ found: false, message: 'No single customer matches this name and PIN code. Ask for the order id, the invoice number or the request number.' });
      }
      contact = match.contact;
    } else {
      return res.json({ found: false, message: 'The registered mobile number is needed, or the full name with the six digit PIN code.' });
    }

    const orders = contact.accountId ? await crm.findRecentOrdersForAccount(contact.accountId) : [];
    const named = orders.filter((o) => o.erpOrderId);
    // A caller found by name cannot use the request status tool by mobile, so their open requests come with the answer.
    const requests = !phone && contact.accountId ? await crm.getCaseStatus({ accountId: contact.accountId }) : [];
    const orderLine = named.length
      ? `Recent orders: ${named.map((o) => `${o.erpOrderId}, ${o.deliveryStatus ? o.deliveryStatus.toLowerCase() : 'status unknown'}`).join('; ')}.`
      : 'No order id is on record.';
    const requestLine = requests.length
      ? ` Open requests: ${requests.map((c) => `${spokenCaseNumber(c.caseNumber)} for ${c.serviceType || 'service'}, ${c.status}`).join('; ')}.`
      : '';
    return res.json({
      found: true,
      verified_by: phone ? 'mobile' : 'name_and_pin',
      customer_name: contact.name,
      first_name: contact.firstName,
      city: contact.city,
      recent_orders: named.map((o) => `${o.erpOrderId} (${o.deliveryStatus || 'status unknown'})`).join(', '),
      latest_order_id: named[0]?.erpOrderId || null,
      message: phone && named.length
        ? `Customer ${contact.name} found. ${orderLine}`
        : phone
          ? `Customer ${contact.name} found, with no order id on record.`
          : `Customer ${contact.name} found by name and PIN code. ${orderLine}${requestLine}`,
    });
  });

  function orderAnswer(order, lead = '') {
    const spokenId = order.erpOrderId || spokenCaseNumber(order.orderNumber);
    return {
      found: true,
      order_id: order.erpOrderId || null,
      order_number: order.orderNumber || null,
      customer_name: order.accountName,
      delivery_status: order.deliveryStatus,
      delivery_date: order.deliveryDate,
      order_source: order.orderSource,
      products: order.productSummary || '',
      message: `${lead}${describeOrder({ orderId: spokenId, products: order.productSummary, deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate })}`,
    };
  }

  // The order a caller means by an order id, the Salesforce order number of a phone order, or an invoice number.
  // Returns { order }, { problem } to say, or {} when no reference was given.
  async function orderFromReferences(body) {
    const text = (value) => String(value ?? '').trim();
    const phone = normalizePhone(body.phone);
    let invoiceNumber = text(body.invoice_number);
    let references = [text(body.order_id), text(body.order_number)].filter(Boolean);
    // An invoice number said where the order id was expected.
    if (!invoiceNumber) invoiceNumber = references.find((r) => /^inv/i.test(r)) || '';
    references = references.filter((r) => r !== invoiceNumber);
    if (!references.length && !invoiceNumber) return {};

    let found = null;
    for (const reference of references) {
      found = await crm.findOrderByReference(reference);
      if (found) break;
    }
    if (!found && invoiceNumber) {
      let matches = await crm.findOrdersByInvoice(invoiceNumber);
      // One invoice number on several orders: the caller's mobile picks theirs, otherwise the order id is needed.
      if (matches.length > 1 && phone) {
        const contact = await crm.findContactByPhone(phone);
        const own = matches.filter((o) => contact?.accountId && o.accountId === contact.accountId);
        if (own.length) matches = own;
      }
      if (matches.length > 1) return { problem: 'More than one order has this invoice number. Ask for the order id or the order number.' };
      [found] = matches;
    }
    if (!found) return { problem: 'No order matches that number. Ask the customer to read the order id, order number or invoice number again.' };
    return { order: await crm.getOrderById(found.id) || found };
  }

  // Any one reference finds the order and its details are given at once (the business chose no ownership check):
  // the order id, the Salesforce order number of a phone order, or the invoice number. Addresses and phone numbers
  // on the order are never returned here; get_details_on_file gives only the parts needed to confirm them.
  router.post('/order-lookup', async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    const { order, problem } = await orderFromReferences(body);
    if (problem) return res.json({ found: false, message: problem });
    if (order) return res.json(orderAnswer(order));

    if (!phone) {
      return res.json({ found: false, message: 'An order id, order number or invoice number, or the registered mobile number, is needed.' });
    }
    const contact = await crm.findContactByPhone(phone);
    const [latest] = contact?.accountId ? await crm.findRecentOrdersForAccount(contact.accountId, 1) : [];
    if (!latest) return res.json({ found: false, message: 'No order is linked to this phone number. Ask for the order id, order number or invoice number.' });
    return res.json(orderAnswer(await crm.getOrderById(latest.id), 'The latest order on this number: '));
  });

  // The mobile number and address on file for an order (its customer and delivery address) or for a caller's own
  // mobile number, so the agent confirms them instead of asking again. The agent gets only what it needs to confirm:
  // the last four digits of the mobile, and the city, state and PIN code. The full number and the street stay here,
  // and the server fills them into the request when the caller agrees (use_details_on_file).
  router.post('/details-on-file', async (req, res) => {
    const body = req.body || {};
    const { order, problem } = await orderFromReferences(body);
    if (problem) return res.json({ found: false, message: problem });

    let details;
    if (order) {
      details = await crm.getDetailsOnFile({ order });
    } else {
      const phone = normalizePhone(body.phone);
      if (!phone) {
        return res.json({ found: false, message: 'An order id, order number or invoice number, or the registered mobile number, is needed.' });
      }
      const contact = await crm.findContactByPhone(phone);
      if (!contact) {
        return res.json({ found: false, message: 'No customer record matches this number, so nothing is on file. Ask for the address: house, street and area, city and PIN code.' });
      }
      details = await crm.getDetailsOnFile({ contact });
    }

    const ending = details.mobile ? lastTenDigits(details.mobile).slice(-4) : null;
    const hasAddress = Boolean(details.city || details.postalCode);
    const mobilePart = ending ? `the mobile number ending ${spokenDigits(ending)}` : null;
    // "Delhi, Delhi" is said once.
    const where = [...new Map([details.city, details.state].filter(Boolean).map((p) => [p.toLowerCase(), p])).values()].join(', ');
    const addressPart = hasAddress
      ? `the ${order ? 'delivery ' : ''}address${where ? ` in ${where}` : ''}${details.postalCode ? `, PIN code ${spokenDigits(details.postalCode)}` : ''}`
      : null;
    let message;
    if (mobilePart && addressPart) message = `On file: ${mobilePart}, and ${addressPart}. Ask the customer whether to use these for the request.`;
    else if (addressPart) message = `On file: ${addressPart}. No mobile number is on file, so ask for one.`;
    else if (mobilePart) message = `On file: ${mobilePart}. No address is on file, so ask for the house, street and area, the city and the PIN code.`;
    else message = 'No mobile number or address is on file. Ask the customer for both.';

    return res.json({
      found: true,
      source: order ? 'order' : 'customer',
      mobile_on_file: Boolean(ending),
      mobile_ending: ending,
      address_on_file: hasAddress,
      city: details.city,
      state: details.state,
      postal_code: details.postalCode,
      message,
    });
  });

  router.post('/products', async (req, res) => {
    const products = await crm.findProducts(req.body?.query);
    if (!products.length) {
      return res.json({ found: false, products: [], message: 'No Tiffany Designs product matches that. Ask what kind of furniture the customer is looking for.' });
    }
    const spoken = products.slice(0, MAX_PRODUCTS_SPOKEN);
    return res.json({
      found: true,
      products: products.map((p) => ({ name: p.name, product_code: p.productCode, price: p.unitPrice })),
      message: `${spoken.map((p) => `${p.name}, code ${p.productCode}, list price ${formatRupees(p.unitPrice)}`).join('; ')}.`
        + (products.length > spoken.length ? ` ${products.length - spoken.length} more products match; ask the customer to be more specific.` : ''),
    });
  });

  router.post('/orders', async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    if (!phone || !/^\+91[6-9]\d{9}$/.test(phone)) {
      return res.json({ created: false, order_number: null, message: 'A valid 10 digit Indian mobile number is needed to place the order.' });
    }
    const result = await crm.createOrder({
      customerName: body.customer_name,
      phone,
      items: body.items,
      address: body.address,
      city: body.city,
      state: body.state,
      postalCode: body.postal_code,
      notes: body.notes,
    });
    if (!result.created) return res.json({ created: false, order_number: null, message: result.error });

    const spokenNumber = spokenCaseNumber(result.orderNumber);
    const lines = result.lines.map((l) => `${l.quantity} ${l.name}`).join(', ');
    return res.json({
      created: true,
      order_id: result.orderId,
      order_number: result.orderNumber,
      spoken_order_number: spokenNumber,
      total: result.total,
      message: `Order ${spokenNumber} is placed for ${lines}, total list price ${formatRupees(result.total)}. `
        + 'The sales team will call to confirm the final price, delivery and payment.',
    });
  });

  router.post('/part-lookup', async (req, res) => {
    const { order_id: orderId, product_name: productName } = req.body || {};
    if (!orderId && !productName) {
      return res.json({ found: false, message: 'An order id or a product name is required.' });
    }
    const parts = await crm.findParts({ erpOrderId: orderId, productName });
    if (!parts.length) {
      return res.json({ found: false, message: 'No part list is on record for this product. Record the part as the customer describes it.' });
    }
    return res.json({
      found: true,
      parts: parts.map((p) => ({ name: p.name, part_number: p.partNumber, product: p.productName })),
      message: `Parts on record: ${parts.map((p) => `${p.name} of the ${p.productName}, part number ${p.partNumber}`).join('; ')}.`,
    });
  });

  router.post('/cases', async (req, res) => {
    const issueType = normalizeIssueType(req.body?.issue_type);
    if (!issueType) return refused(res, 'The issue type is not recognised.');
    if (!req.body.description) {
      return refused(res, 'A short description of the issue is required.');
    }
    const result = await crm.createServiceCase(caseInput(req.body, issueType));
    return caseResponse(res, result, (n) => `Service request ${n} is registered.`);
  });

  router.post('/installation', async (req, res) => {
    if (!req.body?.preferred_date) {
      return refused(res, 'A preferred installation date is required.');
    }
    const resolved = resolveDate(req.body.preferred_date, now());
    if (!resolved.ok) return refused(res, dateProblem(resolved));

    const reschedule = req.body.reschedule === true || req.body.reschedule === 'true';
    const result = await crm.createServiceCase(caseInput(
      {
        description: reschedule
          ? `Customer asked to reschedule installation${req.body.existing_case_number ? ` for request ${req.body.existing_case_number}` : ''}.`
          : 'Customer requested installation.',
        ...req.body,
        preferred_date: resolved.date,
      },
      reschedule ? 'installation_reschedule' : 'installation',
    ));
    const slot = [resolved.spoken, req.body.preferred_time].filter(Boolean).join(', ');
    return caseResponse(res, result, (n) => `Installation request ${n} is registered with a preferred slot of ${slot}. The service team confirms the appointment.`);
  });

  router.post('/escalate', async (req, res) => {
    const result = await crm.createServiceCase(caseInput(
      { ...req.body, description: `Reason: ${req.body?.reason || 'not stated'}` },
      'escalation',
    ));
    return caseResponse(res, result, (n) => `Request ${n} is flagged for a service team member to call back.`);
  });

  router.post('/case-status', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const { case_number: caseNumber, customer_name: customerName, order_id: orderId } = req.body || {};
    let own;
    if (phone) {
      const contact = await crm.findContactByPhone(phone);
      if (!contact?.accountId) return res.json({ found: false, message: 'No customer record matches this number.' });
      const cases = await crm.getCaseStatus(caseNumber ? { caseNumber } : { accountId: contact.accountId });
      own = cases.filter((c) => c.accountId === contact.accountId);
      if (!own.length) return res.json({ found: false, message: 'No open service request was found for this customer.' });
    } else {
      // Without the mobile: the request number, plus the full name on the request or the order id it is about.
      if (!caseNumber || (!customerName && !orderId)) {
        return res.json({ found: false, message: 'The registered mobile number is needed, or the request number with the full name or the order id.' });
      }
      const orderRef = String(orderId || '').trim().toLowerCase();
      const cases = await crm.getCaseStatus({ caseNumber });
      own = cases.filter((c) => (customerName && (namesMatch(customerName, c.contactName) || namesMatch(customerName, c.accountName)))
        || (orderRef && String(c.erpOrderId || '').toLowerCase() === orderRef));
      if (!own.length) return res.json({ found: false, message: 'No request matches these details.' });
    }

    return res.json({
      found: true,
      case_number: own[0].caseNumber,
      status: own[0].status,
      open_requests: own.length,
      message: own.map(caseSummary).join(' '),
    });
  });

  // Module 2: whether the service team is working now, and when it is back, from Salesforce business hours and holidays.
  router.post('/service-hours', async (req, res) => {
    const hours = await crm.getServiceHours();
    const week = describeWeek(hours.weekly);
    const weekLine = week ? ` Service hours are ${week}.` : '';
    if (hours.open) {
      return res.json({
        open: true,
        closes_at: hours.closesAt,
        next_open: null,
        hours: week || null,
        message: hours.closesAt ? `The service team is available now, until ${formatClock(hours.closesAt)} today.${weekLine}` : 'The service team is available now.',
      });
    }
    const closed = hours.holidayName ? `The service team is closed today for ${hours.holidayName}.` : 'The service team is closed now.';
    const reopens = hours.opensAt
      ? ` It opens again ${describeWhen(hours.opensAt, now())}, and requests registered now are followed up then.`
      : ' Requests registered now are followed up when it reopens.';
    return res.json({ open: false, closes_at: null, next_open: hours.opensAt, hours: week || null, message: `${closed}${reopens}${weekLine}` });
  });

  // Module 9: who serves a location, by the same rules Salesforce uses to route the case.
  router.post('/service-area', async (req, res) => {
    const area = await crm.checkServiceArea({ city: req.body?.city, postalCode: req.body?.postal_code });
    if (!area.valid) {
      return res.json({
        valid: false,
        route: null,
        message: area.reason === 'pin' ? 'That PIN code is not valid. Ask for the six digit PIN code.' : 'The city or the six digit PIN code is needed.',
      });
    }
    const place = [area.city, area.postalCode && `PIN ${area.postalCode}`].filter(Boolean).join(', ');
    return res.json({
      valid: true,
      route: area.route,
      message: area.route === 'Internal'
        ? `${place} is within the Delhi NCR service area, so the Tiffany Designs service team handles it.`
        : `${place} is outside the Delhi NCR service area, so an authorised service partner handles it.`,
    });
  });

  // Module 3: saves a new customer; changes for an existing customer go to the service team to confirm.
  router.post('/customer', async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    if (!phone || !/^\+91[6-9]\d{9}$/.test(phone)) {
      return res.json({ saved: false, new_customer: null, message: 'A valid 10 digit Indian mobile number is needed.' });
    }
    const result = await crm.saveCustomerDetails({
      customerName: body.customer_name,
      phone,
      email: body.email,
      alternatePhone: body.alternate_phone,
      address: body.address,
      city: body.city,
      state: body.state,
      postalCode: body.postal_code,
    });
    if (!result.saved) return res.json({ saved: false, new_customer: null, message: result.error });
    return res.json({
      saved: true,
      new_customer: result.newCustomer,
      message: result.newCustomer
        ? `The details are saved for ${result.name}.`
        : 'The details are noted for the service team, who will check them with the customer before updating the record.',
    });
  });

  // Module 14: the customer's recent requests, closed ones included, and their recent calls.
  router.post('/history', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.json({ found: false, message: 'A valid phone number is required.' });
    const contact = await crm.findContactByPhone(phone);
    if (!contact) return res.json({ found: false, message: 'No customer record matches this number.' });

    const history = await crm.getServiceHistory({ accountId: contact.accountId, contactId: contact.id });
    if (!history.cases.length && !history.calls.length) {
      return res.json({ found: false, message: 'No earlier requests or calls are on record for this number.' });
    }
    const requests = history.cases.map((c) => `request ${spokenCaseNumber(c.caseNumber)} for ${c.serviceType || 'service'}`
      + `${c.subType ? `, ${c.subType.toLowerCase()}` : ''}, opened ${formatDate(c.createdDate)}, ${c.closed ? 'closed' : `status ${c.status}`}`);
    const calls = history.calls.map((c) => `${formatDate(c.date)}, ${c.direction ? `${c.direction.toLowerCase()} call` : 'call'}, ${callOutcome(c.outcome)}`);
    return res.json({
      found: true,
      open_requests: history.cases.filter((c) => !c.closed).length,
      message: [
        requests.length ? `Recent requests: ${requests.join('; ')}.` : 'No earlier requests.',
        calls.length ? `Recent calls: ${calls.join('; ')}.` : null,
      ].filter(Boolean).join(' '),
    });
  });

  return router;
};
