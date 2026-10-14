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

  return { addToCampaign, startCall, canStartCalls };
}

module.exports = { createSarvamClient, cohortName };
