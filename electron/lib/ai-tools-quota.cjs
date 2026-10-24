const { tr } = require('./localization.cjs');
// Response contracts/endpoints reviewed against MIT-licensed CC Switch, Jason Young,
// commit e4873bc8aa2555225d4867ec2f04b1290f1d21d9 (balance.rs / coding_plan.rs).
// No upstream authentication, local CLI credential import, payment or script execution is used.
const { createHash } = require('node:crypto');
const { validateArguments } = require('./ai-tools-policy.cjs');
const { requestJson, validateNetworkUrl, MAX_BYTES } = require('./ai-tools-network.cjs');

const ADAPTERS = Object.freeze(['deepseek', 'openrouter', 'siliconflow', 'stepfun', 'novita', 'kimi', 'zhipu', 'minimax', 'custom']);
const SAFE_HEADERS = Object.freeze(['Accept', 'Content-Type', 'New-Api-User', 'X-Organization-Id', 'X-Project-Id']);
const ENDPOINTS = {
  deepseek: { origins: ['https://api.deepseek.com'], path: '/user/balance', kind: 'balance' },
  openrouter: { origins: ['https://openrouter.ai'], path: '/api/v1/credits', kind: 'balance' },
  siliconflow: { origins: ['https://api.siliconflow.cn', 'https://api.siliconflow.com'], path: '/v1/user/info', kind: 'balance' },
  stepfun: { origins: ['https://api.stepfun.com'], path: '/v1/accounts', kind: 'balance' },
  novita: { origins: ['https://api.novita.ai'], path: '/v3/user/balance', kind: 'balance' },
  kimi: { origins: ['https://api.kimi.com'], path: '/coding/v1/usages', kind: 'plan' },
  zhipu: { origins: ['https://open.bigmodel.cn', 'https://api.z.ai'], path: '/api/monitor/usage/quota/limit', kind: 'plan' },
  minimax: { origins: ['https://api.minimaxi.com', 'https://api.minimax.io'], path: '/v1/api/openplatform/coding_plan/remains', kind: 'plan' },
};
const fail = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => fail('AI_TOOLS_CANCELLED', tr("额度查询已取消或所属凭据已变化"));
const hasControl = value => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function exact(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度查询配置格式无效"));
}
function jsonPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || !/^(?:\$\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("提取规则只支持 JSON 字段路径和数组下标"));
  const parts = value.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("提取路径包含不允许的属性"));
  return parts;
}
function normalizeQuotaConfig(input) {
  if (input === undefined || input === null) return null;
  let value;
  try { value = validateArguments(input, { maxBytes: 64 * 1024, maxStringBytes: 16 * 1024, maxArrayLength: 64 }); }
  catch { throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度查询配置必须是有界声明式 JSON，不能包含代码或凭据对象")); }
  exact(value, ['adapter', 'credentialOrigin', 'kind', 'request', 'extract'], ['adapter']);
  if (typeof value.adapter !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.adapter)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度适配器名称无效"));
  if (value.credentialOrigin !== undefined) {
    const origin = validateNetworkUrl(value.credentialOrigin);
    if (origin.pathname !== '/' || origin.search || value.credentialOrigin.replace(/\/$/, '') !== origin.origin) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("独立额度凭据必须绑定 HTTPS origin，不能包含路径"));
  }
  if (value.adapter !== 'custom') {
    if (value.request !== undefined || value.extract !== undefined || value.kind !== undefined) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("内置额度适配器不接受自定义请求或提取规则"));
    return value;
  }
  if (value.kind !== undefined && !['balance', 'plan'].includes(value.kind)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度类型无效"));
  exact(value.request, ['path', 'method', 'headers', 'body'], ['path', 'method']);
  if (typeof value.request.path !== 'string' || !value.request.path.startsWith('/') || value.request.path.startsWith('//') || value.request.path.includes('\\') || value.request.path.includes('#') || hasControl(value.request.path)
    || value.request.path.length > 2048 || !['GET', 'POST'].includes(value.request.method)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("自定义查询必须使用相对路径和 GET/POST"));
  validateNetworkUrl(new URL(value.request.path, 'https://quota.invalid').href);
  if (value.request.method === 'GET' && value.request.body !== undefined) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("GET 查询不能携带请求体"));
  if (value.request.headers !== undefined) {
    exact(value.request.headers, SAFE_HEADERS);
    for (const [name, header] of Object.entries(value.request.headers)) {
      if (typeof header !== 'string' || header.length > 128 || hasControl(header)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("自定义查询请求头无效"));
      if (['Accept', 'Content-Type'].includes(name) ? !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header) : name === 'New-Api-User' ? !/^\d{1,20}$/.test(header) : !/^[A-Za-z0-9_-]{1,128}$/.test(header)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("自定义请求头仅允许公开的 JSON 类型及组织/项目标识"));
    }
  }
  const scanBody = body => {
    if (!body || typeof body !== 'object') return;
    for (const [name, child] of Object.entries(body)) { if (/authorization|api[-_]?key|token|secret|password|cookie/i.test(name)) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("请求体不能存放凭据，请使用独立额度 Key")); scanBody(child); }
  };
  scanBody(value.request.body);
  exact(value.extract, ['metrics'], ['metrics']);
  if (!Array.isArray(value.extract.metrics) || !value.extract.metrics.length || value.extract.metrics.length > 32) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("请配置 1–32 项额度提取规则"));
  for (const metric of value.extract.metrics) {
    exact(metric, ['label', 'unit', 'remaining', 'used', 'total', 'resetAt'], ['label', 'unit']);
    if (typeof metric.label !== 'string' || !metric.label.trim() || metric.label.length > 80 || hasControl(metric.label) || typeof metric.unit !== 'string' || !metric.unit.trim() || metric.unit.length > 16 || hasControl(metric.unit)
      || !['remaining', 'used', 'total'].some(key => Object.hasOwn(metric, key))) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度指标名称、单位或字段无效"));
    for (const field of ['remaining', 'used', 'total', 'resetAt']) if (metric[field] !== undefined) jsonPath(metric[field]);
  }
  return value;
}

