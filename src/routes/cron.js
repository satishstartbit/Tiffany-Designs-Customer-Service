const express = require('express');

// cron-job.org calls /cron/run every 15 minutes. ?dryRun=true reports which orders would be called, and calls nobody.
module.exports = function cronRouter({ deliveryCalls }) {
  const router = express.Router();

  const run = async (req, res) => res.json(await deliveryCalls.run({ dryRun: req.query.dryRun === 'true' }));
  router.get('/run', run);
  router.post('/run', run);

  return router;
};
