const express = require('express');

const STATUS = { phone: 400, empty: 400, ended: 410, busy: 409, busy_model: 503, not_configured: 503 };

// The website chat (src/chat/chatAgent.js), for the Next.js site, which calls it with its server key (NODE_API_KEY)
// and counts each new chat against the same per-visitor limits as a website call. The chat's tools run through this
// server's own /api/agent, as a call's do, marked as the website chat so a request it registers says so.
module.exports = function chatRouter({ chat, config, logger = console }) {
  const router = express.Router();

  const callTool = (req) => async (toolPath, body) => {
    const res = await fetch(`http://127.0.0.1:${req.socket.localPort}${toolPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': config.agentToolSecret, 'x-channel': 'chat' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`${toolPath} answered ${res.status}`);
    return res.json();
  };

  const answer = (res, result) => (result.error
    ? res.status(STATUS[result.error] || 400).json({ error: result.error, message: result.message })
    : res.json(result));

  router.post('/sessions', async (req, res) => {
    const result = await chat.start({ phone: req.body?.phone, callTool: callTool(req) });
    if (result.error) return answer(res, result);
    return res.json({ session_id: result.id, reply: result.reply, first_name: result.firstName });
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const result = await chat.send({ id: req.params.id, text: req.body?.text, callTool: callTool(req) });
    if (result.error) logger.warn(`[chat] ${req.params.id.slice(0, 8)}: ${result.error}`);
    return answer(res, result);
  });

  router.delete('/sessions/:id', (req, res) => {
    chat.end(req.params.id);
    res.status(204).end();
  });

  return router;
};
