const { lastTenDigits } = require('./rules');

const TIMEZONE = 'Asia/Kolkata';

// "23 October 2026", today in India, as the WhatsApp message gives the date of the request.
function messageDate(value) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));
}

// Sends the voice agent's caller the invoice upload page on WhatsApp. The page has one address for everyone and asks
// only for the file; the link is noted in Salesforce (`records.linkSent`) so an upload can be tied back to the caller's
// request. No link goes out while the page could not read the invoice (`reader`).
// Returns { sent: true, ending } or { sent: false, reason: 'limited' | 'unavailable' }.
function createInvoiceLinkSender({ pageUrl, whatsapp, reader, records, limiter, now = () => Date.now(), logger = console }) {
  async function send({ phone, customerName, reference }) {
    if (!pageUrl || !whatsapp.configured || !reader.configured) {
      logger.error('Invoice upload links are off: set WHATSAPP_API_KEY and OPENAI_API_KEY.');
      return { sent: false, reason: 'unavailable' };
    }
    const verdict = await limiter.check({ phone });
    if (!verdict.allowed) return { sent: false, reason: 'limited' };

    // Noted before the message goes out, so the customer's upload is accepted however fast it comes.
    let noted;
    try {
      noted = await records.linkSent({ phone, customerName, reference });
    } catch (err) {
      logger.error(`Noting the invoice upload link failed: ${err.message}`);
      return { sent: false, reason: 'unavailable' };
    }
    try {
      await whatsapp.sendInvoiceUploadLink({ phone, customerName, invoiceDate: messageDate(now()), link: pageUrl });
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

module.exports = { createInvoiceLinkSender, messageDate };
