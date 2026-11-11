// The text model behind the website chat: Groq's OpenAI-compatible chat API with tool calls. Groq's free plan allows
// 8,000 tokens a minute for each model, counted per model, so a request that is turned away (429) moves on to the next
// model in CHAT_MODELS, and only when every model is cooling down does the chat wait for the first to be free again.

const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
// Reasoning tokens count against the limit too: as little as each model allows.
const MODEL_OPTIONS = [
  [/^openai\/gpt-oss/, { reasoning_effort: 'low' }],
  [/^qwen\//, { reasoning_format: 'hidden' }],
];

// How long Groq asks a turned-away model to wait: Retry-After in seconds, else the token reset ("2.6s", "1m3s").
function retryAfterMs(res) {
  const seconds = Number(res.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const reset = /^(?:(\d+)m)?([\d.]+)s$/.exec(String(res.headers.get('x-ratelimit-reset-tokens') || ''));
  if (reset) return ((Number(reset[1]) || 0) * 60 + Number(reset[2])) * 1000;
  return 10000;
}

function createGroqChat({
  apiKey, models = DEFAULT_MODELS, baseUrl = 'https://api.groq.com/openai/v1', fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), maxWaitMs = 25000,
  timeoutMs = 30000, logger = console,
}) {
  const list = models.length ? models : DEFAULT_MODELS;
  const coolingUntil = new Map();

  async function ask(model, { messages, tools, maxTokens }) {
    const options = MODEL_OPTIONS.find(([pattern]) => pattern.test(model))?.[1] || {};
    return fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0.3, max_tokens: maxTokens, ...options,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // The assistant's next message: { content, tool_calls }, with the model that wrote it. Throws when no model answers.
  // Replies are short; a smaller cap also keeps what Groq counts against the per-minute limit down.
  async function complete({ messages, tools, maxTokens = 450 }) {
    if (!apiKey) throw Object.assign(new Error('GROQ_API_KEY is not set'), { status: 503 });
    const started = now();
    let lastProblem = 'no model answered';
    for (;;) {
      for (const model of list) {
        if ((coolingUntil.get(model) || 0) > now()) continue;
        let res;
        try {
          res = await ask(model, { messages, tools, maxTokens });
        } catch (err) {
          lastProblem = `${model}: ${err.message}`;
          logger.warn(`[chat] ${lastProblem}`);
          continue;
        }
        if (res.ok) {
          const body = await res.json();
          const message = body.choices?.[0]?.message;
          if (message) return { model, message, usage: body.usage || null };
          lastProblem = `${model}: an answer without a message`;
          continue;
        }
        const detail = await res.text().catch(() => '');
        lastProblem = `${model} answered ${res.status}: ${detail.slice(0, 200)}`;
        if (res.status === 429) coolingUntil.set(model, now() + retryAfterMs(res));
        else if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Groq refused GROQ_API_KEY (${res.status})`), { status: 503 });
        // A tool call the model wrote badly (400 tool_use_failed) or a model that is down: the next model tries.
        logger.warn(`[chat] ${lastProblem}`);
      }
      // Only models turned away for the rate limit are worth waiting for; when none is, every model has failed.
      const cooling = list.map((m) => coolingUntil.get(m) || 0).filter((t) => t > now());
      if (!cooling.length) break;
      const waitMs = Math.max(250, Math.min(...cooling) - now());
      if (now() - started + waitMs > maxWaitMs) break;
      await sleep(waitMs);
    }
    throw Object.assign(new Error(`The chat model did not answer: ${lastProblem}`), { status: 502 });
  }

  return { complete, models: list };
}

module.exports = { createGroqChat, DEFAULT_MODELS };
