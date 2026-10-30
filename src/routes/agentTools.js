const express = require('express');
const {
  normalizePhone, normalizeIssueType, namesMatch, lastTenDigits, phoneEnding, numberToConfirm, sameReference,
} = require('../rules');
const { formatDate, formatDateTime, formatClock, describeWeek, spokenCaseNumber, shortName } = require('../speech');
const { resolveDate, todayInIst, MAX_DAYS_AHEAD } = require('../dates');
const { checkInstallationDay, checkInstallationSlot, INSTALLATION_HOURS } = require('../installationSlots');
const { formatRupees } = require('../crm/orderItems');
const { guideMessage, assemblyStepCount } = require('../crm/productGuides');
const { findOrderFromReferences } = require('../crm/crm');
const { welcomeLine } = require('../callFlows');

const MAX_PRODUCTS_SPOKEN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;
const LATE = Symbol('late');

// The promise's value, or LATE once `deadline` (epoch ms) has passed. A promise that loses keeps running; its failure
// is not left unhandled.
function byDeadline(promise, deadline) {
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), LATE); });
  return Promise.race([settled, late]).then((result) => {
    clearTimeout(timer);
    if (result === LATE) return LATE;
    if (result.error) throw result.error;
    return result.value;
  });
}

// What a tool answers when Salesforce or another service fails mid-call: the fields the agent saves to variables,
// empty, and what to do next. Tools that register something say nothing was registered, so the retry is safe.
const UNANSWERED = {
  '/resolve-date': { valid: false, date: null, spoken_date: null, time: null },
  '/cases': { created: false, case_number: null },
  '/installation': { created: false, case_number: null },
  '/escalate': { created: false, case_number: null },
  '/orders': { created: false, order_number: null },
  '/invoice-upload-link': { sent: false },
  '/invoice-upload-status': { uploaded: null },
  '/customer': { saved: false, new_customer: null },
  '/service-area': { valid: false, route: null },
  '/service-hours': { open: null, next_open: null },
};
const REGISTERING = ['/cases', '/installation', '/escalate', '/orders', '/customer'];
const AFTER_SECOND_FAILURE = {
  '/orders': 'call tool:request_human_callback with the confirmed products, their quantities and the delivery city.',
  '/invoice-upload-status': 'ask for the invoice number printed on the invoice and call tool:find_order with it.',
};

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

// The kinds of request compared before a new one is registered on an order (crm requestKind), as the agent says them.
const REQUEST_KINDS = {
  installation: 'an installation request',
  installation_followup: 'an installation follow-up request',
  damage: 'a request about a damaged, defective or missing part',
  replacement: 'a replacement or return request',
};

// Where the number a record would be saved with comes from (rules numberToConfirm), as the agent says it back.
const NUMBER_SOURCES = {
  call: 'the number of this call',
  given: 'the number the customer gave',
  file: 'the mobile number on file',
};

const CALLING_NUMBER_UNKNOWN = 'Nothing is saved yet: the number of this call is not known. Ask the customer for the 10 digit mobile '
  + 'number, read it back in two groups of five digits, and call this tool again with it as phone, use_calling_number set to false '
  + 'and its last four digits as contact_number_ending.';

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const isTrue = (value) => value === true || value === 'true';

// "302021" as "3 0 2 0 2 1", so the voice reads digits rather than a large number.
const spokenDigits = (value) => String(value || '').replace(/\D/g, '').split('').join(' ');

// " in Jaipur, Rajasthan, PIN code 3 0 2 0 2 1": the parts of an address on file the agent may say. "Delhi, Delhi" is
// said once, and the street never.
function placeWords({ city, state, postalCode }) {
  const where = [...new Map([city, state].filter(Boolean).map((p) => [p.toLowerCase(), p])).values()].join(', ');
  return `${where ? ` in ${where}` : ''}${postalCode ? `, PIN code ${spokenDigits(postalCode)}` : ''}`;
}

// The number a request, an order or a customer is saved with: the number of this call when the customer asks for it
// (use_calling_number; it comes from caller_phone, so the agent never says or types those digits), else the number the
// agent passes. `unknown` when the customer asked for the number of this call and the call has none.
function chosenPhone(body) {
  if (!isTrue(body.use_calling_number)) return { phone: normalizePhone(body.phone) };
  const caller = normalizePhone(body.caller_phone);
  return caller ? { phone: caller } : { unknown: true };
}