function number(value) {
  if (typeof value === 'string' && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function requiredNumber(value) { const parsed = number(value); if (parsed === null) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("额度响应缺少有效数值，未把未知值转换成 0")); return parsed; }
function resetTime(value, milliseconds = false) {
  if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && value.length > 128) return undefined;
  const numeric = number(value); const at = numeric !== null ? numeric * (milliseconds || numeric > 1e12 ? 1 : 1000) : Date.parse(value);
  return Number.isFinite(at) && Math.abs(at) <= 8640000000000000 ? new Date(at).toISOString() : undefined;
}
function percent(label, remaining, resetAt) {
  const value = requiredNumber(remaining); if (value < 0 || value > 100) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("额度百分比超出有效范围"));
  return { label, remaining: value, used: 100 - value, total: 100, unit: '%', ...(resetAt ? { resetAt } : {}) };
}
function extractPath(value, expression) {
  for (const part of jsonPath(expression)) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined; value = value[part]; }
  return value;
}
function parseMetrics(adapter, body, origin, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.success === false || body.error) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("服务端未返回有效额度数据"));
  if (adapter === 'deepseek') {
    if (!Array.isArray(body.balance_infos)) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("余额响应格式不匹配"));
    return body.balance_infos.slice(0, 32).map(item => {
      if (!item || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("余额币种无效"));
      return { label: `DeepSeek ${item.currency}`, remaining: requiredNumber(item.total_balance), unit: item.currency };
    });
  }
  if (adapter === 'openrouter') { const data = body.data || body; const total = requiredNumber(data.total_credits); const used = requiredNumber(data.total_usage); return [{ label: 'OpenRouter', remaining: requiredNumber(total - used), total, used, unit: 'USD' }]; }
  if (adapter === 'siliconflow') {
    if (body.code !== undefined && ![0, 20000].includes(body.code)) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("SiliconFlow 余额查询未成功"));
    return [{ label: 'SiliconFlow', remaining: requiredNumber(body.data?.totalBalance), unit: origin.endsWith('.cn') ? 'CNY' : 'USD' }];
  }
  if (adapter === 'stepfun') return [{ label: 'StepFun', remaining: requiredNumber(body.balance), unit: 'CNY' }];
  if (adapter === 'novita') return [{ label: 'Novita AI', remaining: requiredNumber(body.availableBalance) / 10000, unit: 'USD' }];
  if (adapter === 'kimi') {
    const metric = (detail, label) => { const total = requiredNumber(detail?.limit); const remaining = requiredNumber(detail?.remaining); if (total <= 0) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("套餐总额度无效")); return percent(label, remaining / total * 100, resetTime(detail.resetTime)); };
    const metrics = Array.isArray(body.limits) ? body.limits.slice(0, 16).map((item, index) => metric(item.detail, index ? tr("短周期 {0}", { 0: index + 1 }) : tr("5 小时"))) : [];
    if (body.usage) metrics.push(metric(body.usage, tr("周额度"))); return metrics;
  }
  if (adapter === 'zhipu') {
    if (!Array.isArray(body.data?.limits)) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("智谱套餐响应格式不匹配"));
    return body.data.limits.filter(item => ['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(String(item.type).toUpperCase())).slice(0, 16)
      .map((item, index) => percent(item.unit === 3 ? tr("5 小时") : item.unit === 6 ? tr("周额度") : tr("套餐窗口 {0}", { 0: index + 1 }), 100 - requiredNumber(item.percentage), resetTime(item.nextResetTime, true)));
  }
  if (adapter === 'minimax') {
    if (body.base_resp && body.base_resp.status_code !== 0) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("MiniMax 套餐查询未成功"));
    const general = Array.isArray(body.model_remains) ? body.model_remains.find(item => item.model_name === 'general') : null;
    if (!general) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("未返回 MiniMax 编程套餐额度"));
    const metrics = [percent(tr("5 小时"), general.current_interval_remaining_percent, resetTime(general.end_time, true))];
    if (general.current_weekly_status === 1) metrics.push(percent(tr("周额度"), general.current_weekly_remaining_percent, resetTime(general.weekly_end_time, true))); return metrics;
  }
  return config.extract.metrics.map(rule => {
    const metric = { label: rule.label, unit: rule.unit };
    for (const field of ['remaining', 'used', 'total']) if (rule[field] !== undefined) metric[field] = requiredNumber(extractPath(body, rule[field]));
    if (rule.resetAt) { const at = resetTime(extractPath(body, rule.resetAt)); if (at) metric.resetAt = at; }
    return metric;
  });
}

