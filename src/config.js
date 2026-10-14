const env = process.env;

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Vercel sets VERCEL_PROJECT_PRODUCTION_URL (host only) on every deployment.
const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

module.exports = {
  port: int(env.PORT, 8081),
  serverless: Boolean(env.VERCEL),
  publicBaseUrl: (env.PUBLIC_BASE_URL || vercelUrl).replace(/\/+$/, ''),
  internalApiKey: env.INTERNAL_API_KEY || '',
  cronSecret: env.CRON_SECRET || '',
  // Narrow key for the website "call me" panel: it can only request a callback.
  siteCallApiKey: env.SITE_CALL_API_KEY || '',
  agentToolSecret: env.AGENT_TOOL_SECRET || '',
  webhookToken: env.SARVAM_WEBHOOK_TOKEN || '',

  sarvam: {
    baseUrl: (env.SARVAM_APPS_BASE_URL || 'https://apps.sarvam.ai').replace(/\/+$/, ''),
    apiKey: env.SARVAM_API_KEY || '',
    orgId: env.SARVAM_ORG_ID || '',
    workspaceId: env.SARVAM_WORKSPACE_ID || '',
    agentId: env.SARVAM_APP_ID || env.SARVAM_AGENT_ID || '',
    appVersion: int(env.SARVAM_APP_VERSION, 0),
    connectionId: env.SARVAM_CONNECTION_ID || '',
    agentPhone: env.SARVAM_AGENT_PHONE || '',
    followUpCampaignId: env.SARVAM_FOLLOWUP_CAMPAIGN_ID || '',
    callbackCampaignId: env.SARVAM_CALLBACK_CAMPAIGN_ID || env.SARVAM_FOLLOWUP_CAMPAIGN_ID || '',
    // Notification calls (module 13) stay off until a campaign is configured for them.
    notifyCampaignId: env.SARVAM_NOTIFY_CAMPAIGN_ID || '',
  },

  callbacks: {
    // "registered" only calls numbers that belong to a Salesforce contact; "any" calls any Indian mobile.
    allowedNumbers: env.CALLBACK_ALLOWED_NUMBERS === 'registered' ? 'registered' : 'any',
    maxPerHour: int(env.CALLBACK_MAX_PER_HOUR, 20),
    maxPerDay: int(env.CALLBACK_MAX_PER_DAY, 100),
  },

  // Browser calls started from the website widget, across all visitors.
  webCalls: {
    maxPerHour: int(env.WEB_CALLS_MAX_PER_HOUR, 30),
    maxPerDay: int(env.WEB_CALLS_MAX_PER_DAY, 200),
    // Websites allowed to host the widget, comma-separated (https://shop.example.com); "*" allows any site.
    allowedOrigins: env.WEB_CALL_ALLOWED_ORIGINS || '*',
  },

  salesforce: {
    // Developer name of the Account record type for new callers; empty uses the org default.
    customerAccountRecordType: env.SF_CUSTOMER_ACCOUNT_RECORD_TYPE || '',
    // Only products whose code starts with this are offered by phone (the org also holds sample products).
    productCodePrefix: env.PRODUCT_CODE_PREFIX ?? 'TD-',
  },

  followUpDelayMinutes: int(env.FOLLOWUP_DELAY_MINUTES, 60),
  schedulerIntervalSeconds: int(env.SCHEDULER_INTERVAL_SECONDS, 30),
  jobStorePath: env.JOB_STORE_PATH || 'data/jobs.json',

  // Upstash Redis (Vercel Marketplace). The integration names the variables KV_* or UPSTASH_REDIS_*.
  redis: {
    url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
    token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
    prefix: env.REDIS_KEY_PREFIX || 'tiffany:',
  },
};