// What the agent hears when the customer has not agreed to the number a record would be saved with: that number by its
// last four digits, to say back and confirm before calling the tool again. `what` names the record, as "this order".
function confirmNumberMessage({ ending, source, confirmed }, what) {
  return `Nothing is saved yet: the customer has not confirmed the mobile number for ${what}. It would be ${NUMBER_SOURCES[source]}, `
    + `ending ${spokenDigits(ending)}${confirmed ? `, not the number ending ${spokenDigits(confirmed)}` : ''}. Say that back to the `
    + `customer and ask whether to use it. When the customer agrees, call this tool again with the same details and contact_number_ending ${ending}. `
    + (source === 'call' ? '' : 'When the customer wants the number of this call, call it again with use_calling_number set to true. ')
    + 'When the customer wants another number, ask for the 10 digit number, read it back in two groups of five digits, and call this '
    + 'tool again with it as phone, use_calling_number set to false and its last four digits as contact_number_ending.';
}

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

// The open requests on an order, one of each kind, so the agent can ask before registering the same kind again. The
// request numbers are left out: with the order id they would unlock request details without the mobile number.
function openRequestsLine(requests) {
  const kinds = new Set();
  const newestOfKind = requests.filter((r) => !kinds.has(r.kind) && kinds.add(r.kind));
  if (!newestOfKind.length) return '';
  const listed = newestOfKind.map((r) => `${REQUEST_KINDS[r.kind]}, registered on ${formatDate(r.createdDate)}`).join('; ');
  return ` Open requests on this order: ${listed}. Before registering another request of the same kind, ask whether the customer wants an update on it or a new request.`;
}

// Refusals are HTTP 200 so the agent hears the reason; a non-2xx makes Sarvam speak the generic failure line.
function refused(res, message) {
  return res.json({ created: false, case_number: null, message });
}

function caseResponse(res, result, successMessage, extra = {}) {
  if (result.existingRequest) {
    const open = result.existingRequest;
    return res.json({
      created: false,
      case_number: null,
      existing_request: true,
      message: `${capitalized(REQUEST_KINDS[open.kind])} for this order is already open, registered on ${formatDate(open.createdDate)}. `
        + 'Ask the customer whether they want an update on that request or a new request. For a new request, call this tool again with new_request set to true.',
    });
  }
  if (result.numberToConfirm) return refused(res, confirmNumberMessage(result.numberToConfirm, 'this request'));
  if (!result.created) return refused(res, result.error);
  const reached = result.contactNumberEnding ? ` The service team will call the number ending ${spokenDigits(result.contactNumberEnding)}.` : '';
  return res.json({
    created: true,
    case_id: result.caseId,
    case_number: result.caseNumber,
    spoken_case_number: spokenCaseNumber(result.caseNumber),
    service_route: result.serviceRoute,
    within_business_hours: result.withinBusinessHours,
    order_verified: result.orderVerified,
    contact_number_ending: result.contactNumberEnding || null,
    ...extra,
    message: `${successMessage(spokenCaseNumber(result.caseNumber))}${reached}${result.withinBusinessHours ? '' : ' The service team will follow up on the next working day.'}`,
  });
}

