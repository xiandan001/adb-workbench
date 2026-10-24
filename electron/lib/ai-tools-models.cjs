const { tr } = require('./localization.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });
const UNSUPPORTED_MESSAGE = '已收到服务响应，但该接口不提供模型列表；尚未验证密钥/模型调用，可手动配置模型';
const responseError = () => fail('AI_TOOLS_PROVIDER_RESPONSE', tr("服务商返回异常响应，未能验证密钥或读取模型列表"));
const unsupported = () => fail('AI_TOOLS_MODELS_UNSUPPORTED', tr(UNSUPPORTED_MESSAGE));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Inspect only common error-envelope fields; never expose remote text or credentials.
function envelopeFailure(data) {
  if (!isObject(data)) return null;
  const envelopes = [data, ...(isObject(data.data) ? [data.data] : [])];
  const rows = envelopes.flatMap(row => [row, ...(isObject(row.error) ? [row.error] : []), ...(Array.isArray(row.errors) ? row.errors.slice(0, 16).filter(isObject) : [])]);
  const codes = rows.flatMap(row => [row.code, row.type, row.status, row.statusCode])
    .filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).slice(0, 256).toLowerCase());
  const messages = rows.flatMap(row => [row.error, row.message, row.msg, row.detail])
    .filter(value => typeof value === 'string').map(value => value.slice(0, 1024)).join(' ');
  const evidence = `${codes.join(' ')} ${messages}`;
  if (codes.some(code => ['401', '403'].includes(code)) || /authentication[_ -]*(?:error|failed)|unauthorized|forbidden|permission[_ -]*denied|access[_ -]*denied|(?:invalid|incorrect|missing|expired)[_ -]*(?:api[_ -]*)?(?:key|token)|(?:api[_ -]*)?(?:key|token)[_ -]*(?:is[_ -]*)?(?:invalid|incorrect|missing|expired)|鉴权失败|认证失败|(?:密钥|令牌).{0,8}(?:无效|错误|过期)/i.test(evidence)) {
    return fail('AI_TOOLS_PROVIDER_AUTH', tr("API 密钥无效或没有读取模型列表的权限"));
  }
  if (codes.includes('429') || /rate[_ -]*limit|too[_ -]*many[_ -]*requests|限流|请求.{0,8}频繁/i.test(evidence)) {
    return fail('AI_TOOLS_PROVIDER_RATE_LIMIT', tr("服务商暂时限流，请稍后重试"));
  }
  if (codes.some(code => /^(?:404|405|501|not_implemented|method_not_allowed|unsupported_endpoint|unsupported_operation|models_not_supported|models_unsupported)$/.test(code))
    || /(?:models\b|model[_ -]*list).{0,48}(?:not[_ -]*supported|not[_ -]*implemented)|(?:不支持|不提供).{0,12}模型列表|模型列表.{0,12}(?:不支持|不提供)/i.test(messages)) return unsupported();
  const hasError = rows.some(row => row.error !== undefined && row.error !== null && row.error !== false && row.error !== ''
    || row.errors !== undefined && row.errors !== null && (!Array.isArray(row.errors) || row.errors.length > 0)
    || row.success === false || row.ok === false || ['error', 'failed', 'failure'].includes(String(row.status).toLowerCase())
    || row.code !== undefined && row.code !== null && !/^(?:0+|200|ok|success)$/i.test(String(row.code)));
  return hasError ? responseError() : null;
}

function modelItems(response, protocol) {
  if ([401, 403].includes(response.status)) throw fail('AI_TOOLS_PROVIDER_AUTH', tr("API 密钥无效或没有读取模型列表的权限"));
  if (response.status === 429) throw fail('AI_TOOLS_PROVIDER_RATE_LIMIT', tr("服务商暂时限流，请稍后重试"));
  const unsupportedStatus = [404, 405, 501].includes(response.status);
  if (!unsupportedStatus && (response.status < 200 || response.status >= 300)) throw fail('AI_TOOLS_PROVIDER_HTTP', tr("服务商返回 HTTP {0}，无法读取模型列表", { 0: response.status }));
  let data;
  try { data = JSON.parse(response.body); } catch { if (unsupportedStatus) throw unsupported(); throw responseError(); }
  const error = envelopeFailure(data);
  if (error && ['AI_TOOLS_PROVIDER_AUTH', 'AI_TOOLS_PROVIDER_RATE_LIMIT'].includes(error.code)) throw error;
  if (unsupportedStatus) throw unsupported();
  if (error) throw error;
  if (!isObject(data)) throw responseError();
  const items = protocol === 'gemini' ? data.models : data.data;
  if (!Array.isArray(items)) throw unsupported();
  return items;
}

function createAiToolsModels({ request, resolveLocal, now = Date.now }) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  async function list(provider, { signal } = {}) {
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', tr("操作已取消"));
    if (!provider || !['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(provider.protocol)) throw fail('AI_TOOLS_PROTOCOL', tr("当前协议不支持模型发现"));
    if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) throw fail('AI_TOOLS_CREDENTIAL_REQUIRED', tr("请先保存此服务的 API 密钥"));
    const local = resolveLocal?.(provider); if (local) return local;
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw fail('AI_TOOLS_PROVIDER_URL', tr("API 基础地址不能包含凭据、查询参数或片段"));
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base || (provider.protocol === 'gemini' ? '/v1beta' : '/v1')}/models`;
    const headers = { Accept: 'application/json' };
    if (provider.protocol === 'anthropic') { headers['x-api-key'] = provider.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (provider.protocol === 'gemini') headers['x-goog-api-key'] = provider.apiKey;
    else headers.Authorization = `Bearer ${provider.apiKey}`;
    const started = now();
    const response = await request({ url: url.href, method: 'GET', headers, signal, credentialOrigins: [url.origin] });
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', tr("操作已取消"));
    const timing = { checkedAt: now(), latencyMs: Math.max(0, now() - started) };
    let items;
    try { items = modelItems(response, provider.protocol); }
    catch (error) { if (error.code === 'AI_TOOLS_MODELS_UNSUPPORTED') Object.assign(error, timing); throw error; }
    const unique = new Map();
    for (const item of items.slice(0, 5000)) {
      const value = provider.protocol === 'gemini' ? item?.name : item?.id;
      const id = typeof value === 'string' && provider.protocol === 'gemini' ? value.replace(/^models\//, '') : value;
      if (typeof id !== 'string' || !id || id.length > 256 || Array.from(id).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) continue;
      unique.set(id, { id, ...(typeof item.displayName === 'string' ? { name: item.displayName.slice(0, 256) } : {}) });
    }
    if (items.length && !unique.size) throw responseError();
    return { models: [...unique.values()], ...timing };
  }
  return { list, async test(provider, options) {
    try {
      const result = await list(provider, options);
      return { reachable: true, status: 'verified', modelsSupported: true, authentication: 'unverified',
        message: tr("模型列表读取成功，未验证付费模型调用/密钥权限"),
        latencyMs: result.latencyMs, modelCount: result.models.length, checkedAt: result.checkedAt };
    } catch (error) {
      if (error.code !== 'AI_TOOLS_MODELS_UNSUPPORTED') throw error;
      return { reachable: true, status: 'partial', modelsSupported: false, authentication: 'unverified',
        message: tr(UNSUPPORTED_MESSAGE), checkedAt: error.checkedAt, latencyMs: error.latencyMs };
    }
  } };
}

module.exports = { createAiToolsModels };
