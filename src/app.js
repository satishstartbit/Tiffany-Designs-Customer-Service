const path = require('path');
const express = require('express');
const { requireSecret, requireAnySecret } = require('./middleware/auth');
const { createCallbackLimiter, createWebCallLimiter } = require('./rateLimit');
const ordersRouter = require('./routes/orders');
const callsRouter = require('./routes/calls');
const agentToolsRouter = require('./routes/agentTools');
const webhooksRouter = require('./routes/webhooks');
const webCallsRouter = require('./routes/webCalls');
const adminRouter = require('./routes/admin');
const cronRouter = require('./routes/cron');
const invoiceUploadsRouter = require('./routes/invoiceUploads');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// `invoices` ({ sender, reader, records, uploadLimiter }) turns on invoice upload links and the upload API.
function createApp({
  crm, sarvam, scheduler, config, checkSalesforce, limiter, webCallLimiter, consoleData, deliveryCalls, invoices, now = () => Date.now(), logger = console,
}) {
  const app = express();
  // Render and Vercel sit behind proxies; the visitor address comes from X-Forwarded-For.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  const internalKey = requireSecret(() => config.internalApiKey, (req) => req.get('x-api-key'), 'INTERNAL_API_KEY');
  const internalOrSiteKey = requireAnySecret(
    [() => config.internalApiKey, () => config.siteCallApiKey],
    (req) => req.get('x-api-key'),
    'INTERNAL_API_KEY',
  );
  const callbackLimiter = limiter || createCallbackLimiter({ perHour: config.callbacks.maxPerHour, perDay: config.callbacks.maxPerDay, now });
  const agentSecret = requireSecret(() => config.agentToolSecret, (req) => req.get('x-agent-secret'), 'AGENT_TOOL_SECRET');
  const webhookToken = requireSecret(() => config.webhookToken, (req) => req.query.token, 'SARVAM_WEBHOOK_TOKEN');
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; an external scheduler can send the same header.
  const cronSecret = requireSecret(() => config.cronSecret, (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, ''), 'CRON_SECRET');

  app.get('/', (req, res) => {
    res.json({ message: 'Tiffany Designs Customer Service API' });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Each check costs a Salesforce API call, so it is not public.
  app.get('/health/salesforce', internalKey, async (req, res) => {
    try {
      res.json({ status: 'ok', ...(await checkSalesforce()) });
    } catch (err) {
      res.status(502).json({ status: 'error', message: err.message });
    }
  });

  app.use('/api/orders', internalKey, ordersRouter({ crm, scheduler, config, now }));
  app.use('/api/calls', callsRouter({
    crm,
    sarvam,
    scheduler,
    config,
    now,
    logger,
    limiter: callbackLimiter,
    guards: { request: internalOrSiteKey, notify: internalKey },
  }));
  app.get('/api/jobs', internalKey, async (req, res) => res.json({ jobs: await scheduler.list() }));
  // Places the calls that are due; on Vercel this replaces the in-process timer.
  app.get('/api/cron/jobs', cronSecret, async (req, res) => res.json(await scheduler.tick()));
  app.use('/api/agent', agentSecret, agentToolsRouter({ crm, now, invoiceLinks: invoices?.sender }));
  if (invoices) {
    app.use('/api/invoice-uploads', invoiceUploadsRouter({
      reader: invoices.reader,
      records: invoices.records,
      limiter: invoices.uploadLimiter,
      logger,
    }));
  }
  app.use('/api/webhooks', webhookToken, webhooksRouter({ crm, now, logger }));
  if (consoleData) app.use('/api/admin', internalKey, adminRouter({ consoleData }));
  if (deliveryCalls) app.use('/cron', cronRouter({ deliveryCalls, now }));
  app.use('/api/sarvam', webCallsRouter({
    sarvam,
    config,
    crm,
    logger,
    limiter: webCallLimiter || createWebCallLimiter({ perHour: config.webCalls.maxPerHour, perDay: config.webCalls.maxPerDay, now }),
  }));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'The upload is too large.' });
    if (err.status === 503) return res.status(503).json({ error: 'not_configured', message: err.message });
    logger.error(err);
    return res.status(502).json({ error: 'Upstream request failed', detail: err.message });
  });

  return app;
}

module.exports = { createApp };
