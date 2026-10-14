// Minimal client for Upstash Redis over its REST API, so serverless instances share state without a socket pool.
function createRedis({ url, token, fetchImpl = (...args) => fetch(...args) }) {
  const base = url.replace(/\/+$/, '');

  async function pipeline(commands) {
    const res = await fetchImpl(`${base}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Redis request failed (${res.status}): ${await res.text().catch(() => '')}`);
    const results = await res.json();
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`Redis command failed: ${failed.error}`);
    return results.map((r) => r.result);
  }

  return {
    pipeline,
    command: async (...args) => (await pipeline([args]))[0],
  };
}

module.exports = { createRedis };
