// The mobile number a customer types above the call widget, carried into the call as the agent's customer_phone.

// "98765 43210", "+91 98765 43210" or "098765 43210" -> "+919876543210"; null for anything else.
export function callerPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}

// The widget's first message on a new call. It carries the agent's call variables, so the number is added there.
export const CALL_START = 'client.action.interaction_start';

// The agent's short welcome on a website call (its opening_line), by first name when the number is a customer's.
export function openingLine(name = null) {
  return `Namaste${name ? ` ${name} ji` : ''}, welcome to Tiffany Designs. How can I help you today?`;
}

// The message as the widget would send it, with customer_phone, the welcome as opening_line, and customer_name when
// the number belongs to a customer, added when this is the call-start message.
export function withCallerPhone(data, phone, name = null) {
  if (!phone || typeof data !== 'string' || !data.includes(CALL_START)) return data;
  try {
    const message = JSON.parse(data);
    if (message.type !== CALL_START) return data;
    const known = { customer_phone: phone, opening_line: openingLine(name), ...(name ? { customer_name: name } : {}) };
    return JSON.stringify({ ...message, agent_variables: { ...message.agent_variables, ...known } });
  } catch {
    return data;
  }
}
