// The website chat run by the Node server: the Groq client with its fallback across models, the voice agent's tools as
// the chat calls them, the conversation loop, and the /api/chat route (Sarvam has no text chat for the voice agent).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createGroqChat } = require('../src/chat/groqChat');
const { createChatTools, CHAT_TOOLS } = require('../src/chat/chatTools');
const { createChatAgent, recent } = require('../src/chat/chatAgent');
const chatRouter = require('../src/routes/chat');

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('the Groq client moves to the next model when one is rate limited, and waits only when all are', async () => {
  const asked = [];
  let clock = 0;
  const answers = {
    'openai/gpt-oss-120b': [reply(429, { error: 'rate' }, { 'retry-after': '3' }), reply(200, { choices: [{ message: { content: 'later' } }] })],
    'openai/gpt-oss-20b': [reply(429, { error: 'rate' }, { 'x-ratelimit-reset-tokens': '1.5s' }), reply(200, { choices: [{ message: { content: 'later' } }] })],
    'qwen/qwen3.8-27b': [reply(429, { error: 'rate' }, { 'retry-after': '9' })],
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    return answers[body.model].shift();
  };
  const llm = createGroqChat({ apiKey: 'k', fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, logger: { warn() {} } });
  const { model, message } = await llm.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.deepEqual(asked.map((b) => b.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
  assert.equal(clock, 1500, 'it waited only until the first model was free again (gpt-oss-20b, at 1.5 s)');
  assert.equal(model, 'openai/gpt-oss-20b');
  assert.equal(message.content, 'later');
  assert.equal(asked[0].reasoning_effort, 'low', 'gpt-oss thinks as little as it can, since reasoning counts against the limit');
  assert.equal(asked[2].reasoning_format, 'hidden');
  assert.equal(asked[0].tools, undefined, 'no empty tool list is sent');
});

test('the Groq client gives up after a bounded wait, and says when the key is refused', async () => {
  let clock = 0;
  const limited = createGroqChat({
    apiKey: 'k', models: ['m'], fetchImpl: async () => reply(429, {}, { 'retry-after': '60' }), now: () => clock, sleep: async (ms) => { clock += ms; }, logger: { warn() {} },
  });
  await assert.rejects(limited.complete({ messages: [] }), /The chat model did not answer: m answered 429/);
  const refused = createGroqChat({ apiKey: 'k', models: ['m'], fetchImpl: async () => reply(401, {}), logger: { warn() {} } });
  await assert.rejects(refused.complete({ messages: [] }), (err) => err.status === 503 && /refused GROQ_API_KEY/.test(err.message));
  await assert.rejects(createGroqChat({ apiKey: '' }).complete({ messages: [] }), /GROQ_API_KEY is not set/);
});

test('the chat offers a short form of the voice agent\'s tools, and fills the conversation\'s variables itself', async () => {
  const tools = createChatTools();
  assert.deepEqual(tools.names, Object.keys(CHAT_TOOLS));
  const size = JSON.stringify(tools.definitions).length;
  assert.ok(size < 8500, `the definitions stay small for Groq's free plan (${size} characters)`);
  const guide = tools.definitions.find((d) => d.function.name === 'get_product_guide').function;
  assert.deepEqual(Object.keys(guide.parameters.properties), ['order_id', 'order_number', 'product_name', 'purpose', 'item']);
  const install = tools.definitions.find((d) => d.function.name === 'book_installation').function.parameters;
  assert.deepEqual(install.required, ['preferred_date', 'preferred_time']);
  assert.equal(install.properties.caller_phone, undefined, 'a value the conversation fills is never the model\'s to write');

  const calls = [];
  const callTool = async (path, body) => {
    calls.push({ path, body });
    return { message: 'Order 159 was delivered.', found: true, number_confirmed: true, order_phone: '+917357558134', customer_name: 'not sent' };
  };
  const vars = { customer_phone: '+917357558134', order_phone: '' };
  const result = await tools.run('find_order', { order_number: '159', caller_phone: '+910000000000', bogus: 'x' }, vars, callTool);
  assert.deepEqual(calls[0], { path: '/api/agent/order-lookup', body: { order_number: '159', caller_phone: '+917357558134' } });
  assert.match(result.text, /^Order 159 was delivered\.\nFields: found=true, number_confirmed=true, customer_name=not sent/);
  assert.deepEqual(result.saved, { order_phone: '+917357558134' }, 'saved like Sarvam\'s save_to_variables');

  const failed = await tools.run('find_order', {}, vars, async () => { throw new Error('down'); });
  assert.match(failed.text, /did not answer|service system/i);
  assert.equal((await tools.run('nope', {}, vars, callTool)).text, 'There is no tool called nope.');
});

test('the history the model sees keeps the newest turns whole, from a customer message on', () => {
  const history = [
    { role: 'assistant', content: 'h'.repeat(2000) },
    { role: 'user', content: 'a'.repeat(3000) },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: 'b'.repeat(2000) },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'next' },
  ];
  assert.deepEqual(recent(history, 1000).map((m) => m.role), ['user']);
  assert.deepEqual(recent(history, 6000).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
  assert.equal(recent(history, 100000).length, 6);
});

function fakeLlm(script) {
  const seen = [];
  return {
    seen,
    async complete({ messages, tools }) {
      seen.push({ messages, tools });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { model: 'm', message: next };
    },
  };
}

test('a chat starts like a website call and answers with the voice agent\'s tools', async () => {
  const llm = fakeLlm([
    { content: '', tool_calls: [{ id: 'c1', function: { name: 'get_product_guide', arguments: '{"product_name":"kitchen island","item":"K"}' } }] },
    { content: '**Hardware K** is the handle, one piece.' },
  ]);
  const calls = [];
  const callTool = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/agent/call-start') return { customer_phone: '+917357558134', customer_name: 'Satish', opening_line: 'Namaste Satish ji', caller_details: 'Orders: 159.' };
    return { message: 'Rocco Walky, hardware K: Handle x 1.', found: true };
  };
  const agent = createChatAgent({ llm, tools: createChatTools(), now: () => Date.parse('2026-11-11T16:00:00Z'), logger: { warn() {}, error() {} } });

  assert.deepEqual(await agent.start({ phone: '12345', callTool }), { error: 'phone', message: 'A valid 10 digit mobile number is needed to start the chat.' });
  const started = await agent.start({ phone: '07357558134', callTool });
  assert.equal(started.reply, 'Namaste Satish ji');
  assert.equal(started.firstName, 'Satish');
  assert.deepEqual(calls[0], { path: '/api/agent/call-start', body: { customer_phone: '+917357558134', call_reason: 'inbound', caller_type: 'phone_number' } });

  const answered = await agent.send({ id: started.id, text: '  letter K kya hai?  ', callTool });
  assert.deepEqual(answered, { reply: 'Hardware K is the handle, one piece.' }, 'markdown is taken out');
  assert.deepEqual(calls[1], { path: '/api/agent/product-guide', body: { product_name: 'kitchen island', item: 'K' } });
  const [first, second] = llm.seen;
  assert.match(first.messages[0].content, /Today is Wednesday, 11 November 2026, India time\./);
  assert.match(first.messages[0].content, /mobile number ending 8134: this is the number of this chat\. The customer's first name: Satish\./);
  assert.match(first.messages[0].content, /On record for this number: Orders: 159\./);
  assert.deepEqual(second.messages.slice(-2).map((m) => m.role), ['assistant', 'tool']);
  assert.equal(second.messages.at(-1).content, 'Rocco Walky, hardware K: Handle x 1.\nFields: found=true');
});

test('a chat message that fails is taken back, a busy chat waits, and an unknown or long chat is over', async () => {
  const llm = fakeLlm([new Error('The chat model did not answer'), { content: 'Hello again' }]);
  const callTool = async () => ({});
  const agent = createChatAgent({ llm, tools: createChatTools(), logger: { warn() {}, error() {} } });
  const { id } = await agent.start({ phone: '9876543210', callTool });
  const s = agent.sessions.get(id);
  assert.equal((await agent.send({ id, text: 'hi', callTool })).error, 'busy_model');
  assert.deepEqual(s.history.map((m) => m.role), ['assistant'], 'the failed message is taken back');
  assert.equal(s.turns, 0);
  assert.deepEqual(await agent.send({ id, text: 'hi', callTool }), { reply: 'Hello again' });
  s.busy = true;
  assert.equal((await agent.send({ id, text: 'again', callTool })).error, 'busy');
  s.busy = false;
  assert.equal((await agent.send({ id, text: '   ', callTool })).error, 'empty');
  assert.equal((await agent.send({ id: 'nope', text: 'hi', callTool })).error, 'ended');
  s.turns = 40;
  assert.equal((await agent.send({ id, text: 'more', callTool })).error, 'ended');
  assert.equal(agent.sessions.has(id), false);
});

test('/api/chat starts a chat, answers messages and ends it, and runs tools through the server\'s own /api/agent', async (t) => {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.post('/api/agent/:tool', (req, res) => {
    seen.push({ tool: req.params.tool, secret: req.get('x-agent-secret'), channel: req.get('x-channel') });
    res.json({ customer_phone: '+919876543210', opening_line: 'Welcome' });
  });
  const llm = fakeLlm([{ content: 'Sure.' }]);
  const chat = createChatAgent({ llm, tools: createChatTools(), logger: { warn() {}, error() {} } });
  app.use('/api/chat', chatRouter({ chat, config: { agentToolSecret: 's3cret' }, logger: { warn() {} } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/chat`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const started = await post('/sessions', { phone: '9876543210' });
  const { session_id: id, reply: greeting } = await started.json();
  assert.equal(greeting, 'Welcome');
  assert.deepEqual(seen[0], { tool: 'call-start', secret: 's3cret', channel: 'chat' });
  const answer = await post(`/sessions/${id}/messages`, { text: 'hello' });
  assert.deepEqual(await answer.json(), { reply: 'Sure.' });
  assert.equal((await post('/sessions', { phone: 'x' })).status, 400);
  assert.equal((await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })).status, 204);
  const gone = await post(`/sessions/${id}/messages`, { text: 'still there?' });
  assert.equal(gone.status, 410);
});
