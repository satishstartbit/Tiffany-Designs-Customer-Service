const { normalizePhone } = require('./rules');
const { VARS, outboundOverrides } = require('./callFlows');
const { todayInIst } = require('./dates');

// Agent call reason for these calls: confirm every part arrived, then offer installation.
const CALL_REASON = 'delivery_check';
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Salesforce keeps the delivery date without a time. The last save of an order is never earlier than the moment it
// was marked Delivered, so waiting from the later of that save and the start of the delivery day never calls early.
function deliveredAt(order) {
  const times = [
    order.deliveryDate ? Date.parse(`${order.deliveryDate}T00:00:00+05:30`) : NaN,
    Date.parse(order.lastModified),
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function mobileToCall(customer) {
  return [customer?.mobile, customer?.phone].map(normalizePhone).find((p) => p && INDIAN_MOBILE.test(p)) || null;
}

// Why an order gets no call now, or null when it is due one.
function skipReason(order, { now, delayMs, called, openRequests, followUps }) {
  if (order.deliveryStatus !== 'Delivered') return 'not_delivered';
  const at = deliveredAt(order);
  if (at === null) return 'no_delivery_date';
  if (now < at + delayMs) return 'too_soon';
  if (!mobileToCall(order.customer)) return 'no_phone';
  if (called.has(order.id)) return 'already_called';
  // The Salesforce-triggered follow-up (POST /api/orders/delivered) already calls about this order.
  if (followUps.has(order.id)) return 'followup_scheduled';
  if (openRequests.has(order.id)) return 'open_request';
  return null;
}

const orderRef = (order) => order.erpOrderId || order.orderNumber;

function createDeliveryCalls({ orders, crm, sarvam, scheduler, config, now = () => Date.now(), logger = console }) {
  let running = false;

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

  async function place(order, productName) {
    const phone = mobileToCall(order.customer);
    const name = order.customer?.name || null;
    const markerId = await orders.markCalled({ orderId: order.id, contactId: order.customer?.id });
    try {
      return await sarvam.startCall({
        phone,
        variables: {
          [VARS.customerName]: name,
          [VARS.customerPhone]: phone,
          [VARS.orderNumber]: orderRef(order),
          [VARS.productName]: productName,
          [VARS.deliveryCity]: order.city,
          [VARS.callReason]: CALL_REASON,
        },
        overrides: outboundOverrides(CALL_REASON, name),
        webhook: webhookFor(order),
      });
    } catch (err) {
      // Sarvam answered and refused, so nobody was called and the next run may try again. Without an answer the call
      // may have gone out, so the marker stays.
      if (/^(Sarvam|Instant calls)/.test(err.message)) {
        await orders.unmark(markerId).catch((e) => logger.error(`Removing the call marker for order ${order.id} failed: ${e.message}`));
      }
      throw err;
    }
  }

  async function check(dryRun) {
    const hours = await crm.getServiceHours();
    if (!hours.open && !dryRun) return { skipped: 'outside_service_hours', opensAt: hours.opensAt };

    const { delayMinutes, lookbackDays, maxPerRun } = config.deliveryCalls;
    const since = todayInIst(now() - lookbackDays * DAY_MS).toISOString().slice(0, 10);
    const delivered = await orders.findDelivered(since);
    const ids = delivered.map((o) => o.id);
    const [called, openRequests, followUps] = await Promise.all([orders.alreadyCalled(ids), orders.withOpenRequests(ids), followUpOrders()]);

    const skipped = {};
    const due = [];
    for (const order of delivered) {
      const reason = skipReason(order, { now: now(), delayMs: delayMinutes * MINUTE_MS, called, openRequests, followUps });
      if (reason) (skipped[reason] ||= []).push(orderRef(order));
      else due.push(order);
    }
    const batch = due.slice(0, maxPerRun);
    const summary = { dryRun, serviceOpen: hours.open, deliveredSince: since, checked: delivered.length, skipped, deferred: due.length - batch.length };
    if (dryRun) return { ...summary, wouldCall: batch.map(orderRef) };

    const products = await orders.productNames(batch.map((o) => o.id));
    const placed = [];
    const failed = [];
    for (const order of batch) {
      try {
        const { attemptId } = await place(order, products[order.id]);
        placed.push({ order: orderRef(order), attemptId });
      } catch (err) {
        logger.error(`Delivery check call for order ${order.id} failed: ${err.message}`);
        failed.push({ order: orderRef(order), error: err.message });
      }
    }
    return { ...summary, placed, failed };
  }

  // One pass: find delivered orders, apply the rules and call the ones that are due. dryRun calls nobody.
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

module.exports = { createDeliveryCalls, deliveredAt, mobileToCall, skipReason, CALL_REASON };
