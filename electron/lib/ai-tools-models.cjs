const fail = (code, message) => Object.assign(new Error(message), { code });

function createAiToolsModels({ request, resolveLocal, now = Date.now }) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  async function list(provider, { signal } = {}) {
    if (!provider || !['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(provider.protocol)) throw fail('AI_TOOLS_PROTOCOL', '当前协议不支持模型发现');
    if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) throw fail('AI_TOOLS_CREDENTIAL_REQUIRED', '请先保存此服务的 API 密钥');
    const local = resolveLocal?.(provider); if (local) return local;
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw fail('AI_TOOLS_PROVIDER_URL', 'API 基础地址不能包含凭据、查询参数或片段');
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base || (provider.protocol === 'gemini' ? '/v1beta' : '/v1')}/models`;
    const headers = { Accept: 'application/json' };
    if (provider.protocol === 'anthropic') { headers['x-api-key'] = provider.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (provider.protocol === 'gemini') headers['x-goog-api-key'] = provider.apiKey;
    else headers.Authorization = `Bearer ${provider.apiKey}`;
    const started = now();
    const response = await request({ url: url.href, method: 'GET', headers, signal, credentialOrigins: [url.origin] });
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', '操作已取消');
    if ([401, 403].includes(response.status)) throw fail('AI_TOOLS_PROVIDER_AUTH', 'API 密钥无效或没有读取模型列表的权限');
    if (response.status === 429) throw fail('AI_TOOLS_PROVIDER_RATE_LIMIT', '服务商暂时限流，请稍后重试');
    if (response.status < 200 || response.status >= 300) throw fail('AI_TOOLS_PROVIDER_HTTP', `服务商返回 HTTP ${response.status}，无法读取模型列表`);
    let data;
    try { data = JSON.parse(response.body); } catch { throw fail('AI_TOOLS_PROVIDER_RESPONSE', '服务商未返回有效的模型列表'); }
    const items = provider.protocol === 'gemini' ? data.models : data.data;
    if (!Array.isArray(items)) throw fail('AI_TOOLS_PROVIDER_RESPONSE', '当前端点不提供此协议的模型列表');
    const unique = new Map();
    for (const item of items.slice(0, 5000)) {
      const value = provider.protocol === 'gemini' ? item?.name : item?.id;
      const id = typeof value === 'string' && provider.protocol === 'gemini' ? value.replace(/^models\//, '') : value;
      if (typeof id !== 'string' || !id || id.length > 256 || Array.from(id).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) continue;
      unique.set(id, { id, ...(typeof item.displayName === 'string' ? { name: item.displayName.slice(0, 256) } : {}) });
    }
    return { models: [...unique.values()], checkedAt: now(), latencyMs: Math.max(0, now() - started) };
  }
  return { list, async test(provider, options) { const result = await list(provider, options); return { reachable: true, latencyMs: result.latencyMs, modelCount: result.models.length, checkedAt: result.checkedAt }; } };
}

module.exports = { createAiToolsModels };
