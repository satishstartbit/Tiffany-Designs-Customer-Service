const express = require('express');

const INTERACTION_TYPES = ['call', 'chat'];

// The website's Sarvam call widget (session-endpoint="/api/sarvam/") asks here for a signed call URL, so the
// Sarvam API key stays on the server. The route is public, so it is limited to this project's agent and rate-limited.
module.exports = function webCallsRouter({ sarvam, config, limiter, logger = console }) {
  const router = express.Router();
  const allowedOrigins = String(config.webCalls?.allowedOrigins || '*').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const anyOrigin = allowedOrigins.includes('*');

  // The widget may sit on another site (or a page opened from disk, origin "null"), so browsers need CORS.
  // It sends an X-API-Key header (empty in this mode), which makes the browser ask first with OPTIONS.
  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next();
    if (!anyOrigin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'origin_not_allowed', message: 'This website may not start Tiffany Designs calls.' });
    }
    res.set({
      'Access-Control-Allow-Origin': anyOrigin ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
      'Access-Control-Expose-Headers': 'Retry-After',
      'Access-Control-Max-Age': '600',
    });
    if (!anyOrigin) res.vary('Origin');
    return req.method === 'OPTIONS' ? res.sendStatus(204) : next();
  });

  router.get('/orgs/:orgId/workspaces/:workspaceId/apps/:appId/url', async (req, res) => {
    const { orgId, workspaceId, agentId, appVersion } = config.sarvam;
    // The key works for every agent in the shared workspace; only the Tiffany agent may be reached through it.
    if (req.params.orgId !== orgId || req.params.workspaceId !== workspaceId || req.params.appId !== agentId) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!sarvam.canStartWebCalls) {
      return res.status(503).json({ error: 'not_configured', message: 'Web calls need SARVAM_API_KEY on the server.' });
    }

    const visitor = { ip: req.ip };
    const verdict = await limiter.check(visitor);
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many calls were started. Please try again later.' });
    }
    await limiter.record(visitor);

    const interactionType = INTERACTION_TYPES.includes(req.query.interaction_type) ? req.query.interaction_type : 'call';
    try {
      // The server's agent version wins over the browser's, so website and phone calls reach the same version.
      const upstream = await sarvam.getWebCallUrl({ interaction_type: interactionType, version: appVersion || undefined });
      // A refused key is the server's setup, not the visitor's; Sarvam's wording would only confuse the caller.
      if (upstream.status === 401 || upstream.status === 403) {
        logger.error(`Sarvam refused SARVAM_API_KEY for a web call (${upstream.status}): ${upstream.body}. `
          + 'It must be a current workspace API key (sk_samvaad_...) from the Sarvam agents dashboard (Settings, API keys); '
          + 'a speech API key or a deleted workspace key is refused.');
        return res.status(503).json({ error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
      }
      if (upstream.retryAfter) res.set('Retry-After', upstream.retryAfter);
      res.set('Cache-Control', 'no-store');
      return res.status(upstream.status).type('application/json').send(upstream.body);
    } catch (err) {
      logger.error(`Web call session failed: ${err.message}`);
      return res.status(502).json({ error: 'upstream_failed', message: 'The call could not be started. Please try again.' });
    }
  });

  return router;
};
