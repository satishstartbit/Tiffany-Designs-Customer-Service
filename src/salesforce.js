const API_VERSION = 'v62.0';

let cachedToken = null;

function loginUrl() {
  const url = (process.env.SF_LOGIN_URL || '').replace(/\/+$/, '');
  if (!url) throw new Error('SF_LOGIN_URL is not set');
  if (/login\.salesforce\.com|my\.salesforce-setup\.com/.test(url)) {
    throw new Error('SF_LOGIN_URL must be your My Domain URL (https://<domain>.my.salesforce.com)');
  }
  return url;
}

async function getAccessToken({ force = false } = {}) {
  if (cachedToken && !force) return cachedToken;

  const res = await fetch(`${loginUrl()}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Salesforce token request failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`.trim());
  }

  cachedToken = { accessToken: data.access_token, instanceUrl: data.instance_url };
  return cachedToken;
}

async function sfRequest(path, options = {}, retried = false) {
  const { accessToken, instanceUrl } = await getAccessToken();
  const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 401 && !retried) {
    await getAccessToken({ force: true });
    return sfRequest(path, options, true);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Salesforce request failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Saves several records in one call; with allOrNone nothing is kept if any record fails.
async function createMany(sobject, records) {
  const results = await sfRequest('/composite/sobjects', {
    method: 'POST',
    body: JSON.stringify({ allOrNone: true, records: records.map((r) => ({ attributes: { type: sobject }, ...r })) }),
  });
  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    throw new Error(`Salesforce rejected ${sobject} records: ${failed.flatMap((r) => r.errors || []).map((e) => e.message).join('; ')}`);
  }
  return results.map((r) => r.id);
}

const salesforce = {
  query: (soql) => sfRequest(`/query?q=${encodeURIComponent(soql)}`).then((r) => r.records),
  search: (sosl) => sfRequest(`/search?q=${encodeURIComponent(sosl)}`).then((r) => r.searchRecords || []),
  describe: (sobject) => sfRequest(`/sobjects/${sobject}/describe`),
  create: (sobject, fields) => sfRequest(`/sobjects/${sobject}`, { method: 'POST', body: JSON.stringify(fields) }),
  createMany,
  update: (sobject, id, fields) => sfRequest(`/sobjects/${sobject}/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  remove: (sobject, id) => sfRequest(`/sobjects/${sobject}/${id}`, { method: 'DELETE' }),
};

module.exports = { getAccessToken, sfRequest, salesforce };
