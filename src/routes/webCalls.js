const express = require('express');
const { normalizePhone } = require('../rules');

const INTERACTION_TYPES = ['call', 'chat'];

// The website's Sarvam call widget (the Next.js site in web/) asks here for a signed call URL, so the
// Sarvam API key stays on the server. The route is public, so it is limited to this project's agent and rate-limited.
// With the mobile number the customer typed (X-Caller-Phone), the answer also names the customer's first name, so the
// page can pass it to the agent; only on a call link, so within the same limits.
module.exports = function webCallsRouter({ sarvam, config, limiter, crm, logger = console }) {
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
      'Access-Control-Allow-Headers': 'X-API-Key, X-Caller-Phone, Content-Type',
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
      // The visitor's widget shows this message, so it names no setting; the log says what is missing.
      logger.error('Web calls are off: set SARVAM_API_KEY, SARVAM_ORG_ID, SARVAM_WORKSPACE_ID and SARVAM_AGENT_ID.');
      return res.status(503).json({ error: 'not_configured', message: 'Calls are not available right now. Please try again later.' });
    }

    const visitor = { ip: req.ip };
    const verdict = await limiter.check(visitor);
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many calls were started. Please try again later.' });
    }

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
      // Only a call link counts toward the limits, so attempts that fail on the server's side cost the visitor nothing.
      const linked = upstream.status >= 200 && upstream.status < 300;
      if (linked) await limiter.record(visitor);
      if (upstream.retryAfter) res.set('Retry-After', upstream.retryAfter);
      res.set('Cache-Control', 'no-store');
      const phone = normalizePhone(req.get('x-caller-phone'));
      if (linked && crm && phone && /^\+91[6-9]\d{9}$/.test(phone)) {
        try {
          const contact = await crm.findContactByPhone(phone);
          const firstName = contact ? contact.firstName || String(contact.name || '').trim().split(/\s+/)[0] || null : null;
          return res.status(upstream.status).json({ ...JSON.parse(upstream.body), caller: { first_name: firstName } });
        } catch (err) {
          logger.error(`Looking up the web caller failed: ${err.message}`);
        }
      }
      return res.status(upstream.status).type('application/json').send(upstream.body);
    } catch (err) {
      logger.error(`Web call session failed: ${err.message}`);
      return res.status(502).json({ error: 'upstream_failed', message: 'The call could not be started. Please try again.' });
    }
  });

  return router;
};
