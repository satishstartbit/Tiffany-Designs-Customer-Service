const express = require('express');

// Each run spends several Salesforce API calls, and the route is public, so runs are spaced out.
const MIN_INTERVAL_MS = 2 * 60 * 1000;

// cron-job.org calls /cron/run every 15 minutes. ?dryRun=true reports which orders would be called, and calls nobody.
module.exports = function cronRouter({ deliveryCalls, now = () => Date.now() }) {
  const router = express.Router();
  let lastRun = -Infinity;

  const run = async (req, res) => {
    const wait = lastRun + MIN_INTERVAL_MS - now();
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'too_soon', retryAfterSeconds });
    }
    lastRun = now();
    return res.json(await deliveryCalls.run({ dryRun: req.query.dryRun === 'true' }));
  };
  router.get('/run', run);
  router.post('/run', run);

  return router;
};
