const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv } = require('node:crypto');
const { promisify } = require('node:util');
const { fail, checksum, readSafe, checkHash, atomicReplace, assertSafeParents } = require('./ai-tools-file-safety.cjs');
const { createPortableRecovery } = require('./ai-tools-portable-recovery.cjs');

const derive = promisify(scrypt);
const MAX_FILE = 16 * 1024 * 1024;
const MAX_PLAIN = 8 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const formatError = () => fail('AI_TOOLS_PORTABLE_FORMAT', tr("AI 备份结构、版本或容量无效，未导入任何数据"));
function password(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 8 || Buffer.byteLength(value) > 1024 || value.includes('\0')) throw fail('AI_TOOLS_PORTABLE_PASSWORD', tr("备份密码需要 8–1024 字节，不能包含空字符"));
  return value;
}
function base64(value, exact, maximum = exact) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) throw formatError();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < exact || bytes.length > maximum) throw formatError();
  return bytes;
}
function header(envelope) { return { version: 1, cipher: 'aes-256-gcm', kdf: KDF, salt: envelope.salt, iv: envelope.iv }; }
async function encryptBundle(payload, secret) {
  const serialized = Buffer.from(JSON.stringify(payload));
  if (serialized.length > MAX_PLAIN) throw fail('AI_TOOLS_PORTABLE_LIMIT', tr("AI 备份内容超过 8 MiB 容量限制"));
  const salt = randomBytes(16); const iv = randomBytes(12); const key = await derive(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  try {
    const envelope = header({ salt: salt.toString('base64'), iv: iv.toString('base64') }); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(envelope))); const ciphertext = Buffer.concat([cipher.update(serialized), cipher.final()]);
    return Buffer.from(`${JSON.stringify({ ...envelope, tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })}\n`);
  } finally { key.fill(0); serialized.fill(0); }
}
async function decryptBundle(bytes, secret) {
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { throw formatError(); }
  if (!plain(envelope) || Object.keys(envelope).sort().join(',') !== 'cipher,ciphertext,iv,kdf,salt,tag,version' || envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm' || !plain(envelope.kdf) || Object.keys(envelope.kdf).sort().join(',') !== 'N,name,p,r' || Object.entries(KDF).some(([key, value]) => envelope.kdf[key] !== value)) throw formatError();
  const salt = base64(envelope.salt, 16); const iv = base64(envelope.iv, 12); const tag = base64(envelope.tag, 16); const ciphertext = base64(envelope.ciphertext, 1, MAX_PLAIN);
  const key = await derive(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }); let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(JSON.stringify(header(envelope)))); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'createdAt,providers,resources,version' || value.version !== 1 || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw formatError();
    return value;
  } catch (error) { if (error.code === 'AI_TOOLS_PORTABLE_FORMAT') throw error; throw fail('AI_TOOLS_PORTABLE_DECRYPT', tr("备份密码不正确或文件已损坏，未导入任何数据")); }
  finally { key.fill(0); plaintext?.fill(0); }
}

