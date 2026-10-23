const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, checksum, readSafe, checkHash, atomicReplace, assertSafeParents } = require('./ai-tools-file-safety.cjs');

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 8 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const invalid = () => fail('AI_TOOLS_PORTABLE_FORMAT', 'AI 导入恢复批次无法验证，未修改任何数据');

function createPortableRecovery({ directory, stores, now, io, assertReady }) {
  const tokens = new Map();
  function readBatch(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw invalid();
    const folder = path.join(directory, id); const file = path.join(folder, 'manifest.json'); const raw = readSafe(file, io);
    if (!raw.bytes) throw invalid(); let value;
    try { value = JSON.parse(raw.bytes.toString('utf8')); } catch { throw invalid(); }
    if (!value || Object.keys(value).sort().join(',') !== 'createdAt,files,id,status,version' || value.version !== 1 || value.id !== id || !Number.isSafeInteger(value.createdAt) || !['prepared', 'committed', 'rolled-back', 'recovery-required', 'recovered'].includes(value.status) || !Array.isArray(value.files) || value.files.length !== 2) throw invalid();
    value.files.forEach((row, index) => {
      if (!row || Object.keys(row).sort().join(',') !== 'afterHash,beforeHash,original,path,staged' || row.path !== stores[index].getPortableTarget() || !HASH.test(row.afterHash) || row.beforeHash !== null && !HASH.test(row.beforeHash) || row.staged !== `${index}.next.encrypted` || row.original !== (row.beforeHash === null ? null : `${index}.previous.encrypted`)) throw invalid();
    });
    return { id, folder, file, hash: raw.hash, value };
  }
  function listRecoveries() {
    assertReady(); assertSafeParents(path.join(directory, 'probe'), io); let entries;
    try { entries = io.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const dirs = entries.filter(entry => entry.isDirectory() && ID.test(entry.name)); if (dirs.length > 20) throw fail('AI_TOOLS_PORTABLE_LIMIT', '恢复批次数量超过限制，请检查本地恢复目录');
    return dirs.flatMap(entry => {
      // A staging directory without a manifest cannot have reached the commit loop.
      if (!readSafe(path.join(directory, entry.name, 'manifest.json'), io).exists) return [];
      const batch = readBatch(entry.name);
      return ['prepared', 'recovery-required'].includes(batch.value.status) ? [{ id: batch.id, createdAt: batch.value.createdAt, status: batch.value.status, stores: ['providers', 'resources'] }] : [];
    });
  }
  function previewRecovery({ backupId } = {}) {
    assertReady(); const batch = readBatch(backupId);
    if (!['prepared', 'recovery-required'].includes(batch.value.status)) throw fail('AI_TOOLS_PORTABLE_CHANGED', '该导入批次已经结束，无需中断恢复');
    const counts = { restore: 0, unchanged: 0 }; const transactions = [];
    batch.value.files.forEach((row, index) => {
      const before = row.original === null ? null : readSafe(path.join(batch.folder, row.original), io, LIMIT).bytes;
      const after = readSafe(path.join(batch.folder, row.staged), io, LIMIT).bytes;
      if (checksum(before) !== row.beforeHash || checksum(after) !== row.afterHash) throw invalid();
      const current = readSafe(row.path, io, LIMIT);
      if (current.hash !== row.beforeHash && current.hash !== row.afterHash) throw fail('AI_TOOLS_PORTABLE_CHANGED', '导入目标出现外部修改，不能覆盖；请检查加密恢复备份');
      // Validate the encrypted original schema and hold a memory/disk lease, even for an unchanged store.
      const tx = stores[index].preparePortableRecovery({ path: row.path, bytes: before, expectedHash: current.hash });
      transactions.push(tx); counts[current.hash === row.beforeHash ? 'unchanged' : 'restore'] += 1;
    });
    for (const [key, value] of tokens) if (value.expiresAt < now()) tokens.delete(key);
    if (tokens.size >= 4) tokens.delete(tokens.keys().next().value);
    const token = randomUUID(); const expiresAt = now() + TTL; tokens.set(token, { batch, transactions, counts, expiresAt });
    return { token, expiresAt, backupId: batch.id, counts, warnings: ['仅恢复此中断批次写入的两个 AI 数据库；文件或库在预览后变化将拒绝恢复。', '不会修改任何 CLI 配置、用户文件、登录信息或会员数据。'] };
  }
  function applyRecovery({ token } = {}) {
    assertReady(); const operation = tokens.get(token); tokens.delete(token);
    if (!operation || operation.expiresAt < now()) throw fail('AI_TOOLS_PORTABLE_EXPIRED', '恢复预览已过期或使用过，请重新预览');
    const { batch, transactions } = operation; checkHash(batch.file, batch.hash, io);
    for (const tx of transactions) tx.assertCurrent(); const committed = [];
    try {
      for (const tx of transactions) { tx.commit(); committed.push(tx); }
    } catch {
      let restored = true; for (const tx of committed.reverse()) { try { tx.rollback(); } catch { restored = false; } }
      const error = fail('AI_TOOLS_PORTABLE_RECOVERY_FAILED', restored ? '中断恢复失败，已保留恢复前的数据，请重试' : '中断恢复失败且出现其他修改，未覆盖新数据；请检查加密恢复备份'); error.backupId = batch.id; throw error;
    }
    let warning = '';
    try { atomicReplace(batch.file, Buffer.from(`${JSON.stringify({ ...batch.value, status: 'recovered' })}\n`), batch.hash, io); }
    catch { warning = '数据已恢复，但批次状态更新失败；再次预览会核对已恢复的文件。'; }
    return { backupId: batch.id, counts: { ...operation.counts }, warning };
  }
  return { listRecoveries, previewRecovery, applyRecovery, dispose() { tokens.clear(); } };
}

module.exports = { createPortableRecovery };
