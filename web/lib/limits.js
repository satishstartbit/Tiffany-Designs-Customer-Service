const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function positive(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Per visitor address, and overall so a flood cannot run up the Sarvam bill (same numbers as the Node server).
function rules(env) {
  return [
    { name: 'ip_10min', perVisitor: true, limit: 5, windowMs: 10 * MINUTE },
    { name: 'ip_day', perVisitor: true, limit: 20, windowMs: DAY },
    { name: 'all_hour', perVisitor: false, limit: positive(env.WEB_CALLS_MAX_PER_HOUR, 30), windowMs: HOUR },
    { name: 'all_day', perVisitor: false, limit: positive(env.WEB_CALLS_MAX_PER_DAY, 200), windowMs: DAY },
  ];
}

// Upstash Redis over its REST API; connecting it in Vercel (Storage, Marketplace) sets KV_REST_API_URL and KV_REST_API_TOKEN.
function upstash(env, fetchImpl) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return async (commands) => {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Redis request failed (${res.status})`);
    const results = await res.json();
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`Redis command failed: ${failed.error}`);
    return results.map((r) => r.result);
  };
}

// Fixed windows counted in Redis when connected; otherwise each server instance counts on its own.
export function createLimiter({ env = process.env, now = () => Date.now(), fetchImpl = (...args) => fetch(...args) } = {}) {
  const list = rules(env);
  const redis = upstash(env, fetchImpl);
  const memory = new Map();

  function windows(ip) {
    const t = now();
    return list.map((rule) => {
      const slot = Math.floor(t / rule.windowMs);
      return { rule, t, key: `tiffany-web:${rule.name}:${rule.perVisitor ? ip : 'all'}:${slot}`, endsAt: (slot + 1) * rule.windowMs };
    });
  }

  async function check(ip) {
    const current = windows(ip);
    const counts = redis
      ? (await redis(current.map((w) => ['GET', w.key]))).map((v) => Number(v) || 0)
      : current.map((w) => memory.get(w.key)?.count || 0);
    const full = current.find((w, i) => counts[i] >= w.rule.limit);
    return full ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((full.endsAt - full.t) / 1000)) } : { allowed: true };
  }

  async function record(ip) {
    const current = windows(ip);
    if (redis) {
      await redis(current.flatMap((w) => [['INCR', w.key], ['PEXPIREAT', w.key, String(w.endsAt)]]));
      return;
    }
    for (const [key, entry] of memory) if (entry.endsAt <= current[0].t) memory.delete(key);
    for (const w of current) memory.set(w.key, { count: (memory.get(w.key)?.count || 0) + 1, endsAt: w.endsAt });
  }

  return { check, record };
}
