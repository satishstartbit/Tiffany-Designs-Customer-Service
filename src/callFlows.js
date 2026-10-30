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
  openingLine: 'opening_line',
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

// Every call opens in Hindi, and Sarvam then follows the language the customer answers in. The voice speaks the
// opening line exactly as written (it is the variable opening_line, not translated), so the lines are Hindi here, worded
// so that nothing changes with the voice's gender.
const BRAND_HINDI = 'टिफ़नी डिज़ाइन्स';
const OPENING_LANGUAGE = 'Hindi';

// The inbound welcome (phone and website calls), by first name when the number belongs to a customer.
function welcomeLine(firstName = null) {
  return `नमस्ते${firstName ? ` ${firstName} जी` : ''}, ${BRAND_HINDI} में आपका स्वागत है। बताइए, मैं आपकी क्या मदद करूँ?`;
}

// An outbound call's first line: the assistant says who it is, why it calls when `why` is given, and asks for the
// customer by name. Nothing about the order is said before the customer confirms.
function confirmIdentityLine(customerName, why = '') {
  const who = customerName ? `क्या मेरी बात ${customerName} जी से हो रही है?` : 'क्या आप बता सकते हैं कि मेरी बात किससे हो रही है?';
  return [`नमस्ते, मैं ${BRAND_HINDI} का AI सर्विस असिस्टेंट हूँ।`, why, who].filter(Boolean).join(' ');
}

function openingLine(reason, customerName) {
  return confirmIdentityLine(customerName, reason === CALL_REASONS.callbackRequest ? 'आपके कहने पर वापस कॉल किया है।' : '');
}

// Sarvam speaks the agent's greeting, which is {{opening_line}}, and ignores initial_bot_message while that greeting
// exists; both are sent so the line is right either way.
function outboundOverrides(reason, customerName) {
  return { initial_bot_message: openingLine(reason, customerName), initial_language_name: OPENING_LANGUAGE };
}

function outboundVariables(reason, customerName, variables) {
  return { ...variables, [VARS.callReason]: reason, [VARS.openingLine]: openingLine(reason, customerName) };
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
          variables: outboundVariables(CALL_REASONS.deliveryFollowUp, payload.customerName, {
            [VARS.customerName]: payload.customerName,
            [VARS.customerPhone]: payload.phone,
            [VARS.orderNumber]: payload.erpOrderId,
            [VARS.productName]: payload.productName,
            [VARS.deliveryCity]: payload.city,
          }),
          overrides: outboundOverrides(CALL_REASONS.deliveryFollowUp, payload.customerName),
        },
      ]);
    },

    async service_update(payload) {
      return sarvam.addToCampaign(config.sarvam.notifyCampaignId, `update-${payload.caseNumber}`, [
        {
          phone: payload.phone,
          identifier: `case:${payload.caseId}`,
          variables: outboundVariables(CALL_REASONS.serviceUpdate, payload.customerName, {
            [VARS.customerName]: payload.customerName,
            [VARS.customerPhone]: payload.phone,
            [VARS.orderNumber]: payload.erpOrderId,
            [VARS.noticeDetails]: payload.notice,
          }),
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
  OPENING_LANGUAGE,
  welcomeLine,
  confirmIdentityLine,
  openingLine,
  outboundOverrides,
  outboundVariables,
  noticeFor,
  noticeJobId,
  createJobHandlers,
};
