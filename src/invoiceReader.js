const { normalizePhone } = require('./rules');
const { pdfPages } = require('./pdfPages');

const ORDER_SOURCES = ['Amazon', 'Flipkart', 'FirstCry', 'Website', 'Showroom', 'Other'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FILE_TYPES = [...IMAGE_TYPES, 'application/pdf'];
// Error codes that no retry fixes.
const SETUP_ERRORS = ['invalid_api_key', 'model_not_found', 'model_decommissioned', 'insufficient_quota', 'organization_restricted'];
// Pages of a PDF sent as images. Each image costs about 2,000 input tokens, and Groq's free tier allows about 7,000 a
// minute for the model, so only page one goes (it holds the seller, the numbers and the buyer); the printed text of the
// later pages goes along. A paid tier can take up to 3, Groq's limit per request.
const PDF_PAGE_IMAGES = 1;
// The longest wait, in seconds, for Groq's per-minute allowance before asking once more.
const MAX_RETRY_WAIT = 10;

const text = (description) => ({ type: ['string', 'null'], description });
const number = (description) => ({ type: ['number', 'null'], description });
const address = (description) => ({
  type: 'object',
  additionalProperties: false,
  description,
  properties: {
    street: text('House or flat number, building, street and area, without the city, state and PIN code.'),
    city: text('City or town.'),
    state: text('Indian state, spelled out.'),
    postal_code: text('Six digit PIN code.'),
  },
  required: ['street', 'city', 'state', 'postal_code'],
});

// Structured output: every field is required and null when the invoice does not show it.
const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_invoice: { type: 'boolean', description: 'True when the image shows an invoice, a bill, a receipt or an order details page.' },
    invoice_number: text('The invoice or bill number exactly as printed.'),
    order_id: text('The order id exactly as printed, for example TD-ORD-1009, an Amazon order id such as 402-1234567-1234567, or a Flipkart order id starting with OD.'),
    order_number: text('An order number of digits only, exactly as printed, when the invoice shows one apart from the order id, for example 00000142.'),
    invoice_date: text('The invoice date as YYYY-MM-DD.'),
    order_date: text('The order date as YYYY-MM-DD.'),
    sold_by: text('The company printed after the Sold By (or Sold by, Seller) label, exactly as printed, for example Tiffany Designs Private Limited. Fill it whenever such a label is printed, even when seller holds the same name.'),
    seller: text('The seller or store name.'),
    platform: {
      type: ['string', 'null'],
      enum: [...ORDER_SOURCES, null],
      description: 'Where it was bought: Amazon, Flipkart or FirstCry for those marketplaces, Website for the Tiffany Designs online store, Showroom for a shop bill, Other for anything else.',
    },
    customer_name: text('The buyer\'s name, from the ship-to (delivery) details when present, else the bill-to details.'),
    phone: text('The buyer\'s phone number.'),
    email: text('The buyer\'s email address.'),
    shipping_address: address('The ship-to (delivery) address, else the bill-to address.'),
    billing_address: address('The bill-to address, else the ship-to address.'),
    items: {
      type: 'array',
      description: 'Every product line on the invoice.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Product name as printed.' },
          quantity: number('Quantity.'),
          sku: text('SKU, product code, ASIN or FSN, when printed.'),
          amount: number('Line total in rupees, including tax when shown.'),
        },
        required: ['name', 'quantity', 'sku', 'amount'],
      },
    },
    total_amount: number('Invoice total in rupees.'),
  },
  required: ['is_invoice', 'invoice_number', 'order_id', 'order_number', 'invoice_date', 'order_date', 'sold_by', 'seller', 'platform',
    'customer_name', 'phone', 'email', 'shipping_address', 'billing_address', 'items', 'total_amount'],
};

// Every Tiffany Designs invoice, from its website, its showrooms or a marketplace, names the company after Sold By.
const SELLER = 'Tiffany Designs Private Limited';
const sellerWords = (name) => String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .map((w) => ({ pvt: 'private', ltd: 'limited' }[w] || w)).join(' ');

// Whether the invoice was issued by Tiffany Designs: Sold By names it ("Pvt. Ltd." counts), or, when the invoice has
// no Sold By, the seller does.
function soldByTiffany(invoice) {
  return sellerWords(invoice?.soldBy || invoice?.seller) === sellerWords(SELLER);
}

const INSTRUCTIONS = 'You read invoices and order pages for Tiffany Designs, an Indian home furniture brand that sells through its website, '
  + 'its showrooms and marketplaces such as Amazon, Flipkart and FirstCry. Customers upload a photo, a screenshot or a PDF. '
  + 'Copy every value exactly as printed, keeping letters, digits and dashes of numbers and ids. Use null for anything that is '
  + 'not printed or cannot be read clearly; never guess or complete a value. Ignore the seller\'s own address and phone number: '
  + 'addresses and the phone are the buyer\'s only. A PDF comes as images of its pages with the text printed in it; '
  + 'copy numbers and ids from that text.';

