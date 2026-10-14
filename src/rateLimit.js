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

module.exports = { createRateLimiter, createRedisRateLimiter, createCallbackLimiter };