// Endpoints the Sarvam agent calls mid-conversation as API tools.
// Responses are flat, snake_case and include a short `message` the agent can relay, with what to ask next when
// something is missing. Every answer is HTTP 200, failures included (see UNANSWERED).
// `invoiceLinks` (src/invoiceLinks.js) sends invoice upload links; without it the link tool says none can be sent.
// `invoiceUploads` (src/crm/invoiceUploads.js) says what became of an uploaded invoice while the caller is on the call.
// `callStartBudgetMs` is how long the call-start lookup may take, since the greeting waits for it.
module.exports = function agentToolsRouter({
  crm, invoiceLinks, invoiceUploads, productGuides, callStartBudgetMs = 1000, now = () => Date.now(), logger = console,
}) {
  const router = express.Router();

  // Runs as the call starts (the agent's on-start tool), before the greeting. On a phone call Sarvam sends the number
  // the customer is calling from; it becomes customer_phone, so the agent never asks for it, and a customer on record
  // is greeted by first name. Outbound calls and website calls already carry these, and keep what they have. It answers
  // with every variable it is given back, so a failed lookup leaves the call as it was.
  // The greeting is spoken only after this answers, so the lookup has `callStartBudgetMs`: when Salesforce is slower,
  // the answer goes without what is not known yet (caller_details empty), and the agent looks the caller up with
  // find_customer on its first reply instead (Phase 4 step 1).
  router.post('/call-start', async (req, res) => {
    const deadline = Date.now() + callStartBudgetMs;
    const body = req.body || {};
    const given = {
      customer_phone: String(body.customer_phone || ''),
      customer_name: String(body.customer_name || ''),
      opening_line: String(body.opening_line || ''),
    };
    const inbound = !body.call_reason || body.call_reason === 'inbound';
    // Sarvam's caller identifier is the phone number on a phone call ("07357558134") and an email in its own test chat.
    const callerIsPhone = !body.caller_type || body.caller_type === 'phone_number';
    const caller = [body.customer_phone, callerIsPhone ? body.caller_phone : null]
      .map(normalizePhone).find((p) => p && INDIAN_MOBILE.test(p));
    if (!inbound || !caller) return res.json({ ...given, caller_details: '', known_customer: false });

    // What is on record for the number, so the agent starts the call knowing it and never asks for the number.
    const number = `The number for this call, ending ${spokenDigits(lastTenDigits(caller).slice(-4))},`;
    let firstName = null;
    let details = `${number} is not on record as a customer.`;
    try {
      const contact = await byDeadline(crm.findContactByPhone(caller), deadline);
      if (contact === LATE) {
        logger.warn(`The caller lookup at call start took over ${callStartBudgetMs} ms; the agent looks the caller up on its first reply.`);
        details = '';
      } else if (contact) {
        firstName = contact.firstName || String(contact.name || '').trim().split(/\s+/)[0] || null;
        const records = await byDeadline(recordsOf(contact), deadline);
        const owner = contact.name ? `is registered to ${contact.name}` : 'is on record with no name saved, so ask for the full name before registering anything';
        if (records === LATE) logger.warn(`The caller's orders and requests took over ${callStartBudgetMs} ms at call start; the agent looks them up on its first reply.`);
        details = records === LATE ? '' : `${number} ${owner}. ${records.orderLine}${records.requestLine}`;
      }
    } catch (err) {
      logger.error(`Looking up the caller at call start failed: ${err.message}`);
      details = '';
    }
    return res.json({
      customer_phone: caller,
      customer_name: given.customer_name || firstName || '',
      opening_line: firstName ? welcomeLine(firstName) : given.opening_line,
      caller_details: details,
      known_customer: Boolean(firstName),
    });
  });

  // The model does no calendar arithmetic; every spoken date is resolved here, in IST. The dates are installation
  // dates, so the visiting days and hours apply (src/installationSlots.js); with `time_text` the time is checked too.
  router.post('/resolve-date', (req, res) => {
    const body = req.body || {};
    const refuse = (message) => res.json({ valid: false, date: null, spoken_date: null, time: null, message });
    const resolved = resolveDate(body.date_text, now());
    if (!resolved.ok) return refuse(dateProblem(resolved));
    const day = checkInstallationDay(resolved.date, now());
    if (!day.ok) return refuse(day.message);
    const that = `That is ${resolved.isToday ? 'today, ' : ''}${resolved.spoken}`;
    const timeText = body.time_text ?? body.preferred_time;
    if (!String(timeText ?? '').trim()) {
      return res.json({
        valid: true,
        date: resolved.date,
        spoken_date: resolved.spoken,
        time: null,
        message: `${that}. ${day.note || `Installation visits are ${INSTALLATION_HOURS}.`} Use ${resolved.date} as the preferred date.`,
      });
    }
    const slot = checkInstallationSlot(resolved.date, timeText, now());
    if (!slot.ok) return refuse(slot.message);
    return res.json({
      valid: true,
      date: resolved.date,
      spoken_date: resolved.spoken,
      time: slot.text,
      message: `${that}, ${slot.spoken}. Use ${resolved.date} as the preferred date and ${slot.text} as the preferred time.`,
    });
  });

  function caseInput(body, issueType) {
    return {
      issueType,
      description: body.description,
      phone: chosenPhone(body).phone,
      customerName: body.customer_name,
      erpOrderId: body.order_id,
      orderNumber: body.order_number,
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
      // The number the caller confirmed the order with in find_order, and the number of the call (agent variables).
      orderPhone: normalizePhone(body.order_phone),
      callerPhone: normalizePhone(body.caller_phone),
      // The last four digits of the number the customer agreed to; nothing is saved on another number.
      numberEnding: body.contact_number_ending,
      confirmNumber: true,
      useDetailsOnFile: body.use_details_on_file === true || body.use_details_on_file === 'true',
      newRequest: body.new_request === true || body.new_request === 'true',
      atDeliveryAddress: body.at_delivery_address === true || body.at_delivery_address === 'true',
    };
  }

  // A customer's recent orders and open requests, as the agent hears them; the open requests come with every answer,
  // so the agent knows them before asking about the concern.
  async function recordsOf(contact) {
    const [orders, requests] = contact.accountId
      ? await Promise.all([crm.findRecentOrdersForAccount(contact.accountId), crm.getCaseStatus({ accountId: contact.accountId })])
      : [[], []];
    const named = orders.filter((o) => o.erpOrderId);
    const orderLine = named.length
      ? `Recent orders: ${named.map((o) => `${o.erpOrderId}, ${o.deliveryStatus ? o.deliveryStatus.toLowerCase() : 'status unknown'}`).join('; ')}.`
      : 'No order id is on record.';
    const requestLine = requests.length
      ? ` Open requests: ${requests.map((c) => `${spokenCaseNumber(c.caseNumber)} for ${c.serviceType || 'service'}, ${c.status}`).join('; ')}.`
      : '';
    return { named, requests, orderLine, requestLine };
  }

  router.post('/customer-lookup', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const { customer_name: customerName, postal_code: postalCode } = req.body || {};
    let contact;
    if (phone) {
      contact = await crm.findContactByPhone(phone);
      if (!contact) {
        return res.json({
          found: false,
          message: 'No customer record matches this number. Carry on without saying so, and ask for the order id, order number or invoice number when the concern needs an order.',
        });
      }
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

    const { named, requests, orderLine, requestLine } = await recordsOf(contact);
    const firstName = contact.firstName || String(contact.name || '').trim().split(/\s+/)[0] || null;
    return res.json({
      found: true,
      verified_by: phone ? 'mobile' : 'name_and_pin',
      customer_name: contact.name,
      first_name: firstName,
      city: contact.city,
      recent_orders: named.map((o) => `${o.erpOrderId} (${o.deliveryStatus || 'status unknown'})`).join(', '),
      latest_order_id: named[0]?.erpOrderId || null,
      open_requests: requests.length,
      message: !contact.name
        ? `A customer record with no name saved is on this number; ask for the full name before registering anything. ${orderLine}${requestLine}`
        : phone
          ? `Customer ${contact.name} found; first name ${firstName}. ${orderLine}${requestLine}`
          : `Customer ${contact.name} found by name and PIN code. ${orderLine}${requestLine}`,
    });
  });

  // The numbers a caller has given for an order: the mobile number passed to the tool, the number the caller said the
  // order was placed with (order_phone, which find_order saves to the agent variable of that name), and the number of
  // the call (caller_phone, from customer_phone).
  const numbersGiven = (body) => [body.phone, body.order_phone, body.caller_phone];

  // What the agent hears about an order it may not share yet: an order matches, and how to confirm it as the caller's.
  function unconfirmed(check, body) {
    if (!check.onRecord) {
      return "An order matches, but no mobile number is on record for it, so it cannot be confirmed as the customer's and nothing "
        + 'about it can be shared. Offer to send the WhatsApp link to upload the invoice: the order is completed from it, and once '
        + 'the customer has uploaded it, on this call or before calling again, the concern can be resolved.';
    }
    if (normalizePhone(body.order_phone)) {
      return 'The number the customer gave is not the mobile number this order was placed with, so nothing about the order can be '
        + 'shared. Ask the customer to check the number and say it once more, and call this tool again with it as order_phone. When it '
        + 'does not match again, say the order details can be shared only with the number it was placed with, and offer a call back '
        + 'from the service team.';
    }
    return `An order matches${numbersGiven(body).some((p) => normalizePhone(p)) ? ', but not with the number for this call' : ''}. `
      + 'Before saying anything about the order, ask the customer which mobile number the order was placed with. Then call '
      + 'tool:find_order again with the same order reference and that number as order_phone.';
  }

  // Lookups that give what is on file for an order give it only for a confirmed order, like find_order.
  function notConfirmed(check) {
    return check.onRecord
      ? "This order is not confirmed as the customer's yet, so nothing on file for it can be shared. Ask which mobile number the "
        + 'order was placed with and call tool:find_order with the order reference and that number as order_phone; once it is '
        + 'confirmed, call this tool again.'
      : "No mobile number is on record for this order, so it cannot be confirmed as the customer's. Offer the WhatsApp link to upload the invoice.";
  }

  // An order the service team can act on has its customer's mobile number and a delivery address it can visit (a
  // street, and a city or PIN code). When either is missing, the agent offers the invoice upload link, whose upload
  // fills them in on the order (src/crm/invoiceUploads.js). `confirmedPhone` is the number that confirmed the order.
  async function orderAnswer(order, confirmedPhone, lead = '') {
    const spokenId = order.erpOrderId || spokenCaseNumber(order.orderNumber);
    const [openRequests, details] = await Promise.all([crm.getOpenRequests(order.id), crm.getDetailsOnFile({ order })]);
    const hasMobile = Boolean(details.mobile);
    const hasAddress = Boolean(order.street && (order.city || order.postalCode));
    const missing = [!hasMobile && 'mobile number', !hasAddress && 'delivery address'].filter(Boolean);
    return {
      found: true,
      number_confirmed: true,
      order_phone: confirmedPhone,
      order_id: order.erpOrderId || null,
      order_number: order.orderNumber || null,
      customer_name: order.accountName,
      delivery_status: order.deliveryStatus,
      delivery_date: order.deliveryDate,
      order_source: order.orderSource,
      products: order.productSummary || '',
      open_requests: [...new Set(openRequests.map((r) => r.kind))],
      mobile_on_order: hasMobile,
      address_on_order: hasAddress,
      details_missing: missing.length > 0,
      message: `${lead}${describeOrder({ orderId: spokenId, products: order.productSummary, deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate })}`
        + openRequestsLine(openRequests)
        + (missing.length
          ? ` The order has no ${missing.join(' and no ')} on record. After answering what the customer asked, offer to send a WhatsApp link `
            + 'to upload the invoice, so the order can be completed before any request is registered.'
          : ''),
    };
  }

  // The order a caller means by an order id, the Salesforce order number of a phone order, or an invoice number.
  // Returns { order }, { problem } to say, or {} when no reference was given. The request tools find it the same way.
  function orderFromReferences(body) {
    return findOrderFromReferences(crm, {
      orderId: body.order_id, orderNumber: body.order_number, invoiceNumber: body.invoice_number, phone: normalizePhone(body.phone),
    });
  }

  // Any one reference finds the order: the order id, the Salesforce order number of a phone order, or the invoice
  // number. Its details are given only once a number the caller gives (the number of the call, or the number the
  // caller says the order was placed with, as order_phone) is a mobile on the order's customer record; until then the
  // agent hears only that an order matches and asks for that number. The confirmed number comes back as order_phone,
  // which the agent saves for the other tools. Addresses and phone numbers on the order are never returned here;
  // get_details_on_file gives only the parts needed to confirm them.
  router.post('/order-lookup', async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    const { order, problem, notFound } = await orderFromReferences(body);
    if (problem) {
      return res.json({
        found: false,
        message: notFound
          ? `${problem} When it finds nothing again, tell the customer the order could not be found and offer to send a link on WhatsApp `
            + 'to upload a photo, screenshot or PDF of the invoice.'
          : problem,
      });
    }
    if (order) {
      const check = await crm.confirmOrderNumber(order, numbersGiven(body));
      if (check.confirmed) return res.json(await orderAnswer(order, check.phone));
      // No order_phone, so a number the caller confirmed for another order in this call stays saved.
      return res.json({
        found: true,
        number_confirmed: false,
        mobile_on_order: check.onRecord,
        address_on_order: null,
        details_missing: !check.onRecord,
        message: unconfirmed(check, body),
      });
    }

    if (!phone) {
      return res.json({ found: false, message: 'An order id, order number or invoice number, or the registered mobile number, is needed.' });
    }
    // The latest order of the customer this number belongs to, so the number confirms it.
    const contact = await crm.findContactByPhone(phone);
    const [latest] = contact?.accountId ? await crm.findRecentOrdersForAccount(contact.accountId, 1) : [];
    if (!latest) {
      return res.json({
        found: false,
        message: 'No order is linked to this phone number. Ask for the order id, order number or invoice number. When the customer has '
          + 'none of them, or they find nothing either, tell the customer the order could not be found and offer to send a link on '
          + 'WhatsApp to upload a photo, screenshot or PDF of the invoice.',
      });
    }
    return res.json(await orderAnswer(await crm.getOrderById(latest.id), phone, 'The latest order on this number: '));
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
      const check = await crm.confirmOrderNumber(order, numbersGiven(body));
      if (!check.confirmed) return res.json({ found: false, message: notConfirmed(check) });
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
    const addressPart = hasAddress ? `the ${order ? 'delivery ' : ''}address${placeWords(details)}` : null;
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

  // Where to install: the address the order was delivered to (the customer's address on file when the order has
  // none), so the agent asks the caller whether to install there or somewhere else, and the mobile number on file to
  // confirm after that. As with get_details_on_file, only the city, state, PIN code and the mobile's last four digits
  // are given; book_installation fills in the full address when the caller chooses it (at_delivery_address).
  router.post('/installation-address', async (req, res) => {
    const body = req.body || {};
    const { order, problem } = await orderFromReferences(body);
    if (problem) return res.json({ found: false, message: problem });
    if (!order) {
      return res.json({ found: false, message: 'The order id, order number or invoice number is needed to find where the order was delivered.' });
    }
    const check = await crm.confirmOrderNumber(order, numbersGiven(body));
    if (!check.confirmed) return res.json({ found: false, message: notConfirmed(check) });

    const details = await crm.getDetailsOnFile({ order });
    const source = order.city || order.postalCode ? 'delivery' : details.city || details.postalCode ? 'customer' : null;
    const ending = details.mobile ? lastTenDigits(details.mobile).slice(-4) : null;
    const delivered = order.deliveryStatus === 'Delivered';
    const name = order.erpOrderId || spokenCaseNumber(order.orderNumber);
    const ask = 'Ask the customer whether the installation should be at this address or somewhere else.';
    const address = {
      delivery: `Order ${name} ${delivered ? 'was delivered' : 'is to be delivered'} to the address${placeWords(details)}. ${ask}`,
      customer: `Order ${name} has no delivery address on record. The customer's address on file is${placeWords(details)}. ${ask}`,
    }[source] || `No address is on record for order ${name}. Ask where the installation should be: the house, street and area, then the city, then the six digit PIN code.`;
    const mobile = ending
      ? ` After that, ask whether to use the mobile number ending ${spokenDigits(ending)}.`
      : ' No mobile number is on file, so ask for one after that.';

    return res.json({
      found: true,
      order_id: order.erpOrderId || null,
      delivered,
      address_source: source,
      city: source ? details.city : null,
      state: source ? details.state : null,
      postal_code: source ? details.postalCode : null,
      mobile_on_file: Boolean(ending),
      mobile_ending: ending,
      message: `${address}${mobile}`,
    });
  });

  // When no order can be found for a caller, the agent offers a link to upload a photo or screenshot of the invoice,
  // sent on WhatsApp. The upload page checks the invoice is Tiffany Designs', finds the order or adds it from the
  // invoice, and links the caller's requests to it.
  router.post('/invoice-upload-link', async (req, res) => {
    const body = req.body || {};

    console.log('invoice-upload-link', body);
    const { phone, unknown } = chosenPhone(body);
    if (unknown) {
      return res.json({ sent: false, message: 'The number of this call is not known. Ask for the 10 digit WhatsApp number, read it back in two groups of five digits, and call this tool again with it as phone.' });
    }
    if (!phone || !/^\+91[6-9]\d{9}$/.test(phone)) {
      return res.json({ sent: false, message: 'A valid 10 digit Indian mobile number that is on WhatsApp is needed. Ask for it.' });
    }
    const result = invoiceLinks
      ? await invoiceLinks.send({ phone, customerName: body.customer_name, reference: body.order_reference })
      : { sent: false, reason: 'unavailable' };
    if (result.sent) {
      return res.json({
        sent: true,
        message: `The upload link is sent on WhatsApp to the number ending ${spokenDigits(result.ending)}. Tell the customer to open it and upload `
          + 'a clear photo, screenshot or PDF of the Tiffany Designs invoice; the service system then finds the order, or adds it when it is '
          + 'not on record, with the details on the invoice. Ask whether the customer wants to upload it now while staying on the call. Once '
          + 'the customer says it is uploaded, call tool:check_invoice_upload with this WhatsApp number. A customer who uploads it later calls '
          + 'again once it is uploaded, so the concern can be resolved.',
      });
    }
    return res.json({
      sent: false,
      message: result.reason === 'limited'
        ? 'Links were already sent to this number today. Ask the customer to use the link already on WhatsApp. Once the customer says the '
          + 'invoice is uploaded, call tool:check_invoice_upload with this number; a customer who uploads it later calls again once it is uploaded.'
        : 'The WhatsApp link cannot be sent right now. Register no installation, damage or replacement request without the order: offer a call back '
          + 'from the service team instead, with the order id, invoice number and product the customer gave in the reason.',
    });
  });

  // Once the caller says the invoice is uploaded (on the call the link was sent in, or a later one), what became of the
  // newest link sent to the WhatsApp number or the number of the call: the order the invoice was matched to or added
  // as, so the agent finds it with find_order and carries on with the concern; why it was refused; or the request it
  // went to the service team on. Only the order's reference is given: find_order confirms the order as the caller's
  // before anything about it is said.
  router.post('/invoice-upload-status', async (req, res) => {
    const body = req.body || {};
    const byInvoiceNumber = 'ask for the invoice number printed on the invoice and call tool:find_order with it.';
    if (!invoiceUploads) return res.json({ uploaded: null, message: `Uploads cannot be checked right now, so ${byInvoiceNumber}` });
    const phones = [body.phone, body.caller_phone].map(normalizePhone).filter((p) => p && INDIAN_MOBILE.test(p));
    if (!phones.length) {
      return res.json({ uploaded: null, message: 'The 10 digit WhatsApp number the upload link was sent to is needed. Ask for it.' });
    }

    const status = await invoiceUploads.uploadStatus(phones);
    if (!status.sent) {
      return res.json({
        link_sent: false,
        uploaded: false,
        message: 'No upload link was sent to this number recently. Ask which WhatsApp number the link came on and call this tool again with it. '
          + `When the customer does not know, ${byInvoiceNumber}`,
      });
    }
    if (!status.uploaded) {
      return res.json({
        link_sent: true,
        uploaded: false,
        message: 'No invoice has been received on the link yet. Ask the customer to finish the upload and to say when the page shows that the '
          + `invoice is received, then call this tool again. When it is still not received after that, ${byInvoiceNumber}`,
      });
    }
    if (status.refused !== undefined) {
      return res.json({
        link_sent: true,
        uploaded: true,
        accepted: false,
        message: `The invoice the customer uploaded was not accepted${status.refused ? `, because ${status.refused}` : ''}, and nothing was saved; `
          + 'the upload page showed the customer why. Say so in one short sentence and ask whether the customer wants to upload the Tiffany '
          + 'Designs invoice for the order, where Sold By shows Tiffany Designs Private Limited, on the same link now.',
      });
    }
    if (status.order) {
      const { order } = status;
      const reference = order.erpOrderId ? `order id ${order.erpOrderId}` : `order number ${order.orderNumber}`;
      return res.json({
        link_sent: true,
        uploaded: true,
        accepted: true,
        order_found: true,
        order_added: order.added,
        order_id: order.erpOrderId,
        order_number: order.orderNumber,
        invoice_number: order.invoiceNumber,
        message: `The invoice is received${order.added ? ', and as no order matched it, an order was added from it' : ' and matched to its order, which was updated from it'}. `
          + `Call tool:find_order now with ${reference} and the WhatsApp number as the mobile number, and follow its message. Once the order is `
          + "confirmed, carry on with the customer's concern from where it stopped, without asking again for anything the customer already gave.",
      });
    }
    if (status.caseNumber) {
      return res.json({
        link_sent: true,
        uploaded: true,
        accepted: true,
        order_found: false,
        case_number: status.caseNumber,
        spoken_case_number: spokenCaseNumber(status.caseNumber),
        message: `The invoice is received, but no order could be added from it automatically, so it is with the service team on request `
          + `${spokenCaseNumber(status.caseNumber)}. Give the customer the request number and say the service team will find the order and contact `
          + 'them. Register no installation, damage, part, replacement or return request for it on this call.',
      });
    }
    return res.json({ link_sent: true, uploaded: true, accepted: true, order_found: false, message: `The invoice is received. To find its order, ${byInvoiceNumber}` });
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
    const { phone, unknown } = chosenPhone(body);
    if (unknown) return res.json({ created: false, order_number: null, message: CALLING_NUMBER_UNKNOWN });
    if (!phone || !INDIAN_MOBILE.test(phone)) {
      return res.json({ created: false, order_number: null, message: 'A valid 10 digit Indian mobile number is needed to place the order.' });
    }
    const unconfirmed = numberToConfirm(phone, { confirmedEnding: body.contact_number_ending, given: phone, caller: body.caller_phone });
    if (unconfirmed) return res.json({ created: false, order_number: null, message: confirmNumberMessage(unconfirmed, 'this order') });
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
      message: `Order ${spokenNumber} is placed for ${lines}, total list price ${formatRupees(result.total)}. The sales team will call `
        + `the number ending ${spokenDigits(phoneEnding(phone))} to confirm the final price, delivery and payment.`,
    });
  });

  router.post('/part-lookup', async (req, res) => {
    const { order_id: orderId, product_name: productName } = req.body || {};
    if (!orderId && !productName) {
      return res.json({ found: false, message: 'An order id or a product name is needed. Ask which product the part belongs to.' });
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

  // The published product guide for the products on an order, or for a product the customer names. By default every
  // part with its sticker number, quantity and part number, the hardware, the delivery check and the rules for that
  // product, so the agent goes through a damaged, defective or missing part one part at a time; with purpose
  // 'assembly' the complete guide, each numbered step with its own hardware, so it walks the customer through assembly.
  router.post('/product-guide', async (req, res) => {
    const body = req.body || {};
    const purpose = /assembl/i.test(String(body.purpose || '')) ? 'assembly' : 'parts';
    const noGuide = purpose === 'assembly'
      ? 'No assembly guide is on record for this product. Offer an installation visit by the service team instead.'
      : 'No product guide is on record for this product. Match the part with tool:find_parts instead.';
    if (!productGuides) return res.json({ found: false, message: noGuide });
    const { order, problem } = await orderFromReferences(body);
    if (problem) return res.json({ found: false, message: problem });
    let productIds;
    if (order) {
      productIds = (order.items || []).map((i) => i.productId).filter(Boolean);
    } else if (String(body.product_name || '').trim()) {
      productIds = await productGuides.findProductIds(body.product_name);
    } else {
      return res.json({ found: false, message: 'An order id, order number or invoice number, or the product name, is needed.' });
    }
    const guides = await productGuides.publishedFor(productIds);
    if (!guides.length) return res.json({ found: false, message: noGuide });
    return res.json({
      found: true,
      purpose,
      has_assembly_steps: guides.some((g) => Boolean(g.assemblySteps)),
      ...(purpose === 'assembly' ? { step_count: guides.reduce((n, g) => n + assemblyStepCount(g), 0) } : {}),
      products: guides.map((g) => ({
        product: g.productName,
        parts_have_number_stickers: Boolean(g.partsHaveNumberStickers),
        parts: g.parts.map((p) => ({ name: p.name, part_number: p.partNumber })),
      })),
      message: guides.map((g) => guideMessage(g, purpose)).join(' '),
    });
  });

  router.post('/cases', async (req, res) => {
    const issueType = normalizeIssueType(req.body?.issue_type);
    if (!issueType) return refused(res, 'The issue type is not recognised. Call this tool again with the issue type that fits the problem.');
    if (!req.body.description) {
      return refused(res, 'A short description of the issue is required. Call this tool again with one sentence describing the problem.');
    }
    if (chosenPhone(req.body).unknown) return refused(res, CALLING_NUMBER_UNKNOWN);
    const result = await crm.createServiceCase(caseInput(req.body, issueType));
    return caseResponse(res, result, (n) => `Service request ${n} is registered.`);
  });

  // The slot is checked again here, whatever resolve_date said: a weekday from Monday to Saturday, a time from
  // 10 am to 6 pm, and not already passed. Nothing is registered until it fits.
  router.post('/installation', async (req, res) => {
    const body = req.body || {};
    if (!body.preferred_date) {
      return refused(res, `A preferred installation date is required. Ask which day suits the customer; visits are ${INSTALLATION_HOURS}.`);
    }
    const resolved = resolveDate(body.preferred_date, now());
    if (!resolved.ok) return refused(res, dateProblem(resolved));
    const slot = checkInstallationSlot(resolved.date, body.preferred_time, now());
    if (!slot.ok) return refused(res, slot.message);
    if (chosenPhone(body).unknown) return refused(res, CALLING_NUMBER_UNKNOWN);

    const reschedule = body.reschedule === true || body.reschedule === 'true';
    const result = await crm.createServiceCase(caseInput(
      {
        description: reschedule
          ? `Customer asked to reschedule installation${body.existing_case_number ? ` for request ${body.existing_case_number}` : ''}.`
          : 'Customer requested installation.',
        ...body,
        preferred_date: resolved.date,
        preferred_time: slot.text,
      },
      reschedule ? 'installation_reschedule' : 'installation',
    ));
    const place = { delivery: ' at the delivery address', customer: ' at the address on file' }[result.addressSource] || '';
    return caseResponse(res, result, (n) => `Installation request ${n} is registered${place} with a preferred slot of ${resolved.spoken}, ${slot.spoken}. `
      + 'The service team confirms the appointment.', { preferred_date: resolved.date, preferred_time: slot.text });
  });

  router.post('/escalate', async (req, res) => {
    if (chosenPhone(req.body || {}).unknown) return refused(res, CALLING_NUMBER_UNKNOWN);
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
      if (!contact?.accountId) {
        return res.json({ found: false, message: 'No customer record matches this number. Ask for the request number with the full name, or with the order id the request is about.' });
      }
      const cases = await crm.getCaseStatus(caseNumber ? { caseNumber } : { accountId: contact.accountId });
      own = cases.filter((c) => c.accountId === contact.accountId);
      if (!own.length) {
        return res.json({
          found: false,
          message: caseNumber
            ? 'No request with that number is on record for this customer. Ask the customer to say the request number again.'
            : 'No open service request was found for this customer. For closed or earlier requests, use tool:get_service_history.',
        });
      }
    } else {
      // Without the mobile: the request number, plus the full name on the request or the order id it is about.
      if (!caseNumber || (!customerName && !orderId)) {
        return res.json({ found: false, message: 'The registered mobile number is needed, or the request number with the full name or the order id.' });
      }
      const cases = await crm.getCaseStatus({ caseNumber });
      own = cases.filter((c) => (customerName && (namesMatch(customerName, c.contactName) || namesMatch(customerName, c.accountName)))
        || (orderId && sameReference(orderId, c.erpOrderId)));
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
    const { phone, unknown } = chosenPhone(body);
    if (unknown) return res.json({ saved: false, new_customer: null, message: CALLING_NUMBER_UNKNOWN });
    if (!phone || !INDIAN_MOBILE.test(phone)) {
      return res.json({ saved: false, new_customer: null, message: 'A valid 10 digit Indian mobile number is needed.' });
    }
    const unconfirmed = numberToConfirm(phone, { confirmedEnding: body.contact_number_ending, given: phone, caller: body.caller_phone });
    if (unconfirmed) return res.json({ saved: false, new_customer: null, message: confirmNumberMessage(unconfirmed, 'these details') });
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
    if (!phone) return res.json({ found: false, message: 'The registered 10 digit mobile number is needed. Ask for it.' });
    const contact = await crm.findContactByPhone(phone);
    if (!contact) return res.json({ found: false, message: 'No customer record matches this number. Ask the customer to check the registered mobile number.' });

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

  // A tool whose lookup or save fails (Salesforce down or refusing) still answers with HTTP 200, so the agent
  // hears what happened and what to do instead of the voice platform's generic failure line.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    logger.error(`Agent tool ${req.path} failed: ${err.message}`);
    const registering = REGISTERING.includes(req.path);
    const fallback = AFTER_SECOND_FAILURE[req.path]
      || (registering ? 'tell the customer the details are noted for the service team, who will follow up.' : 'carry on without this information.');
    return res.json({
      ...(UNANSWERED[req.path] || { found: false }),
      error: 'unavailable',
      message: `The service system did not answer${registering ? ', so nothing is saved yet' : ''}. `
        + `Apologise briefly and call this tool once more. When it fails again, ${fallback}`,
    });
  });

  return router;
};
