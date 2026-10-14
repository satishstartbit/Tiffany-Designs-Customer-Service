const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createScheduler,
  createMemoryJobStore,
  createFileJobStore,
  createRedisJobStore,
  createUnavailableJobStore,
  MAX_ATTEMPTS,
} = require('../src/scheduler');
const { createFakeRedis } = require('./fakeRedis');

const quiet = { error() {} };

function setup(handler, store = createMemoryJobStore()) {
  const clock = { now: Date.parse('2026-10-14T06:00:00Z') };
  const ran = [];
  const scheduler = createScheduler({
    store,
    handlers: { ping: async (payload) => { ran.push(payload); return handler ? handler(payload) : 'ok'; } },
    now: () => clock.now,
    logger: quiet,
  });
  return { clock, ran, scheduler };
}

const stores = {
  memory: () => createMemoryJobStore(),
  redis: () => createRedisJobStore({ redis: createFakeRedis() }),
};

for (const [kind, makeStore] of Object.entries(stores)) {
  test.describe(`scheduler with the ${kind} store`, () => {
    test('a job runs only once it is due', async () => {
      const { clock, ran, scheduler } = setup(null, makeStore());
      await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now + 60 * 60 * 1000, payload: { n: 1 } });

      await scheduler.tick();
      assert.equal(ran.length, 0);

      clock.now += 59 * 60 * 1000;
      await scheduler.tick();
      assert.equal(ran.length, 0);

      clock.now += 60 * 1000;
      assert.deepEqual(await scheduler.tick(), { due: 1, done: 1, failed: 0 });
      assert.deepEqual(ran, [{ n: 1 }]);
      assert.equal((await scheduler.list())[0].status, 'done');

      await scheduler.tick();
      assert.equal(ran.length, 1, 'a done job never runs again');
    });

    test('scheduling the same id twice keeps the first job', async () => {
      const { clock, scheduler } = setup(null, makeStore());
      const first = await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now, payload: { v: 1 } });
      const second = await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now + 1000, payload: { v: 2 } });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.deepEqual(second.job.payload, { v: 1 });
      assert.equal((await scheduler.list()).length, 1);
    });

    test('a failing job is retried, then marked failed after the attempt limit', async () => {
      const { clock, scheduler } = setup(() => { throw new Error('boom'); }, makeStore());
      await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now, payload: {} });

      for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
        await scheduler.tick();
        const [job] = await scheduler.list();
        assert.equal(job.attempts, i);
        assert.equal(job.lastError, 'boom');
        assert.equal(job.status, i < MAX_ATTEMPTS ? 'pending' : 'failed');
        clock.now += 5 * 60 * 1000;
      }
    });

    test('a cancelled job does not run', async () => {
      const { clock, ran, scheduler } = setup(null, makeStore());
      await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now, payload: {} });
      assert.equal(await scheduler.cancel('j1'), true);
      await scheduler.tick();
      assert.equal(ran.length, 0);
      assert.equal(await scheduler.cancel('missing'), false);
    });

    test('a job with no handler is marked failed', async () => {
      const { clock, scheduler } = setup(null, makeStore());
      await scheduler.schedule({ id: 'j1', type: 'unknown', runAt: clock.now, payload: {} });
      await scheduler.tick();
      assert.equal((await scheduler.list())[0].status, 'failed');
    });
  });
}

test('a run is skipped while another instance holds the Redis lock, and the lock is freed afterwards', async () => {
  const redis = createFakeRedis();
  const { clock, ran, scheduler } = setup(null, createRedisJobStore({ redis }));
  await scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now, payload: {} });

  redis.data.set('tiffany:lock:tick', 'another-instance');
  assert.deepEqual(await scheduler.tick(), { skipped: true });
  assert.equal(ran.length, 0);

  redis.data.delete('tiffany:lock:tick');
  await scheduler.tick();
  assert.equal(ran.length, 1);
  assert.equal(redis.data.has('tiffany:lock:tick'), false);
});

test('without a shared store, scheduling fails with a 503 instead of losing the job', async () => {
  const { clock, scheduler } = setup(null, createUnavailableJobStore('connect Redis'));
  await assert.rejects(
    scheduler.schedule({ id: 'j1', type: 'ping', runAt: clock.now, payload: {} }),
    (err) => err.status === 503 && err.message === 'connect Redis',
  );
});

test('the file store keeps jobs across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const file = path.join(dir, 'nested', 'jobs.json');
  const first = createFileJobStore(file);
  assert.equal(first.create({ id: 'j1', status: 'pending' }), true);
  assert.equal(first.create({ id: 'j1', status: 'other' }), false);

  const reloaded = createFileJobStore(file);
  assert.deepEqual(reloaded.get('j1'), { id: 'j1', status: 'pending' });
  fs.rmSync(dir, { recursive: true, force: true });
});
