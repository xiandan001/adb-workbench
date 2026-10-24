const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { checksum, readSafe, atomicReplace, fail } = require('./ai-tools-file-safety.cjs');
const { plain, clone, validateId, normalizeMcp, normalizePrompt } = require('./ai-tools-resources-policy.cjs');
const { prepareEncryptedMerge } = require('./ai-tools-portable-transaction.cjs');

const MAX_BYTES = 4 * 1024 * 1024;
const FILE_NAME = 'ai-tools-resources.v1.json';
function createResourceStore({ directory, canEncrypt = () => false, encrypt, decrypt, filesystem: io = fs }) {
  const file = path.join(directory, FILE_NAME);
  let state; let persistent = false; let warning = ''; let observedHash = null;
  const encrypted = () => { try { return Boolean(canEncrypt()) && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  function encode(value, limit = MAX_BYTES) {
    if (!encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，不能安全保存或备份资源"));
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > limit) throw fail('AI_TOOLS_RESOURCE_LIMIT', tr("资源数据超过容量限制"));
    try {
      const cipher = encrypt(content);
      if (!Buffer.isBuffer(cipher) || !cipher.length || cipher.length > limit + 65536) throw new Error('Cipher output');
      return Buffer.from(`${JSON.stringify({ version: 1, encrypted: cipher.toString('base64') })}\n`);
    } catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', tr("资源加密失败，未修改原数据")); }
  }
  function decode(bytes, limit = MAX_BYTES) {
    if (!encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，无法读取加密资源"));
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (!plain(envelope) || envelope.version !== 1 || Object.keys(envelope).length !== 2 || typeof envelope.encrypted !== 'string') throw new Error('Envelope');
    const cipher = Buffer.from(envelope.encrypted, 'base64');
    if (!cipher.length || cipher.toString('base64') !== envelope.encrypted) throw new Error('Cipher');
    const raw = decrypt(cipher);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > limit) throw new Error('Plaintext');
    return JSON.parse(raw);
  }
  function decodeState(bytes) {
    if (!bytes) return { version: 1, mcpServers: [], prompts: [], applications: [] };
    const value = decode(bytes);
    if (!plain(value) || value.version !== 1 || Object.keys(value).length !== 4 || !Array.isArray(value.mcpServers) || value.mcpServers.length > 256 || !Array.isArray(value.prompts) || value.prompts.length > 256 || !Array.isArray(value.applications) || value.applications.length > 2048) throw new Error('Schema');
    const ids = new Set();
    for (const [field, normalize] of [['mcpServers', normalizeMcp], ['prompts', normalizePrompt]]) value[field] = value[field].map(row => { const normalized = normalize(row); validateId(normalized.id); if (ids.has(normalized.id)) throw new Error('Duplicate'); ids.add(normalized.id); return normalized; });
    const applications = new Set();
    for (const application of value.applications) {
      if (!plain(application) || Object.keys(application).sort().join(',') !== 'hash,kind,path,resourceId,toolId' || !['mcp', 'prompt'].includes(application.kind) || !value[application.kind === 'mcp' ? 'mcpServers' : 'prompts'].some(row => row.id === application.resourceId) || typeof application.toolId !== 'string' || typeof application.path !== 'string' || !path.isAbsolute(application.path) || !/^[a-f0-9]{64}$/.test(application.hash)) throw new Error('Application');
      const slot = `${application.kind}/${application.toolId}/${application.kind === 'mcp' ? application.resourceId : ''}`;
      if (applications.has(slot)) throw new Error('Duplicate application'); applications.add(slot);
    }
    return value;
  }
  function load() {
    if (state) return state;
    try {
      const current = readSafe(file, io, MAX_BYTES * 2); observedHash = current.hash; persistent = encrypted();
      if (!persistent) warning = tr("本机安全加密不可用，资源仅保存在本次内存中，退出后消失；不能应用到外部配置。");
      if (!current.bytes) { state = { version: 1, mcpServers: [], prompts: [], applications: [] }; return state; }
      const value = decodeState(current.bytes);
      state = value; return state;
    } catch { throw fail('AI_TOOLS_RESOURCE_STORE_READ', tr("资源加密文件无法读取，已保留原文件，不会覆盖或自动恢复为空")); }
  }
  function unchanged() {
    load();
    if (readSafe(file, io, MAX_BYTES * 2).hash !== observedHash) throw fail('AI_TOOLS_RESOURCE_STORE_CHANGED', tr("资源库在外部已变化，未覆盖，请重新打开应用"));
  }
  function persist(next) {
    load();
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('AI_TOOLS_RESOURCE_LIMIT', tr("资源库超过 4 MiB 容量限制"));
    unchanged();
    if (!persistent) { state = next; return; }
    const bytes = encode(next); atomicReplace(file, bytes, observedHash, io, MAX_BYTES * 2);
    state = next; observedHash = checksum(bytes);
  }
  function exportPortable() { const current = load(); return clone({ version: 1, mcpServers: current.mcpServers, prompts: current.prompts }); }
  function preparePortableImport(payload) {
    const current = load();
    if (!persistent || !encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，不能持久保存导入的资源"));
    if (!plain(payload) || payload.version !== 1 || Object.keys(payload).sort().join(',') !== 'mcpServers,prompts,version') throw fail('AI_TOOLS_PORTABLE_FORMAT', tr("资源备份结构无效"));
    const next = clone(current); const ids = new Set(); const existing = new Set([...current.mcpServers, ...current.prompts].map(row => row.id)); const counts = {};
    for (const [field, normalize] of [['mcpServers', normalizeMcp], ['prompts', normalizePrompt]]) {
      if (!Array.isArray(payload[field]) || payload[field].length > 256) throw fail('AI_TOOLS_PORTABLE_FORMAT', tr("资源备份条目无效或超过数量限制"));
      let skipped = 0;
      const incoming = payload[field].map(row => { const value = normalize(row); validateId(value.id); if (ids.has(value.id)) throw fail('AI_TOOLS_PORTABLE_FORMAT', tr("资源备份含重复标识")); ids.add(value.id); return value; })
        .filter(row => { if (existing.has(row.id)) { skipped += 1; return false; } return true; });
      if (current[field].length + incoming.length > 256) throw fail('AI_TOOLS_RESOURCE_LIMIT', tr("导入后资源会超过数量限制，未修改任何数据"));
      next[field].push(...incoming); counts[field] = { added: incoming.length, skipped };
    }
    return prepareEncryptedMerge({ file, beforeState: current, nextState: next, getState: load, acceptState(value, checksum) { state = value; observedHash = checksum; },
      after: encode(next), expectedHash: observedHash, counts, available: encrypted, limit: MAX_BYTES * 2, filesystem: io });
  }
  function preparePortableRecovery({ path: target, bytes, expectedHash } = {}) {
    const current = load();
    if (target !== file || bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES * 2)) throw fail('AI_TOOLS_PORTABLE_FORMAT', tr("资源恢复目标无效"));
    let next;
    try { next = decodeState(bytes); } catch { throw fail('AI_TOOLS_PORTABLE_FORMAT', tr("资源恢复内容无法验证，未修改数据")); }
    return prepareEncryptedMerge({ file, beforeState: current, nextState: next, getState: load, acceptState(value, checksum) { state = value; observedHash = checksum; }, after: bytes,
      expectedHash, counts: {}, available: encrypted, limit: MAX_BYTES * 2, filesystem: io });
  }
  return { load, persist, unchanged, encrypted, encode, decode, exportPortable, preparePortableImport, preparePortableRecovery, getPortableTarget: () => file, copy: () => clone(load()), info() { load(); return { persistent, warning }; } };
}
module.exports = { createResourceStore };