function createAiToolsPortable({ directory, providers, resources, now = Date.now, filesystem: io = fs } = {}) {
  if (!validPath(directory) || ![providers, resources].every(store => ['exportPortable', 'preparePortableImport', 'preparePortableRecovery', 'getPortableTarget'].every(key => typeof store?.[key] === 'function'))) throw fail('AI_TOOLS_PORTABLE_CONFIG', tr("AI 备份服务配置无效"));
  const tokens = new Map(); let disposed = false; let busy = false;
  const active = () => { if (disposed) throw fail('AI_TOOLS_PORTABLE_DISPOSED', tr("AI 备份服务已关闭")); };
  function assertReady() { active(); if (busy) throw fail('AI_TOOLS_PORTABLE_BUSY', tr("另一项 AI 加密备份操作正在进行，请稍后再试")); }
  const recovery = createPortableRecovery({ directory, stores: [providers, resources], now, io, assertReady });
  async function exclusive(operation) { active(); if (busy) throw fail('AI_TOOLS_PORTABLE_BUSY', tr("另一项 AI 加密备份操作正在进行，请稍后再试")); busy = true; try { return await operation(); } finally { busy = false; } }
  function checkPath(value) { if (!validPath(value)) throw fail('AI_TOOLS_PORTABLE_PATH', tr("请选择有效的 AI 备份文件路径")); return path.resolve(value); }
  async function exportBundle({ path: target, password: secret, expectedHash = null } = {}) {
    return exclusive(async () => {
      password(secret); const file = checkPath(target); const original = readSafe(file, io, MAX_FILE);
      if (original.exists && expectedHash === null) throw fail('AI_TOOLS_PORTABLE_EXISTS', tr("目标文件已经存在，请重新选择文件或明确确认覆盖"));
      if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw fail('AI_TOOLS_PORTABLE_PATH', tr("备份覆盖确认无效"));
      if (original.hash !== expectedHash) throw fail('AI_TOOLS_CONFIG_CHANGED', tr("目标备份文件已变化，未覆盖"));
      const providerData = providers.exportPortable(); const resourceData = resources.exportPortable();
      const payload = { version: 1, createdAt: now(), providers: providerData, resources: resourceData };
      const bytes = await encryptBundle(payload, secret); active(); atomicReplace(file, bytes, original.hash, io, MAX_FILE);
      return { path: file, bytes: bytes.length, counts: { providers: providerData.providers.length, mcpServers: resourceData.mcpServers.length, prompts: resourceData.prompts.length } };
    });
  }
  async function previewImport({ path: source, password: secret } = {}) {
    return exclusive(async () => {
      password(secret); const file = checkPath(source); const before = readSafe(file, io, MAX_FILE); if (!before.bytes) throw fail('AI_TOOLS_PORTABLE_MISSING', tr("备份文件不存在"));
      const payload = await decryptBundle(before.bytes, secret); active();
      const providerTransaction = providers.preparePortableImport(payload.providers); const resourceTransaction = resources.preparePortableImport(payload.resources);
      const counts = { providers: providerTransaction.counts, ...resourceTransaction.counts };
      for (const [key, value] of tokens) if (value.expiresAt < now()) tokens.delete(key);
      if (tokens.size >= 4) tokens.delete(tokens.keys().next().value);
      const token = randomUUID(); const expiresAt = now() + TTL;
      tokens.set(token, { file, sourceHash: before.hash, expiresAt, counts, transactions: [providerTransaction, resourceTransaction] });
      return { token, expiresAt, counts: structuredClone(counts), warnings: [tr("仅合并新增 ID，已有相同 ID 的记录将跳过且不覆盖。"), tr("不会导入本机路径、CLI 应用状态、登录账号或会员信息；凭据将使用本机系统加密重新保存。")] };
    });
  }
  function stage(transactions) {
    assertSafeParents(path.join(directory, 'probe'), io); io.mkdirSync(directory, { recursive: true }); assertSafeParents(path.join(directory, 'probe'), io);
    const existing = io.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name));
    if (existing.length >= 20) throw fail('AI_TOOLS_PORTABLE_LIMIT', tr("导入恢复批次达到 20 个，请先检查本地恢复目录"));
    const id = randomUUID(); const folder = path.join(directory, id); io.mkdirSync(folder, { mode: 0o700 });
    const manifest = { version: 1, id, createdAt: now(), status: 'prepared', files: [] };
    try {
      transactions.forEach((tx, index) => {
        tx.assertCurrent(); const target = tx.target;
        if (!validPath(target.path) || !Buffer.isBuffer(target.after) || target.after.length > target.limit || target.afterHash !== checksum(target.after) || checksum(target.before) !== target.beforeHash) throw fail('AI_TOOLS_PORTABLE_CONFIG', tr("AI 导入事务无效"));
        const originalName = `${index}.previous.encrypted`; const stagedName = `${index}.next.encrypted`;
        if (target.before !== null) atomicReplace(path.join(folder, originalName), target.before, null, io, target.limit);
        atomicReplace(path.join(folder, stagedName), target.after, null, io, target.limit);
        manifest.files.push({ path: target.path, beforeHash: target.beforeHash, afterHash: target.afterHash, original: target.before === null ? null : originalName, staged: stagedName });
      });
      atomicReplace(path.join(folder, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest)}\n`), null, io);
      return { id, folder, manifest };
    } catch (error) { error.backupId = id; throw error; }
  }
  function markBatch(batch, status) {
    const file = path.join(batch.folder, 'manifest.json'); const before = readSafe(file, io);
    atomicReplace(file, Buffer.from(`${JSON.stringify({ ...batch.manifest, status })}\n`), before.hash, io);
  }
  function applyImport({ token } = {}) {
    assertReady(); const operation = tokens.get(token); tokens.delete(token);
    if (!operation || operation.expiresAt < now()) throw fail('AI_TOOLS_PORTABLE_EXPIRED', tr("导入预览已过期或使用过，请重新预览"));
    checkHash(operation.file, operation.sourceHash, io, MAX_FILE); for (const tx of operation.transactions) tx.assertCurrent();
    const batch = stage(operation.transactions); const committed = [];
    try {
      for (const tx of operation.transactions) { tx.commit(); committed.push(tx); }
    } catch {
      let complete = true; for (const tx of committed.reverse()) { try { tx.rollback(); } catch { complete = false; } }
      try { markBatch(batch, complete ? 'rolled-back' : 'recovery-required'); } catch { /* Original encrypted backups remain available. */ }
      const error = fail('AI_TOOLS_PORTABLE_IMPORT_FAILED', complete ? tr("AI 数据导入失败，已回滚本次写入并保留加密恢复备份") : tr("AI 数据导入失败且检测到后续修改，未覆盖新数据，请检查加密恢复备份")); error.backupId = batch.id; throw error;
    }
    let warning = '';
    try { markBatch(batch, 'committed'); } catch { warning = tr("数据已成功导入，但恢复批次状态更新失败；原始加密恢复文件仍保留。"); }
    return { counts: structuredClone(operation.counts), backupId: batch.id, warning };
  }
  return { exportBundle, previewImport, applyImport, listRecoveries: recovery.listRecoveries, previewRecovery: recovery.previewRecovery, applyRecovery: recovery.applyRecovery,
    dispose() { disposed = true; tokens.clear(); recovery.dispose(); } };
}

module.exports = { createAiToolsPortable };
