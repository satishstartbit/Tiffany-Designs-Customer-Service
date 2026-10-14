const express = require('express');
const { normalizePhone, normalizeIssueType } = require('../rules');
const { formatDate, formatDateTime, spokenCaseNumber, shortName } = require('../speech');
const { resolveDate, MAX_DAYS_AHEAD } = require('../dates');
const { formatRupees } = require('../crm/orderItems');

const MAX_PRODUCTS_SPOKEN = 5;

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

const NOT_VERIFIED = 'The order could not be verified with these details.';

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
    };
  }

  router.post('/customer-lookup', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.json({ found: false, message: 'The phone number is not valid.' });

    const contact = await crm.findContactByPhone(phone);
    if (!contact) return res.json({ found: false, message: 'No customer record matches this number.' });

    const orders = contact.accountId ? await crm.findRecentOrdersForAccount(contact.accountId) : [];
    const named = orders.filter((o) => o.erpOrderId);
    return res.json({
      found: true,
      customer_name: contact.name,
      first_name: contact.firstName,
      city: contact.city,
      recent_orders: named.map((o) => `${o.erpOrderId} (${o.deliveryStatus || 'status unknown'})`).join(', '),
      latest_order_id: named[0]?.erpOrderId || null,
      message: named.length
        ? `Customer ${contact.name} found. Recent orders: ${named.map((o) => `${o.erpOrderId}, ${o.deliveryStatus ? o.deliveryStatus.toLowerCase() : 'status unknown'}`).join('; ')}.`
        : `Customer ${contact.name} found, with no order id on record.`,
    });
  });

  router.post('/order-lookup', async (req, res) => {
    const { order_id: orderId, invoice_number: invoiceNumber, verification } = req.body || {};
    const phone = normalizePhone(req.body?.phone);

    if (orderId) {
      const verified = await crm.verifyOrder(orderId, verification || invoiceNumber || phone);
      if (!verified.found) return res.json({ found: false, message: NOT_VERIFIED });
      const order = verified.order ? await crm.getOrderById(verified.order.id) : await crm.getOrderByErpId(orderId);
      return res.json({
        found: true,
        order_id: orderId,
        customer_name: verified.customerName,
        delivery_status: verified.deliveryStatus,
        delivery_date: verified.deliveryDate,
        order_source: verified.orderSource,
        products: order?.productSummary || '',
        message: describeOrder({ orderId, products: order?.productSummary, deliveryStatus: verified.deliveryStatus, deliveryDate: verified.deliveryDate }),
      });
    }

    // An invoice number alone is not proof of ownership; the registered mobile has to match as well.
    if (invoiceNumber) {
      if (!phone) return res.json({ found: false, message: 'The registered mobile number is needed with an invoice number.' });
      const order = await crm.getOrderByInvoice(invoiceNumber);
      const verified = order?.erpOrderId ? await crm.verifyOrder(order.erpOrderId, phone) : { found: false };
      if (!verified.found) return res.json({ found: false, message: NOT_VERIFIED });
      return res.json({
        found: true,
        order_id: order.erpOrderId,
        customer_name: verified.customerName,
        delivery_status: verified.deliveryStatus,
        delivery_date: verified.deliveryDate,
        order_source: verified.orderSource,
        products: order.productSummary,
        message: describeOrder({ orderId: order.erpOrderId, products: order.productSummary, deliveryStatus: verified.deliveryStatus, deliveryDate: verified.deliveryDate }),
      });
    }

    if (!phone) return res.json({ found: false, message: 'An order id, an invoice number or a valid phone number is required.' });
    const contact = await crm.findContactByPhone(phone);
    const [latest] = contact?.accountId ? await crm.findRecentOrdersForAccount(contact.accountId, 1) : [];
    if (!latest) return res.json({ found: false, message: 'No order is linked to this phone number.' });
    const order = await crm.getOrderById(latest.id);
    const id = order.erpOrderId || order.orderNumber;
    return res.json({
      found: true,
      order_id: order.erpOrderId,
      customer_name: order.accountName,
      delivery_status: order.deliveryStatus,
      delivery_date: order.deliveryDate,
      order_source: order.orderSource,
      products: order.productSummary,
      message: `The latest order on this number: ${describeOrder({ orderId: id, products: order.productSummary, deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate })}`,
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
    if (!phone) return res.json({ found: false, message: 'A valid phone number is required.' });
    const contact = await crm.findContactByPhone(phone);
    if (!contact?.accountId) return res.json({ found: false, message: 'No customer record matches this number.' });

    const cases = await crm.getCaseStatus(
      req.body.case_number ? { caseNumber: req.body.case_number } : { accountId: contact.accountId },
    );
    const own = cases.filter((c) => c.accountId === contact.accountId);
    if (!own.length) return res.json({ found: false, message: 'No open service request was found for this customer.' });

    return res.json({
      found: true,
      case_number: own[0].caseNumber,
      status: own[0].status,
      open_requests: own.length,
      message: own.map(caseSummary).join(' '),
    });
  });

  return router;
};
