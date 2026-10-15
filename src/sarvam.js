function cohortName(label) {
  const clean = String(label).replace(/[^A-Za-z0-9 _-]/g, '-').replace(/-+/g, '-');
  return clean.slice(0, 50) || 'cohort';
}

function strings(map) {
  return Object.fromEntries(
    Object.entries(map || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
}

// A key pasted into a hosting dashboard often keeps its .env quotes or the whole NAME=value line,
// and Sarvam refuses a quoted key as "Invalid API key format".
function cleanApiKey(value) {
  return String(value || '').trim()
    .replace(/^SARVAM_API_KEY\s*=\s*/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

function createSarvamClient({ baseUrl, apiKey, orgId, workspaceId, agentId, appVersion, connectionId, agentPhone }, fetchImpl = fetch) {
  async function request(service, path, body) {
    if (!apiKey || !orgId || !workspaceId) {
      throw new Error('Sarvam is not configured: SARVAM_API_KEY, SARVAM_ORG_ID and SARVAM_WORKSPACE_ID are required');
    }
    const res = await fetchImpl(`${baseUrl}/api/${service}/v1/orgs/${orgId}/workspaces/${workspaceId}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) {
      throw new Error('Sarvam rejected the API key: SARVAM_API_KEY must be a workspace API key from the Sarvam agents dashboard');
    }
    if (!res.ok) {
      throw new Error(`Sarvam request failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  // Adds people to a running campaign's dial list. Variables must be declared on the agent.
  async function addToCampaign(campaignId, label, users) {
    if (!campaignId) throw new Error('No Sarvam campaign id configured');
    const payload = users.map((u) => ({
      user_phone_number: u.phone,
      user_identifier: u.identifier || null,
      app_variables: strings(u.variables),
      ...(u.overrides ? { app_overrides: strings(u.overrides) } : {}),
    }));
    return request('scheduling', `/campaigns/${campaignId}/cohorts/stream`, { name: cohortName(label), users: payload });
  }

  const canStartCalls = Boolean(agentId && appVersion && connectionId && agentPhone);

  // One call, dialled now (Sarvam Instant Outbound). No campaign needed.
  async function startCall({ phone, variables, overrides, webhook }) {
    if (!canStartCalls) {
      throw new Error('Instant calls need SARVAM_AGENT_ID, SARVAM_APP_VERSION, SARVAM_CONNECTION_ID and SARVAM_AGENT_PHONE');
    }
    const data = await request('outbounds', '/outbounds', {
      app_config: {
        app_id: agentId,
        app_version: appVersion,
        connection_config: { connection_id: connectionId, agent_phone_number: agentPhone },
        agent_variables: strings(variables),
        ...(overrides ? { app_overrides: strings(overrides) } : {}),
      },
      user_config: { user_phone_number: phone },
      ...(webhook ? { webhook_config: webhook } : {}),
    });
    return { attemptId: data?.attempt_id || null };
  }

  const canStartWebCalls = Boolean(apiKey && orgId && workspaceId && agentId);

  // A short-lived signed WebSocket URL for one browser call with this agent. Sarvam's status and body are returned
  // as they are, because the website widget reads them directly.
  async function getWebCallUrl(query = {}) {
    if (!canStartWebCalls) {
      throw new Error('Web calls need SARVAM_API_KEY, SARVAM_ORG_ID, SARVAM_WORKSPACE_ID and SARVAM_AGENT_ID');
    }
    const params = new URLSearchParams(strings(query)).toString();
    const res = await fetchImpl(
      `${baseUrl}/api/app-runtime/orgs/${orgId}/workspaces/${workspaceId}/apps/${agentId}/url${params ? `?${params}` : ''}`,
      { method: 'GET', headers: { 'X-API-Key': apiKey } },
    );
    return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') };
  }

  return { addToCampaign, startCall, canStartCalls, getWebCallUrl, canStartWebCalls };
}

module.exports = { createSarvamClient, cohortName, cleanApiKey };
