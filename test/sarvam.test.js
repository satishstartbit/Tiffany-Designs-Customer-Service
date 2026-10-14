const test = require('node:test');
const assert = require('node:assert/strict');
const { createSarvamClient, cohortName } = require('../src/sarvam');

const config = { baseUrl: 'https://apps.sarvam.ai', apiKey: 'sk_test', orgId: 'org1', workspaceId: 'ws1' };

function fakeFetch(status = 200, body = { status: 'processing', cohort_id: 'c1' }) {
  const requests = [];
  const impl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: status < 400, status, json: async () => body };
  };
  return { impl, requests };
}

test('addToCampaign streams users to the campaign cohort endpoint with the API key', async () => {
  const { impl, requests } = fakeFetch();
  const client = createSarvamClient(config, impl);

  const result = await client.addToCampaign('camp1', 'followup-00000101', [
    { phone: '+919876543210', identifier: 'order:801A', variables: { customer_name: 'Asha', order_number: 101, empty: null } },
  ]);

  assert.equal(result.cohort_id, 'c1');
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.equal(req.url, 'https://apps.sarvam.ai/api/scheduling/v1/orgs/org1/workspaces/ws1/campaigns/camp1/cohorts/stream');
  assert.equal(req.options.method, 'POST');
  assert.equal(req.options.headers['X-API-Key'], 'sk_test');
  assert.equal('api-subscription-key' in req.options.headers, false, 'that header is for the speech APIs only');
  assert.deepEqual(req.body, {
    name: 'followup-00000101',
    users: [{
      user_phone_number: '+919876543210',
      user_identifier: 'order:801A',
      app_variables: { customer_name: 'Asha', order_number: '101' },
    }],
  });
});

test('addToCampaign surfaces Sarvam errors', async () => {
  const { impl } = fakeFetch(422, { detail: 'campaign not active' });
  const client = createSarvamClient(config, impl);
  await assert.rejects(
    client.addToCampaign('camp1', 'x', [{ phone: '+919876543210' }]),
    /Sarvam request failed \(422\).*campaign not active/,
  );
});

test('addToCampaign refuses to run without configuration', async () => {
  const { impl, requests } = fakeFetch();
  await assert.rejects(
    createSarvamClient({ ...config, apiKey: '' }, impl).addToCampaign('camp1', 'x', []),
    /not configured/,
  );
  await assert.rejects(createSarvamClient(config, impl).addToCampaign('', 'x', []), /No Sarvam campaign id/);
  assert.equal(requests.length, 0);
});

const callConfig = { ...config, agentId: 'Tiffany-Des-0db8e21d-e099', appVersion: 1, connectionId: 'conn-1', agentPhone: '+917000000000' };

test('startCall places one instant outbound call with variables, opening line and webhook', async () => {
  const { impl, requests } = fakeFetch(200, { attempt_id: 'att-1' });
  const client = createSarvamClient(callConfig, impl);
  assert.equal(client.canStartCalls, true);

  const result = await client.startCall({
    phone: '+919876543210',
    variables: { customer_name: 'Aarav', customer_phone: '+919876543210', empty: undefined },
    overrides: { initial_bot_message: 'Hello', initial_language_name: 'English' },
    webhook: { url: 'https://voice.example.test/api/webhooks/sarvam?token=t', metadata: { identifier: 'callback:+919876543210' } },
  });

  assert.deepEqual(result, { attemptId: 'att-1' });
  const [req] = requests;
  assert.equal(req.url, 'https://apps.sarvam.ai/api/outbounds/v1/orgs/org1/workspaces/ws1/outbounds');
  assert.equal(req.options.headers['X-API-Key'], 'sk_test');
  assert.deepEqual(req.body, {
    app_config: {
      app_id: 'Tiffany-Des-0db8e21d-e099',
      app_version: 1,
      connection_config: { connection_id: 'conn-1', agent_phone_number: '+917000000000' },
      agent_variables: { customer_name: 'Aarav', customer_phone: '+919876543210' },
      app_overrides: { initial_bot_message: 'Hello', initial_language_name: 'English' },
    },
    user_config: { user_phone_number: '+919876543210' },
    webhook_config: { url: 'https://voice.example.test/api/webhooks/sarvam?token=t', metadata: { identifier: 'callback:+919876543210' } },
  });
});

test('startCall needs the agent version, connection and caller number', async () => {
  const { impl, requests } = fakeFetch();
  const client = createSarvamClient({ ...callConfig, agentPhone: '' }, impl);
  assert.equal(client.canStartCalls, false);
  await assert.rejects(client.startCall({ phone: '+919876543210' }), /SARVAM_AGENT_PHONE/);
  assert.equal(requests.length, 0);
});

test('a rejected API key is explained, not just reported', async () => {
  const { impl } = fakeFetch(401, { error: { message: '(401) Unauthorized' } });
  await assert.rejects(
    createSarvamClient(callConfig, impl).startCall({ phone: '+919876543210' }),
    /workspace API key from the Sarvam agents dashboard/,
  );
});

test('cohortName keeps only allowed characters and 50 chars', () => {
  assert.equal(cohortName('followup:ORD#1/2'), 'followup-ORD-1-2');
  assert.equal(cohortName('x'.repeat(80)).length, 50);
  assert.equal(cohortName(''), 'cohort');
});
