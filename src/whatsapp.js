// Messages to customers on WhatsApp, through the Startbit WhatsApp voice agent integration: the server posts an event
// and the integration sends the matching WhatsApp template.
function createWhatsApp({ eventsUrl, apiKey, fetchImpl = (...args) => fetch(...args), timeoutMs = 8000 }) {
  async function sendEvent(body) {
    const res = await fetchImpl(eventsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let answer = null;
      try { answer = JSON.parse(detail); } catch { /* not JSON */ }
      const err = new Error(answer?.code === 'VOICE_EVENT_NOT_CONFIGURED'
        ? `WhatsApp has no approved template enabled for the event ${body.event}: enable one in the WhatsApp integration (Management → Voice agent API)`
        : `WhatsApp event ${body.event} refused (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
      err.code = answer?.code || null;
      throw err;
    }
    return res.json().catch(() => ({}));
  }

  return {
    configured: Boolean(eventsUrl && apiKey),
    // The integration accepts only these fields and refuses any other ("Unrecognized keys"); the upload page's
    // address is part of its message template.
    sendInvoiceUploadLink: ({ phone, customerName }) => sendEvent({
      event: 'invoice_upload_requested',
      phone_number: phone,
      customer_name: String(customerName || '').trim() || 'Customer',
    }),
  };
}

module.exports = { createWhatsApp };
