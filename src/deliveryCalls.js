const { normalizePhone } = require('./rules');
const { VARS, OPENING_LANGUAGE, confirmIdentityLine } = require('./callFlows');
const { todayInIst } = require('./dates');
const { formatDate } = require('./speech');

// Agent call reason for these calls: confirm every part arrived, then offer installation.
const CALL_REASON = 'delivery_check';
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

// Sarvam ignores app_overrides.initial_bot_message while the agent has a greeting, so the greeting is the variable
// opening_line, in Hindi like every call's first line (src/callFlows.js).
function openingLine(customerName) {
  return confirmIdentityLine(customerName, 'आपकी हाल की डिलीवरी के बारे में कॉल किया है।');
}

function mobileToCall(customer) {
  return [customer?.mobile, customer?.phone].map(normalizePhone).find((p) => p && INDIAN_MOBILE.test(p)) || null;
}

// Why an order gets no call, or null when it is due one.
function skipReason(order, { called, openRequests, followUps }) {
  if (order.deliveryStatus !== 'Delivered') return 'not_delivered';
  if (!mobileToCall(order.customer)) return 'no_phone';
  if (called.has(order.id)) return 'already_called';
  // The Salesforce-triggered follow-up (POST /api/orders/delivered) already calls about this order.
  if (followUps.has(order.id)) return 'followup_scheduled';
  if (openRequests.has(order.id)) return 'open_request';
  return null;
}

const orderRef = (order) => order.erpOrderId || order.orderNumber;

// The orders a run calls: at most maxPerRun, and one per number, since a second call to a phone already ringing would
// not get through. The rest are called on a later run.
function pickBatch(due, maxPerRun) {
  const phones = new Set();
  const batch = [];
  const deferred = [];
  for (const order of due) {
    const phone = mobileToCall(order.customer);
    if (batch.length < maxPerRun && !phones.has(phone)) {
      phones.add(phone);
      batch.push(order);
    } else {
      deferred.push(order);
    }
  }
  return { batch, deferred };
}

function createDeliveryCalls({ orders, crm, sarvam, scheduler, config, now = () => Date.now(), logger = console }) {
  let running = false;
  // Orders this process has called, so a failed save of the Salesforce marker never leads to a second call.
  const calledHere = new Set();

  function webhookFor(order) {
    if (!config.publicBaseUrl || !config.webhookToken) return null;
    return {
      url: `${config.publicBaseUrl}/api/webhooks/sarvam?token=${encodeURIComponent(config.webhookToken)}`,
      metadata: { identifier: `order:${order.id}`, source: CALL_REASON, record_id: order.customer?.id || null },
    };
  }

  async function followUpOrders() {
    const jobs = await scheduler.list().catch(() => []);
    return new Set(jobs.filter((j) => j.type === 'delivery_followup' && ['pending', 'done'].includes(j.status)).map((j) => j.payload?.orderId));
  }

  // Records the order as called. Returns the error message when the Salesforce marker could not be saved.
  async function markCalled(order, attemptId) {
    calledHere.add(order.id);
    try {
      await orders.markCalled({ orderId: order.id, contactId: order.customer?.id, attemptId });
      return null;
    } catch (err) {
      logger.error(`Saving the call marker for order ${order.id} failed: ${err.message}`);
      return err.message;
    }
  }

  async function place(order, productName) {
    const phone = mobileToCall(order.customer);
    const name = order.customer?.name || null;
    try {
      const { attemptId } = await sarvam.startCall({
        phone,
        variables: {
          [VARS.customerName]: name,
          [VARS.customerPhone]: phone,
          [VARS.orderNumber]: orderRef(order),
          [VARS.productName]: productName,
          delivery_date: formatDate(order.deliveryDate),
          [VARS.deliveryCity]: order.city,
          [VARS.callReason]: CALL_REASON,
          opening_line: openingLine(name),
        },
        overrides: { initial_bot_message: openingLine(name), initial_language_name: OPENING_LANGUAGE },
        webhook: webhookFor(order),
      });
      const markerError = await markCalled(order, attemptId);
      return { attemptId, ...(markerError ? { markerError } : {}) };
    } catch (err) {
      // Sarvam answered and refused, so nobody was called and the next run tries again. Without an answer the call
      // may have gone out, so the order is marked as called all the same.
      if (!/^(Sarvam|Instant calls)/.test(err.message)) await markCalled(order, null);
      throw err;
    }
  }

  async function check(dryRun) {
    const { maxPerRun, serviceHoursOnly } = config.deliveryCalls;
    const hours = await crm.getServiceHours();
    if (serviceHoursOnly && !hours.open && !dryRun) return { skipped: 'outside_service_hours', opensAt: hours.opensAt };

    const today = todayInIst(now()).toISOString().slice(0, 10);
    const delivered = await orders.findDeliveredToday(today);
    const ids = delivered.map((o) => o.id);
    const [marked, openRequests, followUps] = await Promise.all([orders.alreadyCalled(ids), orders.withOpenRequests(ids), followUpOrders()]);
    const called = new Set([...marked, ...calledHere]);

    const skipped = {};
    const due = [];
    for (const order of delivered) {
      const reason = skipReason(order, { called, openRequests, followUps });
      if (reason) (skipped[reason] ||= []).push(orderRef(order));
      else due.push(order);
    }
    const { batch, deferred } = pickBatch(due, maxPerRun);
    const summary = { dryRun, serviceOpen: hours.open, deliveredOn: today, checked: delivered.length, skipped, deferred: deferred.map(orderRef) };
    if (dryRun) return { ...summary, wouldCall: batch.map(orderRef) };

    const products = await orders.productNames(batch.map((o) => o.id));
    const outcomes = await Promise.allSettled(batch.map((order) => place(order, products[order.id])));
    const placed = [];
    const failed = [];
    outcomes.forEach((outcome, i) => {
      const order = batch[i];
      if (outcome.status === 'fulfilled') {
        placed.push({ order: orderRef(order), ...outcome.value });
      } else {
        logger.error(`Delivery check call for order ${order.id} failed: ${outcome.reason.message}`);
        failed.push({ order: orderRef(order), error: outcome.reason.message });
      }
    });
    return { ...summary, placed, failed };
  }

  // One pass: find the orders delivered today, apply the rules and call every one that is due, all at once. dryRun
  // calls nobody.
  async function run({ dryRun = false } = {}) {
    if (!dryRun && !sarvam.canStartCalls) {
      const err = new Error('Delivery check calls need SARVAM_AGENT_ID, SARVAM_APP_VERSION, SARVAM_CONNECTION_ID and SARVAM_AGENT_PHONE');
      err.status = 503;
      throw err;
    }
    if (running) return { skipped: 'already_running' };
    running = true;
    try {
      return await check(dryRun);
    } finally {
      running = false;
    }
  }

  return { run };
}

module.exports = { createDeliveryCalls, mobileToCall, skipReason, CALL_REASON };
