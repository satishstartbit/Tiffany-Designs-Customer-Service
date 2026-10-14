// Stand-in for src/redis.js covering the commands the job store and rate limiter send.
function createFakeRedis() {
  const data = new Map();
  const hash = (k) => { if (!data.has(k)) data.set(k, new Map()); return data.get(k); };
  const zset = (k) => { if (!data.has(k)) data.set(k, []); return data.get(k); };
  const sent = [];

  const commands = {
    HGET: (k, f) => (data.get(k)?.get(f) ?? null),
    HSET: (k, f, v) => { const h = hash(k); const isNew = !h.has(f); h.set(f, v); return isNew ? 1 : 0; },
    HSETNX: (k, f, v) => { const h = hash(k); if (h.has(f)) return 0; h.set(f, v); return 1; },
    HVALS: (k) => [...(data.get(k)?.values() || [])],
    SET: (k, v, ...opts) => {
      if (opts.includes('NX') && data.has(k)) return null;
      data.set(k, v);
      return 'OK';
    },
    EVAL: (script, numKeys, k, owner) => {
      if (data.get(k) !== owner) return 0;
      data.delete(k);
      return 1;
    },
    ZADD: (k, score, member) => { zset(k).push([member, Number(score)]); zset(k).sort((a, b) => a[1] - b[1]); return 1; },
    ZREMRANGEBYSCORE: (k, min, max) => {
      const before = zset(k).length;
      data.set(k, zset(k).filter(([, s]) => s > Number(max)));
      return before - data.get(k).length;
    },
    ZCARD: (k) => zset(k).length,
    ZRANGE: (k, start, stop) => zset(k).slice(Number(start), Number(stop) + 1).flatMap(([m, s]) => [m, String(s)]),
    PEXPIRE: () => 1,
  };

  async function pipeline(list) {
    return list.map(([name, ...args]) => {
      sent.push(name);
      if (!commands[name]) throw new Error(`fake Redis has no ${name}`);
      return commands[name](...args);
    });
  }

  return { data, sent, pipeline, command: async (...args) => (await pipeline([args]))[0] };
}

module.exports = { createFakeRedis };