function clean(value, max = 255) {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, max) : null;
}

function isoDate(value) {
  const s = clean(value);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s ? s : null;
}

const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function cleanAddress(raw) {
  const pin = String(raw?.postal_code || '').replace(/\D/g, '');
  return {
    street: clean(raw?.street),
    city: clean(raw?.city, 40),
    state: clean(raw?.state, 80),
    postalCode: /^[1-9]\d{5}$/.test(pin) ? pin : null,
  };
}

// What the model read, trimmed and checked: a phone in +91 form, six digit PIN codes and real dates only.
function normalizeInvoice(raw) {
  const email = clean(raw?.email, 80);
  return {
    isInvoice: raw?.is_invoice === true,
    invoiceNumber: clean(raw?.invoice_number, 60),
    orderId: clean(raw?.order_id, 60),
    orderNumber: clean(raw?.order_number, 60),
    invoiceDate: isoDate(raw?.invoice_date),
    orderDate: isoDate(raw?.order_date),
    soldBy: clean(raw?.sold_by, 120),
    seller: clean(raw?.seller, 120),
    platform: ORDER_SOURCES.includes(raw?.platform) ? raw.platform : null,
    customerName: clean(raw?.customer_name, 80),
    phone: normalizePhone(clean(raw?.phone)),
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    address: cleanAddress(raw?.shipping_address),
    billingAddress: cleanAddress(raw?.billing_address),
    items: (Array.isArray(raw?.items) ? raw.items : [])
      .map((i) => ({ name: clean(i?.name), quantity: amount(i?.quantity), sku: clean(i?.sku, 60), amount: amount(i?.amount) }))
      .filter((i) => i.name)
      .slice(0, 30),
    total: amount(raw?.total_amount),
  };
}

const imagePart = (contentType, data) => ({ type: 'image_url', image_url: { url: `data:${contentType};base64,${Buffer.from(data).toString('base64')}` } });

// Reads an uploaded invoice with a Groq vision model (GROQ_OCR_MODEL), as structured fields. A PDF goes as images of
// its first pages plus the text printed in it, because the model takes no PDF files.
function createInvoiceReader({
  apiKey, model, baseUrl = 'https://api.groq.com/openai/v1', fetchImpl = (...args) => fetch(...args), readPdf = pdfPages,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 50000,
}) {
  async function read({ data, contentType }) {
    if (!FILE_TYPES.includes(contentType)) throw new Error(`Unsupported invoice file type: ${contentType}`);
    let content = [{ type: 'text', text: 'Read this invoice.' }, imagePart(contentType, data)];
    if (contentType === 'application/pdf') {
      const pdf = await readPdf(data, { maxPages: PDF_PAGE_IMAGES });
      const pages = pdf.pageCount > pdf.images.length
        ? `the image is page 1 of its ${pdf.pageCount} pages`
        : 'the image is its page';
      content = [
        { type: 'text', text: `Read this invoice. It is a PDF: ${pages}. `
          + (pdf.text ? `The text printed in the PDF:\n${pdf.text}` : 'It has no printed text, so read the image.') },
        ...pdf.images.map((image) => imagePart('image/jpeg', image)),
      ];
    }

    const request = {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema: INVOICE_SCHEMA } },
        // Copying from the page needs no thinking, and answers come back in a second or two without it.
        reasoning_effort: 'none',
        max_completion_tokens: 2000,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let res = await fetchImpl(url, request);
    // Two uploads within a minute can use up the per-minute allowance; waiting the few seconds Groq names beats asking
    // the customer to try again.
    const wait = Number(res.headers?.get?.('retry-after'));
    if (res.status === 429 && wait > 0 && wait <= MAX_RETRY_WAIT) {
      await sleep(wait * 1000);
      res = await fetchImpl(url, request);
    }
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Groq request failed (${res.status}): ${answer?.error?.message || 'no details'}`);
      // A refused key, a blocked account or an unknown model fails every reading until someone fixes the setup;
      // trying again only helps with the rest (rate limits, outages).
      err.setup = [401, 403].includes(res.status) || SETUP_ERRORS.includes(answer?.error?.code) || SETUP_ERRORS.includes(answer?.error?.type);
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(answer?.choices?.[0]?.message?.content || '');
    } catch {
      throw new Error('Groq answered without the invoice fields');
    }
    return normalizeInvoice(parsed);
  }

  return { configured: Boolean(apiKey && model), read };
}

module.exports = { createInvoiceReader, normalizeInvoice, soldByTiffany, INVOICE_SCHEMA, FILE_TYPES, IMAGE_TYPES, ORDER_SOURCES, SELLER };