function prepare(provider, allowLoopback) {
  const config = normalizeQuotaConfig(provider.quota);
  if (!config || !ADAPTERS.includes(config.adapter)) throw fail('AI_TOOLS_QUOTA_UNAVAILABLE', tr("尚未配置受支持的 API Key 额度来源；OAuth 登录额度未接入"));
  const key = typeof provider.quotaKey === 'string' && provider.quotaKey ? provider.quotaKey : provider.apiKey;
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || hasControl(key)) throw fail('AI_TOOLS_QUOTA_UNAVAILABLE', tr("尚无有效的用户提供额度凭据，未发起网络请求"));
  const base = validateNetworkUrl(provider.baseUrl, { allowLoopback });
  const explicit = config.credentialOrigin ? new URL(config.credentialOrigin).origin : null;
  if (explicit && explicit !== base.origin && !provider.quotaKey) throw fail('AI_TOOLS_QUOTA_UNAVAILABLE', tr("跨域额度查询需要独立额度 Key 和明确的凭据 origin"));
  const origin = explicit || base.origin; const builtIn = ENDPOINTS[config.adapter];
  if (builtIn && !builtIn.origins.includes(origin)) throw fail('AI_TOOLS_QUOTA_UNAVAILABLE', tr("额度适配器与凭据来源域名不匹配，未向其他域名发送 Key"));
  const url = new URL(builtIn ? builtIn.path : config.request.path, origin).href;
  validateNetworkUrl(url, { allowLoopback });
  const headers = { Accept: 'application/json', ...(config.request?.headers || {}), Authorization: config.adapter === 'zhipu' ? key : `Bearer ${key}` };
  if (config.request?.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return { config, origin, kind: builtIn?.kind || config.kind || 'balance', source: new URL(url).origin + new URL(url).pathname,
    request: { url, method: config.request?.method || 'GET', headers, ...(config.request?.body === undefined ? {} : { body: config.request.body }), credentialOrigins: [origin] } };
}

