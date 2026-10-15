const { formatDate, formatDateTime, spokenCaseNumber, shortName } = require('./speech');

// Agent variable names. They must be declared on the Sarvam agent, or Sarvam drops them silently.
const VARS = {
  customerName: 'customer_name',
  customerPhone: 'customer_phone',
  orderNumber: 'order_number',
  productName: 'product_name',
  deliveryCity: 'delivery_city',
  callReason: 'call_reason',
  noticeDetails: 'notice_details',
};

const CALL_REASONS = {
  deliveryFollowUp: 'delivery_followup',
  callbackRequest: 'callback_request',
  serviceUpdate: 'service_update',
};

const NOTICE_EVENTS = ['case_registered', 'appointment_scheduled', 'replacement_dispatched'];

function followUpJobId(orderId) {
  return `delivery_followup:${orderId}`;
}

// Outbound calls open by confirming who answered; nothing about the order is said before that.
function openingLine(reason, customerName) {
  const who = customerName ? `Am I speaking with ${customerName}?` : 'May I know who I am speaking with?';
  const intro = 'Hello, this is the Tiffany Designs AI service assistant';
  return reason === CALL_REASONS.callbackRequest ? `${intro}, calling back as requested. ${who}` : `${intro}. ${who}`;
}

function outboundOverrides(reason, customerName) {
  return { initial_bot_message: openingLine(reason, customerName), initial_language_name: 'English' };
}

// The update the agent reads out on a service_update call, or null when the case lacks the data for it.
function noticeFor(event, notice) {
  const request = `request ${spokenCaseNumber(notice.caseNumber)}`;
  if (event === 'case_registered') {
    return `Service ${request} for ${notice.serviceType || 'service'} is registered and the service team is reviewing it.`;
  }
  if (event === 'appointment_scheduled') {
    const when = formatDateTime(notice.visit?.scheduledStart);
    if (!when) return null;
    const tech = shortName(notice.visit.technician);
    return `The service visit for ${request} is scheduled for ${when}${tech ? `, with technician ${tech}` : ''}.`;
  }
  if (event === 'replacement_dispatched') {
    const s = notice.shipment;
    if (!s) return null;
    const part = shortName(s.component);
    const expected = formatDate(s.expectedDate);
    return `The replacement ${part ? `${part} ` : 'part '}for ${request} has been dispatched${s.courier ? ` by ${s.courier}` : ''}`
      + `${expected ? `, expected by ${expected}` : ''}.`;
  }
  return null;
}

function noticeJobId(event, notice) {
  const key = event === 'appointment_scheduled' ? notice.visit?.scheduledStart
    : event === 'replacement_dispatched' ? `${notice.shipment?.id}:${notice.shipment?.status}`
      : 'registered';
  return `service_update:${event}:${notice.id}:${key}`;
}

function createJobHandlers({ sarvam, config }) {
  return {
    async delivery_followup(payload) {
      return sarvam.addToCampaign(config.sarvam.followUpCampaignId, `followup-${payload.erpOrderId || payload.orderId}`, [
        {
          phone: payload.phone,
          identifier: `order:${payload.orderId}`,
          variables: {
            [VARS.customerName]: payload.customerName,
            [VARS.customerPhone]: payload.phone,
            [VARS.orderNumber]: payload.erpOrderId,
            [VARS.productName]: payload.productName,
            [VARS.deliveryCity]: payload.city,
            [VARS.callReason]: CALL_REASONS.deliveryFollowUp,
          },
          overrides: outboundOverrides(CALL_REASONS.deliveryFollowUp, payload.customerName),
        },
      ]);
    },

    async service_update(payload) {
      return sarvam.addToCampaign(config.sarvam.notifyCampaignId, `update-${payload.caseNumber}`, [
        {
          phone: payload.phone,
          identifier: `case:${payload.caseId}`,
          variables: {
            [VARS.customerName]: payload.customerName,
            [VARS.customerPhone]: payload.phone,
            [VARS.orderNumber]: payload.erpOrderId,
            [VARS.callReason]: CALL_REASONS.serviceUpdate,
            [VARS.noticeDetails]: payload.notice,
          },
          overrides: outboundOverrides(CALL_REASONS.serviceUpdate, payload.customerName),
        },
      ]);
    },
  };
}

module.exports = {
  VARS,
  CALL_REASONS,
  NOTICE_EVENTS,
  followUpJobId,
  openingLine,
  outboundOverrides,
  noticeFor,
  noticeJobId,
  createJobHandlers,
};
