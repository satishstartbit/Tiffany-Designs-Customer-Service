const express = require('express');
const { normalizePhone } = require('../rules');
const { followUpJobId } = require('../callFlows');

// Called by Salesforce (record-triggered Flow on Order) when Delivery_Status__c becomes Delivered.
module.exports = function ordersRouter({ crm, scheduler, config, now }) {
  const router = express.Router();

  router.post('/delivered', async (req, res) => {
    const { orderId, erpOrderId, deliveredAt } = req.body || {};
    if (!orderId && !erpOrderId) {
      return res.status(400).json({ error: 'orderId (Salesforce Id) or erpOrderId is required' });
    }

    const delivered = deliveredAt ? new Date(deliveredAt) : new Date(now());
    if (Number.isNaN(delivered.getTime())) {
      return res.status(400).json({ error: 'deliveredAt must be an ISO 8601 date-time' });
    }

    const order = orderId ? await crm.getOrderById(orderId) : await crm.getOrderByErpId(erpOrderId);
    if (!order) return res.status(404).json({ error: 'Order not found in Salesforce' });
    if (order.deliveryStatus !== 'Delivered') {
      return res.status(409).json({ error: `Order delivery status is ${order.deliveryStatus || 'empty'}, not Delivered` });
    }

    const contact = req.body.phone ? null : await crm.getOrderContact(order);
    const phone = normalizePhone(req.body.phone || contact?.mobile || contact?.phone);
    if (!phone) {
      return res.status(422).json({ error: 'The order has no valid customer phone number', orderId: order.id });
    }

    const runAt = delivered.getTime() + config.followUpDelayMinutes * 60 * 1000;
    const { job, created } = await scheduler.schedule({
      id: followUpJobId(order.id),
      type: 'delivery_followup',
      runAt,
      payload: {
        orderId: order.id,
        erpOrderId: order.erpOrderId || order.orderNumber,
        phone,
        customerName: req.body.customerName || contact?.name || null,
        productName: order.productSummary || null,
        city: order.city,
      },
    });

    return res.status(created ? 202 : 200).json({
      jobId: job.id,
      status: job.status,
      runAt: job.runAt,
      alreadyScheduled: !created,
    });
  });

  router.delete('/delivered/:orderId', async (req, res) => {
    const cancelled = await scheduler.cancel(followUpJobId(req.params.orderId));
    res.status(cancelled ? 200 : 404).json({ cancelled });
  });

  return router;
};
