// Vercel entry point: every path is rewritten here (vercel.json), and Vercel Cron runs due jobs via /api/cron/jobs.
const { buildServer } = require('../src/server');

module.exports = buildServer().app;
