const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { readSafe, atomicReplace, checksum, fail } = require('./ai-tools-file-safety.cjs');
const { exact, UUID, prepareStateWrite } = require('./ai-tools-migration-common.cjs');

const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
function createRouterConfig({ directory, canEncrypt, encrypt, decrypt, getProvider }) {
  const file = path.join(directory, 'router.v1.json'); let state; let observed;
  function load() {
    if (state) return state;
    const saved = readSafe(file); observed = saved.hash;
    if (!saved.exists) return state = { version: 1, key: randomBytes(32).toString('base64url'), port: 15721, routes: [] };
    if (!canEncrypt()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '无法解密本地路由数据');
    try {
      const value = JSON.parse(decrypt(Buffer.from(JSON.parse(saved.bytes.toString('utf8')).encrypted, 'base64')));
      if (value.version !== 1 || !/^[\w-]{43}$/.test(value.key) || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535 || !Array.isArray(value.routes) || value.routes.length > 50) throw new Error();
      value.routes = value.routes.map(route => normalize(route)); state = value; return state;
    } catch { throw fail('AI_TOOLS_ROUTER_STORAGE', '路由数据无法读取，原文件已保留'); }
  }
  function normalize(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['id', 'name', 'protocol', 'providerIds', 'failover'].includes(key))) throw fail('AI_TOOLS_ROUTE_INVALID', '路由配置格式无效');
    if (input.id !== undefined && (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id))) throw fail('AI_TOOLS_ROUTE_INVALID', '路由标识无效');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !PROTOCOLS.includes(input.protocol)
      || !Array.isArray(input.providerIds) || !input.providerIds.length || input.providerIds.length > 6 || new Set(input.providerIds).size !== input.providerIds.length || input.providerIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || typeof input.failover !== 'boolean') throw fail('AI_TOOLS_ROUTE_INVALID', '请填写名称并选择 1–6 个同协议供应商');
    return { ...(input.id ? { id: input.id } : {}), name: input.name.trim(), protocol: input.protocol, providerIds: [...input.providerIds], failover: input.failover };
  }
  function persist(value) {
    if (!canEncrypt()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，不能持久化路由密钥');
    let encrypted;
    try { encrypted = encrypt(JSON.stringify(value)); if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error(); }
    catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', '路由数据加密失败，原文件未修改'); }
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') })}\n`);
    atomicReplace(file, bytes, observed); observed = checksum(bytes); state = value;
  }
  function save(input) {
    const current = load(); const row = normalize(input);
    if (row.id && !current.routes.some(route => route.id === row.id)) throw fail('AI_TOOLS_ROUTE_MISSING', '路由不存在');
    for (const id of row.providerIds) { const provider = getProvider(id); if (provider.protocol !== row.protocol || !provider.apiKey || !provider.model) throw fail('AI_TOOLS_ROUTE_PROVIDER', '路由供应商需具有相同协议、密钥及默认模型'); }
    if (!row.id && current.routes.length >= 50) throw fail('AI_TOOLS_ROUTE_LIMIT', '最多保存 50 条路由');
    row.id ||= randomUUID(); persist({ ...current, routes: [...current.routes.filter(route => route.id !== row.id), row] }); return row;
  }
  function remove(id) { const current = load(); if (!current.routes.some(route => route.id === id)) throw fail('AI_TOOLS_ROUTE_MISSING', '路由不存在'); persist({ ...current, routes: current.routes.filter(route => route.id !== id) }); return { id }; }
  function prepare(port) {
    const current = load(); if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw fail('AI_TOOLS_ROUTER_PORT', '端口需为 1024–65535 的整数');
    if (!current.routes.length) throw fail('AI_TOOLS_ROUTE_MISSING', '请先保存至少一条路由');
    const routes = current.routes.map(route => ({ ...route, providers: route.providerIds.map(id => {
      const value = getProvider(id);
      if (value.protocol !== route.protocol || !value.apiKey || !value.model) throw fail('AI_TOOLS_ROUTE_PROVIDER', '供应商已变化，请重新编辑路由');
      if (/[^\x20-\x7e]/.test(value.apiKey)) throw fail('AI_TOOLS_ROUTE_PROVIDER', '路由 API 密钥必须为有效的 HTTP 请求头字符');
      const url = new URL(value.baseUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw fail('AI_TOOLS_ROUTER_HTTPS', '上游必须使用 HTTPS；仅本机服务允许 HTTP');
      if (['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port) throw fail('AI_TOOLS_ROUTER_LOOP', '路由不能指向自身监听端口');
      return { id: value.id, protocol: value.protocol, baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey };
    }) }));
    if (current.port !== port || observed === null) persist({ ...current, port });
    return { key: current.key, port, routes };
  }
  function validatePortable(payload) {
    exact(payload, ['version', 'port', 'routes'], '路由迁移');
    if (payload.version !== 1 || !Number.isSafeInteger(payload.port) || payload.port < 1024 || payload.port > 65535 || !Array.isArray(payload.routes) || payload.routes.length > 50) throw fail('AI_TOOLS_MIGRATION_FORMAT', '路由迁移版本、端口或数量无效');
    const ids = new Set();
    const routes = payload.routes.map(input => {
      const row = normalize(input);
      if (!UUID.test(row.id) || ids.has(row.id)) throw fail('AI_TOOLS_MIGRATION_FORMAT', '路由迁移标识无效或重复');
      ids.add(row.id); return row;
    });
    return { version: 1, port: payload.port, routes };
  }
  function exportPortable() { const current = load(); return { version: 1, port: current.port, routes: current.routes.map(route => ({ ...route, providerIds: [...route.providerIds] })) }; }
  function preparePortableImport(payload, { resolveProvider = getProvider, conflictingProviderIds = [] } = {}) {
    const current = load(); const incoming = validatePortable(payload); const conflicts = new Set(conflictingProviderIds);
    const routes = [...current.routes]; const acceptedRouteIds = []; const conflictingRouteIds = []; const warnings = []; let added = 0; let skipped = 0;
    for (const row of incoming.routes) {
      const old = current.routes.find(route => route.id === row.id);
      let compatible = true;
      for (const id of row.providerIds) {
        let provider;
        try { provider = resolveProvider(id); } catch { compatible = false; }
        if (conflicts.has(id) || !provider || provider.protocol !== row.protocol || !provider.apiKey || !provider.model) compatible = false;
      }
      if (old) {
        skipped++;
        if (compatible && JSON.stringify(old) === JSON.stringify(row)) acceptedRouteIds.push(row.id);
        else { conflictingRouteIds.push(row.id); warnings.push(`已有路由 ${row.name} 的定义或供应商配置不同，保留本机定义及其关联。`); }
        continue;
      }
      if (!compatible) { skipped++; conflictingRouteIds.push(row.id); warnings.push(`路由 ${row.name} 引用的供应商缺失或配置冲突，未导入该路由。`); continue; }
      routes.push(row); acceptedRouteIds.push(row.id); added++;
    }
    if (routes.length > 50) throw fail('AI_TOOLS_ROUTE_LIMIT', '合并后超过 50 条路由，未导入或截断');
    const next = { version: 1, key: current.key, port: observed === null ? incoming.port : current.port, routes };
    return { target: prepareStateWrite(file, next, observed, { canEncrypt, encrypt, decrypt }, 2 * 1024 * 1024), counts: { added, skipped }, acceptedRouteIds, conflictingRouteIds, warnings, key: next.key, port: next.port };
  }
  return { save, remove, prepare, exportPortable, preparePortableImport, validatePortable,
    getMigrationGuards() { load(); return [{ path: file, expectedHash: observed, limit: 2 * 1024 * 1024 }]; },
    snapshot: () => { const value = load(); return { port: value.port, routes: value.routes.map(route => ({ ...route, providerIds: [...route.providerIds], model: `awb-${route.id}` })) }; }, getKey: () => load().key };
}

module.exports = { createRouterConfig };
