const express = require('express');
const { FILE_TYPES, SELLER, soldByTiffany } = require('../invoiceReader');

const MAX_BYTES = 8 * 1024 * 1024;
const NOT_TIFFANY = `This invoice does not show ${SELLER} as the seller. Please upload the Tiffany Designs invoice for your order, where Sold By shows ${SELLER}.`;
const quoted = (names) => {
  const shown = names.slice(0, 3).map((n) => `"${n.length > 60 ? `${n.slice(0, 57)}...` : n}"`);
  return names.length > 3 ? `${shown.join(', ')} and ${names.length - 3} more` : shown.join(', ');
};
// What the customer is told when no order may be added from the invoice (src/crm/invoiceUploads.js, addOrder).
const REFUSED = {
  not_tiffany_invoice: () => NOT_TIFFANY,
  invoice_number_missing: () => 'We could not read the invoice number on this invoice, so we could not add your order from it. '
    + 'Please upload a clear photo or screenshot of the whole invoice, with the invoice number showing.',
  no_products: () => 'We could not read the products on this invoice, so we could not add your order from it. '
    + 'Please upload a clear photo or screenshot of the whole invoice, with the product list showing.',
  product_not_available: (r) => `${r.products.length > 1 ? 'These products on your invoice are' : 'This product on your invoice is'} `
    + `not available in our product list: ${quoted(r.products)}. We could not add your order from this invoice. `
    + 'Please check that you uploaded your Tiffany Designs invoice, or call Tiffany Designs customer care.',
};

// The invoice upload page (web/app/invoice) reaches these through its own route. They are public, have one address
// for everyone and take nothing but the file: the customer and the order are found from the invoice itself, or the
// order is added from it (src/crm/invoiceUploads.js). Only invoices sold by Tiffany Designs Private Limited are taken,
// and an order is added only from one with its invoice number and with every product in the catalog.
// Uploads are rate-limited per visitor and overall, because each is a paid AI call.
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
      logger.error('Invoice reading is off: set GROQ_API_KEY.');
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
        logger.error(`Invoice reading is off until the Groq account or GROQ_API_KEY / GROQ_OCR_MODEL is fixed: ${err.message}`);
        return res.status(503).json({ error: 'not_configured', message: 'Invoice upload is not available right now. Please try again later, or call Tiffany Designs customer care.' });
      }
      if (err.unreadable) {
        logger.warn(`An uploaded PDF was refused: ${err.message}`);
        return res.status(422).json({
          error: 'unreadable_pdf',
          message: 'We could not open this PDF. It may be locked with a password or damaged. Please upload a photo or screenshot of the invoice instead.',
        });
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
    // Only Tiffany Designs' own invoices are taken; anything else is refused before it reaches Salesforce.
    if (!soldByTiffany(invoice)) {
      logger.warn(`An uploaded invoice was refused: it is sold by ${invoice.soldBy || invoice.seller || 'no seller it names'}.`);
      return res.status(422).json({ error: 'not_tiffany_invoice', message: NOT_TIFFANY });
    }

    let result;
    try {
      result = await records.record({ invoice, file: { data: req.body, contentType } });
    } catch (err) {
      logger.error(`Saving an uploaded invoice failed: ${err.message}`);
      return res.status(502).json({ error: 'save_failed', message: 'We read your invoice but could not save it just now. Please try again in a minute.' });
    }

    // Nothing was saved: the customer is told what is wrong with the invoice (the products named are the invoice's own).
    if (result.refused) {
      return res.status(422).json({ error: result.refused.reason, message: REFUSED[result.refused.reason](result.refused) });
    }
    // A customer still on the call tells the assistant, which then finds the order (check_invoice_upload).
    const onTheCall = 'If you are still on the call with our assistant, tell it that the invoice is uploaded';
    const answer = { invoice_number: invoice.invoiceNumber, order_id: invoice.orderId };
    if (result.matched) {
      return res.json({
        status: 'matched',
        ...answer,
        message: `Thank you. We found your order and added your invoice to it. ${onTheCall}; otherwise our service team will take it from here.`,
      });
    }
    if (result.created) {
      return res.json({
        status: 'created',
        ...answer,
        message: 'Thank you. Your order was not in our records, so we have added it from your invoice. Our service team will check it. '
          + `${onTheCall}; otherwise please call us again to continue with your request.`,
      });
    }
    if (result.recorded) {
      return res.json({
        status: 'received',
        ...answer,
        message: 'Thank you. We have your invoice, but could not match it to an order automatically. Our service team will check it and contact you. '
          + `${onTheCall}.`,
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
