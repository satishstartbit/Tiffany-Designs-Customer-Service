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
      throw new Error(`WhatsApp event ${body.event} refused (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return res.json().catch(() => ({}));
  }

  return {
    configured: Boolean(eventsUrl && apiKey),
    // `invoiceDate` is the day the link was asked for, as the message says it ("23 October 2026").
    sendInvoiceUploadLink: ({ phone, customerName, invoiceDate, link }) => sendEvent({
      event: 'invoice_upload_requested',
      phone_number: phone,
      customer_name: String(customerName || '').trim() || 'Customer',
      invoice_date: invoiceDate,
      invoice_upload_link: link,
    }),
  };
}

module.exports = { createWhatsApp };