function createAiToolsQuota({ request = requestJson, now = Date.now, allowLoopback = false, cacheTtlMs = 60000, staleTtlMs = 600000 } = {}) {
  if (typeof request !== 'function' || allowLoopback && request === requestJson || !Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 300000 || !Number.isSafeInteger(staleTtlMs) || staleTtlMs < cacheTtlMs || staleTtlMs > 3600000) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度查询缓存配置无效"));
  const states = new Map(); let disposed = false;
  const clone = value => value ? structuredClone(value) : null;
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("额度查询时间无效")); return value; };
  const empty = (id, kind, status, reason) => ({ providerId: id, kind, status, observedAt: null, metrics: [], reason });
  function peek(id) {
    const result = clone(states.get(id)?.result);
    if (result?.observedAt !== null && result?.observedAt !== undefined && time() - result.observedAt > staleTtlMs) return { ...empty(id, result.kind, 'unavailable', tr("缓存已超过有效期，请手动刷新")), ...(result.source ? { source: result.source } : {}) };
    if (result?.status === 'fresh' && time() - result.observedAt > cacheTtlMs) { result.status = 'stale'; result.reason = tr("缓存已过期，请手动刷新"); } return result;
  }
  function cancel(id) { const state = states.get(id); if (state) { state.generation++; state.controller?.abort(); state.inflight = null; state.controller = null; } }
  function invalidate(id) { cancel(id); states.delete(id); }
  async function query(input, { signal, force = false } = {}) {
    if (disposed) throw fail('AI_TOOLS_DISPOSED', tr("额度查询服务已停止"));
    let provider;
    try { provider = validateArguments(input); }
    catch { throw fail('AI_TOOLS_QUOTA_CONFIG', tr("主进程供应商记录无效")); }
    const id = provider.id;
    if (typeof id !== 'string' || !id.length || id.length > 200) throw fail('AI_TOOLS_QUOTA_CONFIG', tr("供应商标识无效"));
    if (signal?.aborted) throw cancelled();
    const fingerprint = createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.apiKey || '', provider.quotaKey || '', provider.quota || null])).digest('hex');
    let state = states.get(id);
    if (state && state.fingerprint !== fingerprint) { invalidate(id); state = null; }
    if (!state) {
      if (states.size >= 64) { const oldest = [...states].find(([, value]) => !value.inflight); if (!oldest) throw fail('AI_TOOLS_QUOTA_BUSY', tr("额度查询任务过多，请稍后重试")); states.delete(oldest[0]); }
      state = { fingerprint, generation: 0, result: null, lastGood: null, retryAt: 0, inflight: null, controller: null }; states.set(id, state);
    }
    let prepared;
    try { prepared = prepare(provider, allowLoopback); }
    catch (error) { state.lastGood = null; state.result = empty(id, ENDPOINTS[provider.quota?.adapter]?.kind || 'balance', 'unavailable', error.message); return clone(state.result); }
    if (state.retryAt > time()) return clone(state.result);
    if (state.inflight) {
      const abortShared = () => state.controller?.abort(); signal?.addEventListener('abort', abortShared, { once: true });
      return state.inflight.then(clone).finally(() => signal?.removeEventListener('abort', abortShared));
    }
    if (!force && state.result?.status === 'fresh' && time() - state.result.observedAt <= cacheTtlMs) return clone(state.result);
    const generation = ++state.generation; const controller = new AbortController(); state.controller = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const current = () => states.get(id) === state && state.generation === generation && !controller.signal.aborted;
    const rejectedResult = (reason, transient = false) => {
      const good = state.lastGood;
      if (transient && good && time() - good.observedAt <= staleTtlMs) return { ...clone(good), status: 'stale', reason };
      if (!transient) state.lastGood = null;
      return { ...empty(id, prepared.kind, 'error', reason), source: prepared.source };
    };
    const operation = (async () => {
      try {
        const response = await new Promise((resolve, reject) => {
          const stopped = () => reject(cancelled()); controller.signal.addEventListener('abort', stopped, { once: true });
          Promise.resolve().then(() => { if (!current()) throw cancelled(); return request({ ...prepared.request, signal: controller.signal }); }).then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', stopped));
        });
        if (!current()) throw cancelled();
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("查询响应状态无效"));
        if (response.status === 429) {
          const raw = response.headers?.['retry-after'] || response.headers?.['Retry-After'];
          const seconds = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
          const delay = seconds !== null ? seconds * 1000 : typeof raw === 'string' ? Date.parse(raw) - time() : 30000;
          state.retryAt = Math.min(8640000000000000, time() + Math.max(1000, Number.isFinite(delay) ? delay : 30000));
          state.result = { ...rejectedResult(tr("服务端限流，请等待后再刷新"), true), retryAt: state.retryAt }; return clone(state.result);
        }
        if ([401, 403].includes(response.status)) { state.retryAt = 0; state.result = rejectedResult(tr("额度凭据被拒绝，请检查用户提供的 API Key 或只读查询令牌")); return clone(state.result); }
        if (response.status < 200 || response.status >= 300) { state.result = rejectedResult(tr("额度端点返回 HTTP {0}", { 0: response.status }), response.status >= 500); return clone(state.result); }
        if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_BYTES) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("查询响应无效或超过 1 MiB 限制"));
        let body; try { body = JSON.parse(response.body); } catch { throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("额度端点未返回有效 JSON")); }
        const metrics = parseMetrics(prepared.config.adapter, body, prepared.origin, prepared.config);
        if (!metrics.length) throw fail('AI_TOOLS_QUOTA_RESPONSE', tr("未返回可确认的额度指标；未知不代表 0 或无限"));
        state.retryAt = 0; state.result = { providerId: id, kind: prepared.kind, status: 'fresh', observedAt: time(), metrics, source: prepared.source }; state.lastGood = clone(state.result); return clone(state.result);
      } catch (error) {
        if (!current() || error.code === 'AI_TOOLS_CANCELLED') throw cancelled();
        const deterministic = ['AI_TOOLS_QUOTA_RESPONSE', 'AI_TOOLS_NETWORK_REDIRECT', 'AI_TOOLS_NETWORK_TOO_LARGE', 'AI_TOOLS_NETWORK_RESPONSE', 'AI_TOOLS_NETWORK_URL', 'AI_TOOLS_NETWORK_ORIGIN'].includes(error.code);
        state.result = rejectedResult(deterministic ? tr("额度响应无法安全确认，请检查查询配置或服务端格式") : tr("额度网络查询失败，请稍后重试"), !deterministic); return clone(state.result);
      } finally { signal?.removeEventListener('abort', abort); if (states.get(id) === state && state.generation === generation) { state.inflight = null; state.controller = null; } }
    })();
    state.inflight = operation; return operation;
  }
  function dispose() { disposed = true; for (const id of states.keys()) cancel(id); states.clear(); }
  return Object.freeze({ query, peek, list: () => [...states.keys()].map(peek).filter(Boolean), cancel, invalidate, dispose });
}

module.exports = { createAiToolsQuota, normalizeQuotaConfig, ADAPTERS };
