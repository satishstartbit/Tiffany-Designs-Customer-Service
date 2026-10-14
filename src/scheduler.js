const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
// Longer than the function's maxDuration in vercel.json, so a run that is cut off frees the lock.
const TICK_LOCK_MS = 2 * 60 * 1000;

function createFileJobStore(filePath) {
  function load() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }
  let jobs = load();
  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, filePath);
  }
  return {
    get: (id) => jobs[id] || null,
    create: (job) => {
      if (jobs[job.id]) return false;
      jobs[job.id] = job;
      save();
      return true;
    },
    put: (job) => { jobs[job.id] = job; save(); },
    all: () => Object.values(jobs),
  };
}

function createMemoryJobStore() {
  const jobs = {};
  return {
    get: (id) => jobs[id] || null,
    create: (job) => {
      if (jobs[job.id]) return false;
      jobs[job.id] = job;
      return true;
    },
    put: (job) => { jobs[job.id] = job; },
    all: () => Object.values(jobs),
  };
}

const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Shared by every serverless instance; the lock keeps two overlapping runs from placing the same call twice.
function createRedisJobStore({ redis, prefix = 'tiffany:' }) {
  const key = `${prefix}jobs`;
  const parse = (value) => (value ? JSON.parse(value) : null);
  return {
    get: async (id) => parse(await redis.command('HGET', key, id)),
    create: async (job) => (await redis.command('HSETNX', key, job.id, JSON.stringify(job))) === 1,
    put: async (job) => { await redis.command('HSET', key, job.id, JSON.stringify(job)); },
    all: async () => ((await redis.command('HVALS', key)) || []).map(parse),
    async lock(name, ttlMs) {
      const lockKey = `${prefix}lock:${name}`;
      const owner = crypto.randomUUID();
      const acquired = await redis.command('SET', lockKey, owner, 'NX', 'PX', String(ttlMs));
      if (acquired !== 'OK') return null;
      return () => redis.command('EVAL', RELEASE_LOCK, '1', lockKey, owner);
    },
  };
}

// Stands in when no shared store is configured on a serverless host, where a local file would be lost.
function createUnavailableJobStore(message) {
  const fail = () => {
    const err = new Error(message);
    err.status = 503;
    throw err;
  };
  return { get: fail, create: fail, put: fail, all: fail };
}

function createScheduler({ store, handlers, now = () => Date.now(), logger = console }) {
  let timer = null;
  let running = false;

  // Same id twice is a no-op, so a repeated "delivered" event never schedules a second call.
  async function schedule({ id, type, runAt, payload }) {
    const job = {
      id,
      type,
      runAt: new Date(runAt).toISOString(),
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(now()).toISOString(),
    };
    if (await store.create(job)) return { job, created: true };
    return { job: await store.get(id), created: false };
  }

  async function cancel(id) {
    const job = await store.get(id);
    if (!job || job.status !== 'pending') return false;
    await store.put({ ...job, status: 'cancelled' });
    return true;
  }

  async function runDue() {
    const due = (await store.all()).filter((j) => j.status === 'pending' && Date.parse(j.runAt) <= now());
    const summary = { due: due.length, done: 0, failed: 0 };
    for (const job of due) {
      const handler = handlers[job.type];
      if (!handler) {
        await store.put({ ...job, status: 'failed', lastError: `No handler for ${job.type}` });
        summary.failed += 1;
        continue;
      }
      try {
        const result = await handler(job.payload, job);
        await store.put({ ...job, status: 'done', attempts: job.attempts + 1, completedAt: new Date(now()).toISOString(), result });
        summary.done += 1;
      } catch (err) {
        const attempts = job.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await store.put({
          ...job,
          attempts,
          status: failed ? 'failed' : 'pending',
          runAt: failed ? job.runAt : new Date(now() + RETRY_DELAY_MS).toISOString(),
          lastError: err.message,
        });
        if (failed) summary.failed += 1;
        logger.error(`Job ${job.id} attempt ${attempts} failed: ${err.message}`);
      }
    }
    return summary;
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    let release = null;
    try {
      if (store.lock) {
        release = await store.lock('tick', TICK_LOCK_MS);
        if (!release) return { skipped: true };
      }
      return await runDue();
    } finally {
      running = false;
      if (release) await release().catch((err) => logger.error(`Releasing the job lock failed: ${err.message}`));
    }
  }

  function start(intervalSeconds) {
    timer = setInterval(() => { tick().catch((err) => logger.error(err)); }, intervalSeconds * 1000);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { schedule, cancel, tick, start, stop, list: async () => store.all() };
}

module.exports = {
  createScheduler,
  createFileJobStore,
  createMemoryJobStore,
  createRedisJobStore,
  createUnavailableJobStore,
  MAX_ATTEMPTS,
};
