const { tr } = require('./localization.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');
const { normalizeCliConfig } = require('./ai-tools-cli-config.cjs');
const MAX_OUTPUT = 16;
const PROMPT = 'Reply OK.';
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value >= 0;

function probePlan(provider, local = false) {
  if (!provider || !['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(provider.protocol)) throw fail('AI_TOOLS_PROTOCOL', tr("当前协议尚不支持模型调用测试"));
  if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim() || typeof provider.model !== 'string' || !provider.model.trim()) throw fail('AI_TOOLS_CREDENTIAL_REQUIRED', tr("请先保存 API 密钥和默认模型，再测试连接"));
  const url = new URL(provider.baseUrl); const base = url.pathname.replace(/\/+$/, '');
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw fail('AI_TOOLS_PROBE_URL', tr("模型测试只允许 HTTPS 或本应用已运行的受管本地路由"));
  if (/\/(?:messages|responses|chat\/completions)$/.test(base)) throw fail('AI_TOOLS_PROBE_URL', tr("服务地址应为 API 基础地址，不要包含 messages、responses 或 chat/completions"));
  if (provider.protocol.startsWith('openai-') && /\/anthropic(?:\/|$)/i.test(base)) throw fail('AI_TOOLS_PROBE_PROTOCOL', tr("当前地址是 Anthropic 兼容接口，不能直接作为 Chat/Responses 接口使用，请核对协议和服务地址"));
  let model = provider.model;
  if (provider.protocol === 'anthropic') model = provider.claudeModels?.[model]?.model || model;
  model = model.replace(/(?:\[1m\])+$/i, '');
  if (!model || model.length > 256 || Array.from(model).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw fail('AI_TOOLS_PROBE_MODEL', tr("默认模型 ID 无效"));
  if (provider.protocol === 'anthropic') url.pathname = `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`;
  else if (provider.protocol === 'gemini') url.pathname = `${base || '/v1beta'}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  else url.pathname = `${base || '/v1'}/${provider.protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`;
  return { protocol: provider.protocol, model, endpoint: url.href, maxOutputTokens: MAX_OUTPUT, local };
}
function bodyFor(plan) {
  if (plan.protocol === 'anthropic') return { model: plan.model, max_tokens: MAX_OUTPUT, stream: false, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: PROMPT }] };
  if (plan.protocol === 'gemini') return { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: MAX_OUTPUT } };
  if (plan.protocol === 'openai-responses') return { model: plan.model, input: PROMPT, max_output_tokens: MAX_OUTPUT, stream: false, store: false };
  return { model: plan.model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_OUTPUT, stream: false };
}
function rejectResponse(status, data) {
  const error = data?.error || data?.errors || (data?.success === false ? data : null);
  const evidence = JSON.stringify(error || {}).slice(0, 4096);
  if (status === 401 || status === 403 || /authentication|unauthorized|invalid[_ -]?(?:api[_ -]?)?key|鉴权|认证失败|令牌无效/i.test(evidence)) throw fail('AI_TOOLS_PROBE_AUTH', tr("模型调用未获授权，请核对密钥、套餐类型及模型权限"));
  if (status === 429 || /rate[_ -]?limit|限流|请求过于频繁/i.test(evidence)) throw fail('AI_TOOLS_PROBE_RATE_LIMIT', tr("服务商限流，测试未重试，请稍后再试"));
  if (/model[_ -]?(?:not[_ -]?found|unavailable)|模型不存在|模型不可用|不支持.{0,12}模型/i.test(evidence)) throw fail('AI_TOOLS_PROBE_MODEL', tr("该模型不可用，请核对默认模型 ID 和套餐支持范围"));
  if (status < 200 || status >= 300 || error || data?.code !== undefined && ![0, 200, '0', '200', 'success'].includes(data.code)) throw fail('AI_TOOLS_PROBE_RESPONSE', tr("模型调用返回 HTTP {0} 或业务错误，请核对协议、地址和模型；未自动重试", { 0: status }));
}
function verifiedResponse(plan, response) {
  if ([401, 403, 429].includes(response.status)) rejectResponse(response.status, {});
  let data; try { data = JSON.parse(response.body); } catch { if (response.status < 200 || response.status >= 300) rejectResponse(response.status, {}); throw fail('AI_TOOLS_PROBE_RESPONSE', tr("模型接口未返回有效 JSON，请核对基础地址和接口协议")); }
  rejectResponse(response.status, data);
  let text = ''; let recognized = false; let limited = false; let input; let output;
  if (plan.protocol === 'anthropic') {
    recognized = data?.type === 'message' && Array.isArray(data.content);
    text = recognized ? data.content.filter(row => row?.type === 'text' && typeof row.text === 'string').map(row => row.text).join('') : '';
    limited = data?.stop_reason === 'max_tokens'; input = data?.usage?.input_tokens; output = data?.usage?.output_tokens;
  } else if (plan.protocol === 'openai-responses') {
    recognized = data?.object === 'response' && Array.isArray(data.output) && ['completed', 'incomplete'].includes(data.status);
    text = recognized ? data.output.flatMap(row => Array.isArray(row?.content) ? row.content : []).filter(row => row?.type === 'output_text' && typeof row.text === 'string').map(row => row.text).join('') : '';
    limited = data?.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens'; input = data?.usage?.input_tokens; output = data?.usage?.output_tokens;
  } else if (plan.protocol === 'openai-chat') {
    recognized = data?.object === 'chat.completion' && Array.isArray(data.choices) && isObject(data.choices[0]?.message);
    text = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
    limited = data?.choices?.[0]?.finish_reason === 'length'; input = data?.usage?.prompt_tokens; output = data?.usage?.completion_tokens;
  } else {
    recognized = Array.isArray(data?.candidates) && Array.isArray(data.candidates[0]?.content?.parts);
    text = recognized ? data.candidates[0].content.parts.filter(row => typeof row?.text === 'string').map(row => row.text).join('') : '';
    limited = data?.candidates?.[0]?.finishReason === 'MAX_TOKENS'; input = data?.usageMetadata?.promptTokenCount; output = data?.usageMetadata?.candidatesTokenCount;
  }
  if (!recognized || !text.trim() && !(limited && positive(output) && output > 0)) throw fail('AI_TOOLS_PROBE_RESPONSE', tr("接口没有返回可验证的模型响应，不能确认调用成功；未自动重试"));
  return { reachable: true, status: 'verified', mode: 'inference', inferenceVerified: true, model: plan.model, hasTextResponse: Boolean(text.trim()), outputLimited: limited,
    ...(positive(input) ? { inputTokens: input } : {}), ...(positive(output) ? { outputTokens: output } : {}) };
}
function createAiToolsProbe({ request, requestLocal, resolveLocal, now = Date.now }) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  const describe = provider => {
    // Authorize the exact body model after alias/[1m] resolution, never an earlier alias.
    const candidate = probePlan(provider, true);
    const local = Boolean(resolveLocal?.({ ...provider, model: candidate.model }));
    return local ? candidate : probePlan(provider, false);
  };
  async function run(provider, { signal } = {}) {
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', tr("模型测试已取消"));
    const plan = describe(provider); const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (plan.protocol === 'anthropic') {
      const auth = provider.cliConfig?.claude?.authField;
      if (auth === 'ANTHROPIC_API_KEY' || auth === 'apiKey') headers['x-api-key'] = provider.apiKey;
      else headers.Authorization = `Bearer ${provider.apiKey}`;
      headers['anthropic-version'] = '2023-06-01';
    } else if (plan.protocol === 'gemini') headers['x-goog-api-key'] = provider.apiKey;
    else headers.Authorization = `Bearer ${provider.apiKey}`;
    if (plan.protocol === 'openai-responses') {
      const extra = normalizeCliConfig(provider.cliConfig || {}).codex?.httpHeaders;
      for (const [name, value] of Object.entries(extra || {})) if (typeof value === 'string') headers[name] = value;
    }
    const send = plan.local ? requestLocal : request;
    if (!send) throw fail('AI_TOOLS_PROBE_URL', tr("本地路由调用测试尚未连接"));
    const started = now(); let response;
    try { response = await send({ url: plan.endpoint, method: 'POST', headers, body: bodyFor(plan), signal, credentialOrigins: [new URL(plan.endpoint).origin] }); }
    catch (error) { if (error.code === 'AI_TOOLS_NETWORK_TIMEOUT') throw fail('AI_TOOLS_PROBE_TIMEOUT', tr("模型测试超时，未自动重试；服务端可能已消耗少量额度")); throw error; }
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', tr("模型测试已取消，未自动重试"));
    return { ...verifiedResponse(plan, response), checkedAt: now(), latencyMs: Math.max(0, now() - started) };
  }
  return { describe, run };
}
module.exports = { createAiToolsProbe, probePlan, bodyFor, verifiedResponse };
