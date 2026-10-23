const { lastTenDigits } = require('./rules');

// Sends the voice agent's caller the invoice upload page on WhatsApp. The page (the website's /invoice) is in the
// integration's message template and asks only for the file; the link is noted in Salesforce (`records.linkSent`) so
// an upload can be tied back to the caller's request. No link goes out while invoices could not be read (`reader`).
// Returns { sent: true, ending } or { sent: false, reason: 'limited' | 'unavailable' }.
function createInvoiceLinkSender({ whatsapp, reader, records, limiter, logger = console }) {
  async function send({ phone, customerName, reference }) {
    if (!whatsapp.configured || !reader.configured) {
      logger.error('Invoice upload links are off: set WHATSAPP_API_KEY and OPENAI_API_KEY.');
      return { sent: false, reason: 'unavailable' };
    }
    const verdict = await limiter.check({ phone });
    if (!verdict.allowed) return { sent: false, reason: 'limited' };

    // Noted before the message goes out, so the customer's upload is tied to the call however fast it comes.
    let noted;
    try {
      noted = await records.linkSent({ phone, customerName, reference });
    } catch (err) {
      logger.error(`Noting the invoice upload link failed: ${err.message}`);
      return { sent: false, reason: 'unavailable' };
    }
    try {
      await whatsapp.sendInvoiceUploadLink({ phone, customerName });
    } catch (err) {
      logger.error(`Sending the invoice upload link failed: ${err.message}`);
      await records.linkFailed(noted).catch((e) => logger.error(`Removing the invoice upload link note ${noted} failed: ${e.message}`));
      return { sent: false, reason: 'unavailable' };
    }
    await limiter.record({ phone });
    return { sent: true, ending: lastTenDigits(phone).slice(-4) };
  }

  return { send };
}

module.exports = { createInvoiceLinkSender };
