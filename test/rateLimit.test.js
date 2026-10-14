const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, createRedisRateLimiter, createCallbackLimiter } = require('../src/rateLimit');
const { createFakeRedis } = require('./fakeRedis');

const MINUTE = 60 * 1000;

const backends = {
  memory: (opts) => createRateLimiter(opts),
  redis: (opts) => createRedisRateLimiter({ ...opts, redis: createFakeRedis() }),
};

for (const [kind, make] of Object.entries(backends)) {
  test.describe(`${kind} rate limiter`, () => {
    test('a rule blocks once its limit is reached and reports when to retry', async () => {
      const clock = { now: 0 };
      const limiter = make({ now: () => clock.now, rules: [{ name: 'per_key', key: (c) => c.k, limit: 2, windowMs: 10 * MINUTE }] });

      assert.equal((await limiter.check({ k: 'a' })).allowed, true);
      await limiter.record({ k: 'a' });
      clock.now = MINUTE;
      await limiter.record({ k: 'a' });

      const blocked = await limiter.check({ k: 'a' });
      assert.deepEqual(blocked, { allowed: false, rule: 'per_key', retryAfterSeconds: 9 * 60 });
      assert.equal((await limiter.check({ k: 'b' })).allowed, true, 'keys are independent');

      clock.now = 10 * MINUTE + 1;
      assert.equal((await limiter.check({ k: 'a' })).allowed, true, 'the oldest hit has left the window');
    });

    test('checking does not consume the allowance; only recording does', async () => {
      const limiter = make({ now: () => 0, rules: [{ name: 'r', key: () => 'x', limit: 1, windowMs: MINUTE }] });
      for (let i = 0; i < 5; i += 1) assert.equal((await limiter.check({})).allowed, true);
      await limiter.record({});
      assert.equal((await limiter.check({})).allowed, false);
    });
  });
}

test('old keys are pruned when the map grows', async () => {
  const clock = { now: 0 };
  const limiter = createRateLimiter({ now: () => clock.now, maxKeys: 2, rules: [{ name: 'r', key: (c) => c.k, limit: 1, windowMs: MINUTE }] });
  await limiter.record({ k: 'a' });
  await limiter.record({ k: 'b' });
  await limiter.record({ k: 'c' });
  clock.now = 2 * MINUTE;
  await limiter.record({ k: 'd' });
  assert.equal((await limiter.check({ k: 'a' })).allowed, true);
});

for (const [kind, redis] of [['memory', null], ['redis', createFakeRedis()]]) {
  test(`callback limits (${kind}): 1 per number per 15 minutes, 3 per number per day, and overall caps`, async () => {
    const clock = { now: 0 };
    const limiter = createCallbackLimiter({ perHour: 3, perDay: 5, now: () => clock.now, redis });
    await limiter.record({ phone: '+919000000001' });
    assert.equal((await limiter.check({ phone: '+919000000001' })).rule, 'number_15min');

    await limiter.record({ phone: '+919000000002' });
    await limiter.record({ phone: '+919000000003' });
    assert.equal((await limiter.check({ phone: '+919000000004' })).rule, 'all_hour');
  });
}

test('two instances sharing Redis share the limits', async () => {
  const redis = createFakeRedis();
  const rules = [{ name: 'r', key: () => 'x', limit: 1, windowMs: MINUTE }];
  const first = createRedisRateLimiter({ redis, rules, now: () => 0 });
  const second = createRedisRateLimiter({ redis, rules, now: () => 0 });
  await first.record({});
  assert.equal((await second.check({})).allowed, false);
});
