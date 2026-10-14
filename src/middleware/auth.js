const crypto = require('crypto');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requireSecret(getExpected, readProvided, label) {
  return requireAnySecret([getExpected], readProvided, label);
}

// Passes when the provided value matches any configured secret.
function requireAnySecret(getExpectedList, readProvided, label) {
  return (req, res, next) => {
    const expected = getExpectedList.map((get) => get()).filter(Boolean);
    if (!expected.length) return res.status(503).json({ error: `${label} is not configured on the server` });
    const provided = readProvided(req);
    if (!expected.some((secret) => safeEqual(provided, secret))) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  };
}

module.exports = { requireSecret, requireAnySecret, safeEqual };
