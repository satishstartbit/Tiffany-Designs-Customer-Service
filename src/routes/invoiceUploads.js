const express = require('express');
const { FILE_TYPES } = require('../invoiceReader');

const MAX_BYTES = 8 * 1024 * 1024;

// The invoice upload page (web/app/invoice) reaches these through its own route. They are public, have one address
// for everyone and take nothing but the file: the customer and the order are found from the invoice itself
// (src/crm/invoiceUploads.js). Uploads are rate-limited per visitor and overall, because each is a paid AI call.
// Answers name nothing from Salesforce, only what the customer's own invoice says.
module.exports = function invoiceUploadsRouter({ reader, records, limiter, logger = console }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Whether uploads work right now; the page asks on opening, which also wakes a sleeping server.
  router.get('/', (req, res) => res.json({ available: reader.configured }));

  router.post('/', express.raw({ type: FILE_TYPES, limit: MAX_BYTES }), async (req, res) => {
    const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!FILE_TYPES.includes(contentType) || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(415).json({ error: 'unsupported_file', message: 'Please upload a photo or screenshot (JPG, PNG or WebP) or a PDF of the invoice.' });
    }
    if (!reader.configured) {
      // The visitor sees a plain message; the log says what is missing.
      logger.error('Invoice reading is off: set OPENAI_API_KEY.');
      return res.status(503).json({ error: 'not_configured', message: 'Invoice upload is not available right now. Please try again later.' });
    }

    const visitor = { ip: req.ip };
    const verdict = await limiter.check(visitor);
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many uploads. Please try again later.' });
    }
    await limiter.record(visitor);

    let invoice;
    try {
      invoice = await reader.read({ data: req.body, contentType });
    } catch (err) {
      if (err.setup) {
        logger.error(`Invoice reading is off until the OpenAI account or OPENAI_API_KEY / OPENAI_OCR_MODEL is fixed: ${err.message}`);
        return res.status(503).json({ error: 'not_configured', message: 'Invoice upload is not available right now. Please try again later, or call Tiffany Designs customer care.' });
      }
      logger.error(`Reading an uploaded invoice failed: ${err.message}`);
      return res.status(502).json({ error: 'read_failed', message: 'We could not read the invoice just now. Please try again in a minute.' });
    }
    if (!invoice.isInvoice || (!invoice.invoiceNumber && !invoice.orderId && !invoice.items.length)) {
      return res.status(422).json({
        error: 'not_an_invoice',
        message: 'We could not find an invoice in this file. Please upload a clear photo or screenshot of the whole invoice.',
      });
    }

    let result;
    try {
      result = await records.record({ invoice, file: { data: req.body, contentType } });
    } catch (err) {
      logger.error(`Saving an uploaded invoice failed: ${err.message}`);
      return res.status(502).json({ error: 'save_failed', message: 'We read your invoice but could not save it just now. Please try again in a minute.' });
    }

    const answer = { invoice_number: invoice.invoiceNumber, order_id: invoice.orderId };
    if (result.matched) {
      return res.json({ status: 'matched', ...answer, message: 'Thank you. We found your order and added your invoice to it. Our service team will take it from here.' });
    }
    if (result.recorded) {
      return res.json({
        status: 'received',
        ...answer,
        message: 'Thank you. We have your invoice, but could not match it to an order automatically. Our service team will check it and contact you.',
      });
    }
    return res.json({
      status: 'not_found',
      ...answer,
      message: 'We could not match this invoice to an order, and it shows no phone number to reach you on. Please call Tiffany Designs customer care.',
    });
  });

  return router;
};
