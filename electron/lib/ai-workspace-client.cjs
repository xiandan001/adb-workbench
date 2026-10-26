const https = require('node:https');
const { tr } = require('./localization.cjs');
const { analysisMessages } = require('./analysis-language.cjs');

const LIMITS = Object.freeze({ timeoutMs: 90000, inputBytes: 128 * 1024, responseBytes: 256 * 1024, outputBytes: 64 * 1024, maxTokens: 4096 });

function builtinConfig() {
  const keys = require('./ai-keys.cjs');
  return { url: keys.AGNES_API_URL, model: keys.AGNES_MODEL, key: keys.AGNES_API_KEYS?.[keys.getAgnesKeyIndex()] };
}

function failure(code) {
  const messages = {
    cancelled: () => tr('AI 请求已取消。'),
    invalid_input: () => tr('AI 请求内容无效或超过大小限制。'),
    unavailable: () => tr('内置 AI 暂不可用，请稍后重试。'),
    timeout: () => tr('AI 请求超时，未自动重试。'),
    network: () => tr('无法连接内置 AI，未自动重试。'),
    auth: () => tr('内置 AI 认证暂不可用，请稍后重试。'),
    rate_limit: () => tr('内置 AI 当前繁忙或额度不足，未自动重试。'),
    response: () => tr('内置 AI 返回无效结果，未自动重试。'),
    output_limit: () => tr('AI 结果超过本次大小限制，请缩小问题范围。')
  };
  return { ok: false, code, error: messages[code]() };
}

function readUsage(raw) {
  const valid = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;
  if (!valid(raw?.prompt_tokens) || !valid(raw?.completion_tokens)) return null;
  const total = raw.prompt_tokens + raw.completion_tokens;
  if (raw.total_tokens !== undefined && (!valid(raw.total_tokens) || raw.total_tokens !== total)) return null;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: total };
}

function parseResponse(body) {
  try {
    const json = JSON.parse(body);
    if (json.error || !Array.isArray(json.choices) || json.choices.length !== 1) return failure('response');
    const choice = json.choices[0];
    if (choice?.finish_reason === 'length') return failure('output_limit');
    if (choice?.finish_reason && choice.finish_reason !== 'stop') return failure('response');
    const message = choice?.message;
    if (message?.tool_calls?.length || message?.function_call || typeof message?.content !== 'string' || !message.content.trim()) return failure('response');
    if (Buffer.byteLength(message.content, 'utf8') > LIMITS.outputBytes) return failure('output_limit');
    return { ok: true, text: message.content, usage: readUsage(json.usage) };
  } catch { return failure('response'); }
}

function prepareRequest({ systemPrompt, userContent, maxTokens }, getConfig) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || typeof userContent !== 'string' || !userContent.trim()
    || Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(userContent, 'utf8') > LIMITS.inputBytes
    || !Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > LIMITS.maxTokens) return { error: failure('invalid_input') };
  try {
    const config = getConfig();
    const url = new URL(config?.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || typeof config.key !== 'string' || !config.key.trim() || /[\r\n]/.test(config.key)
      || typeof config.model !== 'string' || !config.model.trim()) return { error: failure('unavailable') };
    const body = JSON.stringify({ model: config.model, messages: analysisMessages(systemPrompt, [], userContent), stream: false, temperature: 0.2, max_tokens: maxTokens });
    return { body, options: {
      protocol: 'https:', hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: 'POST', rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${config.key}` }
    } };
  } catch { return { error: failure('unavailable') }; }
}

function createBuiltinClient({ request = https.request, getConfig = builtinConfig } = {}) {
  return async ({ systemPrompt, userContent, signal, maxTokens = 2200 } = {}) => {
    if (signal?.aborted) return failure('cancelled');
    const prepared = prepareRequest({ systemPrompt, userContent, maxTokens }, getConfig);
    if (prepared.error) return prepared.error;
    return new Promise(resolve => {
      let settled = false;
      let req;
      let response;
      const stop = () => {
        try { response?.destroy(); } catch { /* Cleanup must not expose transport errors. */ }
        try { req?.destroy(); } catch { /* Cleanup must not expose transport errors. */ }
      };
      const finish = (result, abort = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (abort) stop();
        resolve(result);
      };
      const onAbort = () => finish(failure('cancelled'), true);
      const timer = setTimeout(() => finish(failure('timeout'), true), LIMITS.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try {
        req = request(prepared.options, res => {
          response = res;
          res.on('error', () => finish(failure('network'), true));
          res.on('aborted', () => finish(failure('network'), true));
          res.on('close', () => { if (!res.complete) finish(failure('network'), true); });
          if (settled) { stop(); return; }
          if (res.statusCode !== 200) {
            const code = [401, 403].includes(res.statusCode) ? 'auth' : res.statusCode === 429 ? 'rate_limit' : 'response';
            finish(failure(code), true);
            return;
          }
          const declaredLength = Number(res.headers?.['content-length']);
          if (declaredLength > LIMITS.responseBytes) { finish(failure('output_limit'), true); return; }
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > LIMITS.responseBytes) { finish(failure('output_limit'), true); return; }
            chunks.push(bytes);
          });
          res.on('end', () => { if (!settled) finish(parseResponse(Buffer.concat(chunks).toString('utf8'))); });
        });
        req.on('error', () => finish(failure('network'), true));
        if (settled) { stop(); return; }
        req.end(prepared.body);
      } catch { finish(failure('network'), true); }
    });
  };
}

module.exports = { createBuiltinClient, LIMITS };
