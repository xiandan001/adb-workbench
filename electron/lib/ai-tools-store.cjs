const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getAiToolsCatalog } = require('./ai-tools-catalog.cjs');
const { readSafe, atomicReplace } = require('./ai-tools-file-safety.cjs');
const { normalizeQuotaConfig } = require('./ai-tools-quota.cjs');
const { prepareEncryptedMerge } = require('./ai-tools-portable-transaction.cjs');
const { normalizeClaudeModels } = require('./ai-tools-claude-models.cjs');
const { normalizeCliConfig, assertCliEndpoint } = require('./ai-tools-cli-config.cjs');

const FILE_NAME = 'ai-tools-store.v1.json';
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PROTOCOLS = new Set(['openai-chat', 'openai-responses', 'anthropic', 'gemini']);
const TOOL_IDS = new Set(getAiToolsCatalog().map(tool => tool.id));
const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = data => createHash('sha256').update(data).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasControl = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function text(value, label, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || hasControl(value) || (!optional && !value.trim())) throw fail('AI_TOOLS_PROVIDER_INVALID', `${label}无效`);
  return value.trim();
}
function normalizeQuota(value) {
  return normalizeQuotaConfig(value) || undefined;
}
function normalizeUrl(value) {
  const raw = text(value, '服务地址', 2048);
  let url;
  try { url = new URL(raw); } catch { throw fail('AI_TOOLS_PROVIDER_INVALID', '服务地址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('AI_TOOLS_PROVIDER_INVALID', '服务地址只支持 HTTP/HTTPS，不能包含密码、查询凭据或片段');
  return url.href.replace(/\/$/, '');
}
function validateProvider(value) {
  if (!plain(value) || Object.keys(value).some(key => !['id', 'name', 'protocol', 'baseUrl', 'model', 'claudeModels', 'cliConfig', 'contextWindow', 'targetApps', 'quota', 'apiKey', 'quotaKey'].includes(key))) throw fail('AI_TOOLS_PROVIDER_INVALID', '供应商配置无效');
  if (value.id !== undefined && (typeof value.id !== 'string' || !ID.test(value.id))) throw fail('AI_TOOLS_PROVIDER_INVALID', '供应商标识无效');
  if (!PROTOCOLS.has(value.protocol)) throw fail('AI_TOOLS_PROVIDER_INVALID', '供应商协议无效');
  if (!Array.isArray(value.targetApps) || value.targetApps.length > 12 || value.targetApps.some(id => !TOOL_IDS.has(id)) || new Set(value.targetApps).size !== value.targetApps.length) throw fail('AI_TOOLS_PROVIDER_INVALID', '目标工具无效');
  const result = {
    ...(value.id ? { id: value.id } : {}), name: text(value.name, '名称', 120), protocol: value.protocol,
    baseUrl: normalizeUrl(value.baseUrl), model: text(value.model, '模型', 256, true), targetApps: [...value.targetApps],
  };
  if (['__proto__', 'prototype', 'constructor'].includes(result.model)) throw fail('AI_TOOLS_PROVIDER_INVALID', '模型名称不能使用保留字段名');
  if (value.claudeModels !== undefined) result.claudeModels = normalizeClaudeModels(value.claudeModels);
  if (value.cliConfig !== undefined) result.cliConfig = normalizeCliConfig(value.cliConfig);
  const quota = normalizeQuota(value.quota);
  if (quota) result.quota = quota;
  if (value.contextWindow !== undefined && value.contextWindow !== null) {
    if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1 || value.contextWindow > 2147483647) throw fail('AI_TOOLS_PROVIDER_INVALID', '模型上下文上限必须为 1–2147483647 的整数');
    result.contextWindow = value.contextWindow;
  }
  for (const key of ['apiKey', 'quotaKey']) {
    if (value[key] !== undefined) result[key] = value[key] === null ? null : text(value[key], '凭据', 8192);
  }
  return result;
}
function publicProvider(value) {
  const result = clone(value);
  result.hasCredential = Boolean(value.apiKey); result.hasQuotaCredential = Boolean(value.quotaKey);
  delete result.apiKey; delete result.quotaKey;
  return result;
}

function createAiToolsStore({ directory, canEncrypt = () => false, encrypt, decrypt } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw fail('AI_TOOLS_STORE_PATH', 'AI 工具数据目录无效');
  const file = path.join(directory, FILE_NAME);
  let state; let persistent = false; let warning = ''; let observedHash = null;
  const cryptoAvailable = () => { try { return canEncrypt() && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  function readDisk() {
    return readSafe(file, fs, MAX_BYTES * 2).bytes;
  }
  function decodeState(bytes) {
    if (!bytes) return { version: 1, providers: [] };
    if (!cryptoAvailable()) throw new Error('Encryption unavailable');
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (!plain(envelope) || envelope.version !== 1 || Object.keys(envelope).length !== 2 || typeof envelope.encrypted !== 'string') throw new Error('Envelope');
    const ciphertext = Buffer.from(envelope.encrypted, 'base64');
    if (!ciphertext.length || ciphertext.toString('base64') !== envelope.encrypted) throw new Error('Ciphertext');
    const raw = decrypt(ciphertext);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Plaintext limit');
    const parsed = JSON.parse(raw);
    if (!plain(parsed) || parsed.version !== 1 || Object.keys(parsed).length !== 2 || !Array.isArray(parsed.providers) || parsed.providers.length > 200) throw new Error('Schema');
    const ids = new Set();
    parsed.providers = parsed.providers.map(value => { const normalized = validateProvider(value); if (!normalized.id || ids.has(normalized.id)) throw new Error('Duplicate id'); ids.add(normalized.id); return normalized; });
    return parsed;
  }
  function load() {
    if (state) return state;
    try {
      const bytes = readDisk(); persistent = Boolean(cryptoAvailable());
      if (!persistent) warning = '本机安全加密不可用，供应商及凭据仅保存在本次内存中，退出后消失。';
      if (!bytes) { state = { version: 1, providers: [] }; return state; }
      if (!persistent) throw new Error('Encryption unavailable for existing store');
      const parsed = decodeState(bytes);
      observedHash = hash(bytes); state = parsed; return state;
    } catch { throw fail('AI_TOOLS_STORE_READ', 'AI 工具加密数据无法读取，已保留原文件；请检查系统加密与数据文件'); }
  }
  function unchanged() {
    let bytes;
    try { bytes = readDisk(); } catch { throw fail('AI_TOOLS_STORE_CHANGED', 'AI 工具数据文件已变化，未覆盖，请重新打开应用后重试'); }
    if ((bytes ? hash(bytes) : null) !== observedHash) throw fail('AI_TOOLS_STORE_CHANGED', 'AI 工具数据文件已变化，未覆盖，请重新打开应用后重试');
  }
  function persist(next) {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw fail('AI_TOOLS_STORE_LIMIT', 'AI 工具数据已超过容量限制');
    if (!persistent) { state = next; return; }
    if (!cryptoAvailable()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统加密当前不可用，原有数据未修改');
    let ciphertext;
    try {
      ciphertext = encrypt(serialized);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_BYTES + 65536) throw new Error('Encryption output');
    } catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', '供应商数据加密失败，原有数据未修改'); }
    const content = Buffer.from(`${JSON.stringify({ version: 1, encrypted: ciphertext.toString('base64') })}\n`, 'utf8');
    try {
      unchanged(); atomicReplace(file, content, observedHash, fs, MAX_BYTES * 2);
      observedHash = hash(content); state = next;
    } catch (error) {
      if (error.code === 'AI_TOOLS_STORE_CHANGED') throw error;
      throw fail('AI_TOOLS_STORE_SAVE', 'AI 工具数据保存失败，原有数据未修改');
    }
  }
  function getProvider(id) {
    const found = load().providers.find(value => value.id === id);
    if (!found) throw fail('AI_TOOLS_PROVIDER_MISSING', '供应商不存在或已删除');
    return clone(found);
  }
  function saveProvider(input) {
    const current = load(); const value = validateProvider(input);
    if (value.protocol === 'anthropic' && value.targetApps.includes('claude')) assertCliEndpoint(value, 'claude');
    if (value.protocol === 'openai-responses' && value.targetApps.includes('codex')) assertCliEndpoint(value, 'codex');
    const existing = value.id ? getProvider(value.id) : null;
    if (!existing && current.providers.length >= 200) throw fail('AI_TOOLS_PROVIDER_LIMIT', '最多保存 200 个供应商');
    if (existing && new URL(existing.baseUrl).origin !== new URL(value.baseUrl).origin && existing.apiKey && value.apiKey === undefined) throw fail('AI_TOOLS_CREDENTIAL_ORIGIN', '服务地址已改变，请重新填写或明确移除凭据，不会转发旧地址的凭据');
    if (input.quota === undefined && existing?.quota) value.quota = clone(existing.quota);
    if (input.contextWindow === undefined && existing?.contextWindow !== undefined) value.contextWindow = existing.contextWindow;
    if (input.claudeModels === undefined && existing?.claudeModels !== undefined) value.claudeModels = clone(existing.claudeModels);
    if (input.cliConfig === undefined && existing?.cliConfig !== undefined) value.cliConfig = clone(existing.cliConfig);
    const quotaIdentity = row => JSON.stringify([row.quota?.adapter || null, row.quota?.credentialOrigin || new URL(row.baseUrl).origin]);
    if (existing?.quotaKey && value.quotaKey === undefined && quotaIdentity(existing) !== quotaIdentity(value)) throw fail('AI_TOOLS_CREDENTIAL_ORIGIN', '额度来源或地址已改变，请重新填写或明确移除独立额度凭据');
    for (const key of ['apiKey', 'quotaKey']) {
      if (value[key] === undefined && existing?.[key]) value[key] = existing[key];
      if (value[key] === null) delete value[key];
    }
    value.id ||= randomUUID();
    persist({ version: 1, providers: existing ? current.providers.map(row => row.id === value.id ? value : row) : [...current.providers, value] });
    return publicProvider(value);
  }
  function removeProvider(id) {
    getProvider(id); persist({ version: 1, providers: load().providers.filter(row => row.id !== id) });
    return { id };
  }
  function snapshot() { return { providers: load().providers.map(publicProvider), persistent, warning }; }
  function exportPortable() { return clone(load()); }
  function preparePortableImport(payload) {
    const current = load();
    if (!persistent || !cryptoAvailable()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，不能持久保存导入的供应商');
    if (!plain(payload) || payload.version !== 1 || Object.keys(payload).sort().join(',') !== 'providers,version' || !Array.isArray(payload.providers) || payload.providers.length > 200) throw fail('AI_TOOLS_PORTABLE_FORMAT', '供应商备份结构无效');
    const ids = new Set(); const existing = new Set(current.providers.map(row => row.id)); let skipped = 0;
    const incoming = payload.providers.map(row => {
      const value = validateProvider(row);
      if (!value.id || ids.has(value.id)) throw fail('AI_TOOLS_PORTABLE_FORMAT', '供应商备份含缺失或重复标识');
      ids.add(value.id); for (const key of ['apiKey', 'quotaKey']) if (value[key] === null) delete value[key]; return value;
    }).filter(row => { if (existing.has(row.id)) { skipped += 1; return false; } return true; });
    if (current.providers.length + incoming.length > 200) throw fail('AI_TOOLS_STORE_LIMIT', '导入后供应商会超过 200 条，未修改任何数据');
    const next = { version: 1, providers: [...current.providers, ...incoming] }; const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw fail('AI_TOOLS_STORE_LIMIT', '导入后供应商数据会超过容量限制');
    let ciphertext;
    try { ciphertext = encrypt(serialized); if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_BYTES + 65536) throw new Error('Encryption output'); }
    catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', '导入数据加密失败，未修改原数据'); }
    const after = Buffer.from(`${JSON.stringify({ version: 1, encrypted: ciphertext.toString('base64') })}\n`);
    return prepareEncryptedMerge({ file, beforeState: current, nextState: next, getState: load, acceptState(value, checksum) { state = value; observedHash = checksum; }, after,
      expectedHash: observedHash, counts: { added: incoming.length, skipped }, available: cryptoAvailable, limit: MAX_BYTES * 2 });
  }
  function preparePortableRecovery({ path: target, bytes, expectedHash } = {}) {
    const current = load();
    if (target !== file || bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES * 2)) throw fail('AI_TOOLS_PORTABLE_FORMAT', '供应商恢复目标无效');
    let next;
    try { next = decodeState(bytes); } catch { throw fail('AI_TOOLS_PORTABLE_FORMAT', '供应商恢复内容无法验证，未修改数据'); }
    return prepareEncryptedMerge({ file, beforeState: current, nextState: next, getState: load, acceptState(value, checksum) { state = value; observedHash = checksum; }, after: bytes,
      expectedHash, counts: {}, available: cryptoAvailable, limit: MAX_BYTES * 2 });
  }
  return { snapshot, saveProvider, removeProvider, getProvider, exportPortable, preparePortableImport, preparePortableRecovery, getPortableTarget: () => file };
}

module.exports = { createAiToolsStore, validateProvider, normalizeQuota };
