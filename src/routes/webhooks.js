const express = require('express');
const { normalizeIssueType, normalizePhone } = require('../rules');

const MAX_DESCRIPTION = 30000;
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function transcriptText(turns) {
  if (!Array.isArray(turns)) return '';
  return turns.map((t) => `${t.role === 'agent' ? 'Agent' : 'Customer'}: ${t.en_text}`).join('\n');
}

function recordFrom(identifier, prefix) {
  const match = new RegExp(`^${prefix}:(.+)$`).exec(identifier || '');
  return match ? match[1] : null;
}

// A call started from a Contact or Lead page carries that record; Task.WhoId accepts either.
function whoFrom(recordId) {
  return /^(003|00Q)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(recordId || '') ? recordId : null;
}

// Sarvam posts here after every outbound attempt and every inbound call.
module.exports = function webhooksRouter({ crm, now = () => Date.now(), logger = console }) {
  const router = express.Router();

  router.post('/sarvam', async (req, res) => {
    const p = req.body || {};
    if (!p.user_phone_number || (!p.campaign_id && !p.deployment_id && !p.attempt_id)) {
      return res.status(400).json({ error: 'Not a voice call payload' });
    }

    // Campaign and instant calls are outbound; only a deployment answers inbound calls.
    const direction = p.deployment_id ? 'inbound' : 'outbound';
    const identifier = p.user_identifier || p.metadata?.identifier || null;
    const connected = direction === 'inbound' || p.connectivity_status === 'connected';
    const retrying = direction === 'outbound' && p.next_action_status;
    if (!connected && retrying) {
      return res.json({ ok: true, logged: false, reason: 'attempt will be retried' });
    }

    const vars = { ...(p.final_agent_variables || {}), ...(p.output_agent_variables || {}) };
    const phone = normalizePhone(p.user_phone_number);
    const contact = await crm.findContactByPhone(p.user_phone_number).catch(() => null);

    // A case the agent registered during this call, found in Salesforce rather than trusted from variables.
    const callStart = p.start_datetime || p.executed_at || new Date(now() - DEFAULT_LOOKBACK_MS).toISOString();
    let callCase = connected ? await crm.findVoiceCaseSince(phone, callStart).catch(() => null) : null;

    let fallbackCase = null;
    const issueType = normalizeIssueType(vars.issue_type);
    if (connected && issueType && !callCase && !vars.case_number) {
      fallbackCase = await crm.createServiceCase({
        issueType,
        description: `${vars.issue_description || vars.call_summary || 'Issue reported on voice agent call.'} (registered after the call; voice call ${p.interaction_id})`,
        phone,
        customerName: vars.customer_name,
        erpOrderId: vars.order_number,
        // The number the caller confirmed the order with during the call (find_order saves it), if any.
        orderPhone: vars.order_phone,
        preferredDate: vars.installation_date,
        preferredTime: vars.installation_time,
        city: vars.delivery_city,
      });
      if (fallbackCase.created) {
        callCase = { id: fallbackCase.caseId, caseNumber: fallbackCase.caseNumber };
        logger.warn(`Created fallback case ${fallbackCase.caseNumber} for interaction ${p.interaction_id}`);
      } else {
        logger.error(`Fallback case for interaction ${p.interaction_id} was refused: ${fallbackCase.error}`);
      }
    }

    const placedOrder = connected
      ? await crm.findVoiceOrderSince({ orderNumber: vars.placed_order_number, contactId: contact?.id, since: callStart }).catch(() => null)
      : null;

    // The language the caller chose on the call, kept on their contact so the service team knows it.
    const language = connected && contact?.id && vars.preferred_language
      ? await crm.savePreferredLanguage(contact.id, vars.preferred_language).catch(() => null)
      : null;

    const outcome = [
      vars.call_outcome && `Outcome: ${vars.call_outcome}`,
      vars.preferred_language && `Language: ${vars.preferred_language}`,
      placedOrder && `Order placed: ${placedOrder.orderNumber}`,
      vars.call_summary && `Summary: ${vars.call_summary}`,
      vars.delivery_status && `Delivery status: ${vars.delivery_status}`,
      vars.issue_type && `Issue type: ${vars.issue_type}`,
      (vars.installation_date || vars.installation_time) && `Installation slot: ${[vars.installation_date, vars.installation_time].filter(Boolean).join(' ')}`,
      (callCase?.caseNumber || vars.case_number) && `Case: ${callCase?.caseNumber || vars.case_number}`,
    ].filter(Boolean);

    const description = [
      `${direction === 'outbound' ? 'Outbound' : 'Inbound'} call with ${p.user_phone_number}`,
      connected ? null : `Not connected: ${p.connectivity_status || 'unknown'}${p.failure_reason ? ` (${p.failure_reason})` : ''}`,
      ...outcome,
      p.recording_url && `Recording: ${p.recording_url}`,
      p.interaction_id && `Voice call id: ${p.interaction_id}`,
      '',
      transcriptText(p.interaction_transcript),
    ].filter((line) => line !== null && line !== undefined && line !== false).join('\n').slice(0, MAX_DESCRIPTION);

    const task = await crm.logCall({
      subject: connected ? `AI voice agent call (${direction})` : 'AI voice agent call not connected',
      description,
      contactId: contact?.id || whoFrom(p.metadata?.record_id),
      relatedId: callCase?.id || placedOrder?.id || recordFrom(identifier, 'case') || recordFrom(identifier, 'order'),
      direction,
      durationSeconds: p.duration,
      disposition: connected ? vars.call_outcome || vars.delivery_status || vars.issue_type || 'Connected' : `Not connected: ${p.connectivity_status || 'unknown'}`,
      callId: p.interaction_id || p.attempt_id,
      activityDate: (p.start_datetime || p.executed_at || '').slice(0, 10) || undefined,
    });

    return res.json({
      ok: true,
      logged: true,
      taskId: task.id,
      caseNumber: callCase?.caseNumber || null,
      fallbackCaseNumber: fallbackCase?.created ? fallbackCase.caseNumber : null,
      orderNumber: placedOrder?.orderNumber || null,
      languageSaved: Boolean(language?.saved),
    });
  });

  return router;
};
