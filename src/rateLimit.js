const crypto = require('crypto');

function blocked(rule, oldest, t) {
  return { allowed: false, rule: rule.name, retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - t) / 1000)) };
}

// Sliding-window limits held in memory. Enough for a single server instance;
// several instances (serverless) need the Redis limiter below.
function createRateLimiter({ rules, now = () => Date.now(), maxKeys = 10000 }) {
  const hits = new Map();

  function recent(key, rule, t) {
    const list = (hits.get(key) || []).filter((ts) => ts > t - rule.windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  async function check(ctx) {
    const t = now();
    for (const rule of rules) {
      const list = recent(`${rule.name}:${rule.key(ctx)}`, rule, t);
      if (list.length >= rule.limit) return blocked(rule, list[0], t);
    }
    return { allowed: true };
  }

  async function record(ctx) {
    const t = now();
    if (hits.size > maxKeys) {
      for (const key of hits.keys()) {
        const rule = rules.find((r) => key.startsWith(`${r.name}:`));
        if (rule) recent(key, rule, t);
      }
    }
    for (const rule of rules) {
      const key = `${rule.name}:${rule.key(ctx)}`;
      hits.set(key, [...(hits.get(key) || []), t]);
    }
  }

  return { check, record };
}

// The same sliding windows as sorted sets (score = hit time), shared by every instance.
function createRedisRateLimiter({ redis, rules, prefix = 'tiffany:', now = () => Date.now() }) {
  const keyFor = (rule, ctx) => `${prefix}rl:${rule.name}:${rule.key(ctx)}`;

  async function check(ctx) {
    const t = now();
    const commands = rules.flatMap((rule) => {
      const key = keyFor(rule, ctx);
      return [
        ['ZREMRANGEBYSCORE', key, '-inf', String(t - rule.windowMs)],
        ['ZCARD', key],
        ['ZRANGE', key, '0', '0', 'WITHSCORES'],
      ];
    });
    const results = await redis.pipeline(commands);
    for (const [i, rule] of rules.entries()) {
      const count = results[i * 3 + 1];
      const oldest = results[i * 3 + 2];
      if (count >= rule.limit) return blocked(rule, Number(oldest[1]), t);
    }
    return { allowed: true };
  }

  async function record(ctx) {
    const t = now();
    const member = `${t}:${crypto.randomUUID()}`;
    await redis.pipeline(rules.flatMap((rule) => {
      const key = keyFor(rule, ctx);
      return [['ZADD', key, String(t), member], ['PEXPIRE', key, String(rule.windowMs)]];
    }));
  }

  return { check, record };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function callbackRules({ perHour, perDay }) {
  return [
    { name: 'number_15min', key: (c) => c.phone, limit: 1, windowMs: 15 * MINUTE },
    { name: 'number_day', key: (c) => c.phone, limit: 3, windowMs: DAY },
    { name: 'all_hour', key: () => 'all', limit: perHour, windowMs: HOUR },
    { name: 'all_day', key: () => 'all', limit: perDay, windowMs: DAY },
  ];
}

function createCallbackLimiter({ perHour, perDay, now, redis, prefix }) {
  const rules = callbackRules({ perHour, perDay });
  return redis ? createRedisRateLimiter({ redis, rules, prefix, now }) : createRateLimiter({ rules, now });
}

// Browser calls from the website widget: per visitor address, and overall so a flood cannot run up the bill.
function webCallRules({ perHour, perDay }) {
  return [
    { name: 'web_ip_10min', key: (c) => c.ip, limit: 5, windowMs: 10 * MINUTE },
    { name: 'web_ip_day', key: (c) => c.ip, limit: 20, windowMs: DAY },
    { name: 'web_all_hour', key: () => 'all', limit: perHour, windowMs: HOUR },
    { name: 'web_all_day', key: () => 'all', limit: perDay, windowMs: DAY },
  ];
}

function createWebCallLimiter({ perHour, perDay, now, redis, prefix }) {
  const rules = webCallRules({ perHour, perDay });
  return redis ? createRedisRateLimiter({ redis, rules, prefix, now }) : createRateLimiter({ rules, now });
}

// Invoice upload links the voice agent sends on WhatsApp: per number, so a caller cannot flood someone's WhatsApp.
function invoiceLinkRules() {
  return [
    { name: 'invoice_link_number_day', key: (c) => c.phone, limit: 3, windowMs: DAY },
    { name: 'invoice_link_all_day', key: () => 'all', limit: 300, windowMs: DAY },
  ];
}

function createInvoiceLinkLimiter({ now, redis, prefix } = {}) {
  const rules = invoiceLinkRules();
  return redis ? createRedisRateLimiter({ redis, rules, prefix, now }) : createRateLimiter({ rules, now });
}

// Uploads to the public invoice page, each a paid AI call: per visitor, and overall.
function invoiceUploadRules({ perHour, perDay }) {
  return [
    { name: 'invoice_upload_ip_hour', key: (c) => c.ip, limit: 10, windowMs: HOUR },
    { name: 'invoice_upload_ip_day', key: (c) => c.ip, limit: 20, windowMs: DAY },
    { name: 'invoice_upload_all_hour', key: () => 'all', limit: perHour, windowMs: HOUR },
    { name: 'invoice_upload_all_day', key: () => 'all', limit: perDay, windowMs: DAY },
  ];
}

function createInvoiceUploadLimiter({ perHour, perDay, now, redis, prefix }) {
  const rules = invoiceUploadRules({ perHour, perDay });
  return redis ? createRedisRateLimiter({ redis, rules, prefix, now }) : createRateLimiter({ rules, now });
}

module.exports = {
  createRateLimiter, createRedisRateLimiter, createCallbackLimiter, createWebCallLimiter, createInvoiceLinkLimiter, createInvoiceUploadLimiter,
};
