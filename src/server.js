const config = require('./config');
const { salesforce, sfRequest } = require('./salesforce');
const { createCrm } = require('./crm/crm');
const { createConsoleData } = require('./crm/console');
const { createDeliveredOrders } = require('./crm/deliveredOrders');
const { createDeliveryCalls } = require('./deliveryCalls');
const { createSarvamClient } = require('./sarvam');
const { createRedis } = require('./redis');
const { createScheduler, createFileJobStore, createRedisJobStore, createUnavailableJobStore } = require('./scheduler');
const { createCallbackLimiter, createWebCallLimiter, createInvoiceLinkLimiter, createInvoiceUploadLimiter } = require('./rateLimit');
const { createJobHandlers } = require('./callFlows');
const { createInvoiceLinkSender } = require('./invoiceLinks');
const { createWhatsApp } = require('./whatsapp');
const { createInvoiceReader } = require('./invoiceReader');
const { createInvoiceUploads } = require('./crm/invoiceUploads');
const { createApp } = require('./app');

function createJobStore(redis) {
  if (redis) return createRedisJobStore({ redis, prefix: config.redis.prefix });
  if (config.serverless) {
    const message = 'Scheduled calls need a shared store: connect Upstash Redis (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)';
    console.error(message);
    return createUnavailableJobStore(message);
  }
  return createFileJobStore(config.jobStorePath);
}

function buildServer() {
  const redis = config.redis.url && config.redis.token ? createRedis(config.redis) : null;
  if (!redis && config.serverless) {
    console.warn('Callback rate limits are per instance until Upstash Redis is connected');
  }

  const crm = createCrm({
    salesforce,
    customerAccountRecordType: config.salesforce.customerAccountRecordType,
    productCodePrefix: config.salesforce.productCodePrefix,
  });
  const sarvam = createSarvamClient(config.sarvam);
  // Workspace keys start with sk_samvaad_ and are the right kind; other sk_ keys are speech API keys.
  if (/^sk_(?!samvaad_)/.test(config.sarvam.apiKey)) {
    console.error('SARVAM_API_KEY is a Sarvam speech API key (sk_..., not sk_samvaad_...), which the agents API refuses: web calls, instant calls and '
      + 'campaigns will fail. Create a workspace API key in the Sarvam agents dashboard (Settings, API keys).');
  }
  if (!sarvam.canStartCalls) {
    console.warn('Instant calls are off: set SARVAM_APP_VERSION, SARVAM_CONNECTION_ID and SARVAM_AGENT_PHONE');
  }
  const scheduler = createScheduler({
    store: createJobStore(redis),
    handlers: createJobHandlers({ sarvam, config }),
  });
  const limiter = createCallbackLimiter({
    perHour: config.callbacks.maxPerHour,
    perDay: config.callbacks.maxPerDay,
    redis,
    prefix: config.redis.prefix,
  });

  const webCallLimiter = createWebCallLimiter({
    perHour: config.webCalls.maxPerHour,
    perDay: config.webCalls.maxPerDay,
    redis,
    prefix: config.redis.prefix,
  });

  const consoleData = createConsoleData({ salesforce, crm, scheduler, productCodePrefix: config.salesforce.productCodePrefix });
  const deliveryCalls = createDeliveryCalls({ orders: createDeliveredOrders({ salesforce }), crm, sarvam, scheduler, config });

  const { invoiceUploads: uploads } = config;
  const whatsapp = createWhatsApp(config.whatsapp);
  const reader = createInvoiceReader(config.openai);
  const records = createInvoiceUploads({ salesforce, crm, linkDays: uploads.linkDays, productCodePrefix: config.salesforce.productCodePrefix });
  const invoices = {
    sender: createInvoiceLinkSender({
      pageUrl: `${uploads.websiteUrl}/invoice`, whatsapp, reader, records, limiter: createInvoiceLinkLimiter({ redis, prefix: config.redis.prefix }),
    }),
    reader,
    records,
    uploadLimiter: createInvoiceUploadLimiter({ perHour: uploads.maxPerHour, perDay: uploads.maxPerDay, redis, prefix: config.redis.prefix }),
  };
  if (!reader.configured) console.warn('Invoice uploads are off until OPENAI_API_KEY is set');
  if (!whatsapp.configured) console.warn('Invoice upload links are not sent on WhatsApp until WHATSAPP_API_KEY is set');

  const app = createApp({
    crm,
    sarvam,
    scheduler,
    config,
    limiter,
    webCallLimiter,
    consoleData,
    deliveryCalls,
    invoices,
    checkSalesforce: async () => {
      const limits = await sfRequest('/limits');
      return { dailyApiRequests: limits.DailyApiRequests };
    },
  });

  return { app, scheduler, config };
}

module.exports = { buildServer };
