const express = require('express');
const { normalizePhone, lastTenDigits } = require('../rules');
const { VARS, CALL_REASONS, NOTICE_EVENTS, outboundOverrides, outboundVariables, noticeFor, noticeJobId } = require('../callFlows');

const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

function waitMessage(seconds) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 120) return `Please try again in about ${Math.round(minutes / 60)} hours.`;
  return `Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

module.exports = function callsRouter({ crm, sarvam, scheduler, config, now, limiter, guards, logger = console }) {
  const router = express.Router();

  function webhookFor(metadata) {
    if (!config.publicBaseUrl || !config.webhookToken) return null;
    return { url: `${config.publicBaseUrl}/api/webhooks/sarvam?token=${encodeURIComponent(config.webhookToken)}`, metadata };
  }

  // A customer leaves their number (website panel, app, WhatsApp) and the agent calls them now.
  router.post('/request', guards.request, async (req, res) => {
    const { phone: rawPhone, name, orderNumber, consent, recordId, source } = req.body || {};
    if (consent !== true) {
      return res.status(400).json({ error: 'consent_required', message: 'Please confirm that Tiffany Designs may call this number.' });
    }
    const phone = normalizePhone(rawPhone);
    if (!phone || !INDIAN_MOBILE.test(phone)) {
      return res.status(422).json({ error: 'invalid_number', message: 'Please enter a valid 10-digit Indian mobile number.' });
    }

    const contact = await crm.findContactByPhone(phone).catch((err) => {
      logger.error(`Contact lookup for a callback failed: ${err.message}`);
      return null;
    });
    if (config.callbacks.allowedNumbers === 'registered' && !contact) {
      return res.status(403).json({ error: 'not_registered', message: 'This number is not registered with Tiffany Designs. Please use the number on your order.' });
    }

    const limit = await limiter.check({ phone });
    if (!limit.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterSeconds: limit.retryAfterSeconds,
        message: `A call to this number was requested recently. ${waitMessage(limit.retryAfterSeconds)}`,
      });
    }

    const customerName = name || contact?.name || null;
    const variables = outboundVariables(CALL_REASONS.callbackRequest, customerName, {
      [VARS.customerName]: customerName,
      [VARS.customerPhone]: phone,
      [VARS.orderNumber]: orderNumber,
    });
    const overrides = outboundOverrides(CALL_REASONS.callbackRequest, customerName);
    const identifier = `callback:${phone}`;

    let result;
    if (sarvam.canStartCalls) {
      const started = await sarvam.startCall({
        phone,
        variables,
        overrides,
        webhook: webhookFor({ identifier, source: source || 'callback', record_id: recordId || null }),
      });
      result = { mode: 'instant', attemptId: started.attemptId };
    } else if (config.sarvam.callbackCampaignId) {
      const queued = await sarvam.addToCampaign(config.sarvam.callbackCampaignId, `callback-${lastTenDigits(phone)}-${now()}`, [
        { phone, identifier, variables, overrides },
      ]);
      result = { mode: 'campaign', cohortId: queued?.cohort_id || null };
    } else {
      return res.status(503).json({ error: 'not_configured', message: 'Calls are not set up yet.' });
    }

    await limiter.record({ phone });
    return res.status(202).json({ queued: true, phone, ...result, message: 'The Tiffany Designs AI service assistant will call this number in a few seconds.' });
  });

  // Service update call (module 13): Salesforce reports a case event and the agent tells the customer.
  router.post('/notify', guards.notify, async (req, res) => {
    if (!config.sarvam.notifyCampaignId) {
      return res.status(503).json({ error: 'Notification calls are not enabled: set SARVAM_NOTIFY_CAMPAIGN_ID' });
    }
    const { caseId, caseNumber, event } = req.body || {};
    if (!NOTICE_EVENTS.includes(event)) {
      return res.status(400).json({ error: `event must be one of ${NOTICE_EVENTS.join(', ')}` });
    }
    if (!caseId && !caseNumber) return res.status(400).json({ error: 'caseId or caseNumber is required' });

    const notice = await crm.getCaseNotice({ caseId, caseNumber });
    if (!notice) return res.status(404).json({ error: 'Case not found in Salesforce' });

    const text = noticeFor(event, notice);
    if (!text) return res.status(409).json({ error: `The case has no ${event === 'appointment_scheduled' ? 'scheduled visit' : 'replacement shipment'} to report` });

    const phone = normalizePhone(notice.phone);
    if (!phone) return res.status(422).json({ error: 'The case has no valid customer mobile number' });

    const { job, created } = await scheduler.schedule({
      id: noticeJobId(event, notice),
      type: 'service_update',
      runAt: now(),
      payload: {
        caseId: notice.id,
        caseNumber: notice.caseNumber,
        phone,
        customerName: notice.customerName,
        erpOrderId: notice.erpOrderId,
        notice: text,
      },
    });

    return res.status(created ? 202 : 200).json({ jobId: job.id, runAt: job.runAt, notice: text, alreadyQueued: !created });
  });

  return router;
};
