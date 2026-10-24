const { tr } = require('./localization.cjs');
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { gzip, gunzipSync } = require('zlib');
const { promisify } = require('util');
const policy = require('./data-migration-policy.cjs');
const aiPlan = require('./data-migration-ai-plan.cjs');
const {
  createArchive, readArchive, validatePayload, digest, safeRoot, safePath, boundedRead, MAX_EXPANDED_BYTES, MAX_FILE_BYTES
} = require('./data-migration-archive.cjs');
const gzipAsync = promisify(gzip);

const PENDING = 'data-migration-pending.gz';
const JOURNAL = 'data-migration-journal.json';
const RECOVERY = 'data-migration-recovery';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_JOURNAL_BYTES = 12 * 1024 * 1024;

function originalPreferences(preferences) {
  policy.normalizePreferences(preferences);
  // Validation must not normalize the pre-import snapshot: rollback restores its exact strings.
  return { ...preferences };
}

async function atomicWrite(root, relative, bytes, expectedHash) {
  const target = await safePath(root, relative, { createParents: true });
  const tempRelative = `${relative}.${randomUUID()}.tmp`;
  const temporary = await safePath(root, tempRelative);
  let handle; let owned = false;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    owned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Recheck the destination after writing; no renderer-selected path can be renamed over.
    await safePath(root, relative);
    if (expectedHash !== undefined && await currentHash(root, relative, aiPlan.fileLimit(relative) || MAX_FILE_BYTES) !== expectedHash) throw new Error(tr("迁移目标在临时文件写入期间发生外部变化，未覆盖"));
    await fs.promises.rename(temporary, target);
    owned = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned) await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function removeFile(root, relative, expectedHash) {
  const target = await safePath(root, relative);
  if (expectedHash !== undefined && await currentHash(root, relative, aiPlan.fileLimit(relative) || MAX_FILE_BYTES) !== expectedHash) throw new Error(tr("迁移目标在删除前发生外部变化，未删除"));
  await fs.promises.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function exists(root, relative) {
  const target = await safePath(root, relative);
  try { await fs.promises.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function hasPendingImport(userData) {
  return [PENDING, JOURNAL].some(name => fs.existsSync(path.join(userData, name)));
}

async function currentHash(root, name, limit = MAX_FILE_BYTES) {
  if (!await exists(root, name)) return null;
  const target = await safePath(root, name); const stat = await fs.promises.lstat(target);
  if (stat.nlink !== 1) throw new Error(tr("迁移目标包含硬链接，已停止操作"));
  return bytesDigest(await boundedRead(root, name, limit));
}

async function checkAiState(root, writes, guards, { after = false } = {}) {
  const required = new Map([...guards, ...writes].map(row => [row.name, row.expectedHash]));
  if (after) for (const row of writes) required.set(row.name, bytesDigest(row.bytes));
  for (const [name, expected] of required) if (await currentHash(root, name, aiPlan.fileLimit(name)) !== expected) throw new Error(tr("AI 数据在预览或暂存后已变化，导入计划已失效；原有外部修改不会被覆盖"));
}

async function stageImport(userData, input, currentPreferences, { aiWrites = [], aiGuards = [] } = {}) {
  const root = await safeRoot(userData);
  if (await exists(root, PENDING) || await exists(root, JOURNAL)) throw new Error(tr("已有待完成的数据导入，请先重启应用"));
  const { payload } = validatePayload(input);
  const previousPreferences = originalPreferences(currentPreferences);
  const writes = aiPlan.normalizeWrites(aiWrites); const guards = aiPlan.normalizeGuards(aiGuards, writes);
  await checkAiState(root, writes, guards);
  const pending = { schemaVersion: 2, id: randomUUID(), payload, previousPreferences, aiWrites: aiPlan.encodeWrites(writes), aiGuards: guards };
  const encoded = Buffer.from(JSON.stringify({ pending, sha256: digest(pending) }));
  if (encoded.length > MAX_EXPANDED_BYTES) throw new Error(tr("待导入数据超过 256 MiB，请取消包含 AI 会话或减少数据；不会截断"));
  await atomicWrite(root, PENDING, await gzipAsync(encoded));
  return { id: pending.id };
}

async function readPending(root) {
  let envelope;
  try {
    envelope = JSON.parse(gunzipSync(await boundedRead(root, PENDING, MAX_EXPANDED_BYTES), {
      maxOutputLength: MAX_EXPANDED_BYTES
    }).toString('utf8'));
  } catch { throw new Error(tr("待导入数据损坏或超出大小限制，原数据未修改")); }
  const pending = envelope?.pending;
  if (!pending || ![1, 2].includes(pending.schemaVersion) || !UUID.test(pending.id)
    || envelope.sha256 !== digest(pending)) throw new Error(tr("待导入数据校验失败，原数据未修改"));
  const fields = pending.schemaVersion === 1 ? ['schemaVersion', 'id', 'payload', 'previousPreferences'] : ['schemaVersion', 'id', 'payload', 'previousPreferences', 'aiWrites', 'aiGuards'];
  if (Object.keys(pending).sort().join(',') !== fields.sort().join(',')) throw new Error(tr("待导入记录包含未知字段，原数据未修改"));
  const aiWrites = pending.schemaVersion === 2 ? aiPlan.decodeWrites(pending.aiWrites) : [];
  return { schemaVersion: pending.schemaVersion, id: pending.id, payload: validatePayload(pending.payload).payload,
    previousPreferences: originalPreferences(pending.previousPreferences), aiWrites,
    aiGuards: pending.schemaVersion === 2 ? aiPlan.normalizeGuards(pending.aiGuards, aiWrites) : [] };
}

function bootstrap(journal, status, error) {
  const rolledBack = status === 'rolled-back' || status === 'failed';
  return {
    id: journal.id, status,
    requiresAck: Boolean(journal.id),
    preferences: rolledBack ? journal.previousPreferences : journal.preferences,
    previousPreferences: journal.previousPreferences,
    removePreferenceKeys: rolledBack
      ? Object.keys(journal.preferences).filter(key => !Object.hasOwn(journal.previousPreferences, key)) : [],
    recoveryPath: journal.recoveryPath || null,
    ...(error ? { error: error.message || String(error) } : {})
  };
}

async function readJournal(root) {
  const journal = JSON.parse((await boundedRead(root, JOURNAL, MAX_JOURNAL_BYTES)).toString('utf8'));
  if (!journal || ![1, 2].includes(journal.schemaVersion) || !UUID.test(journal.id)
    || !['prepared', 'applied', 'rolled-back', 'committed'].includes(journal.phase) || !Array.isArray(journal.entries)
    || journal.entries.length > (journal.schemaVersion === 1 ? 2000 : 2000 + aiPlan.MAX_AI_FILES)) throw new Error(tr("导入恢复记录损坏，请保留恢复目录并联系支持"));
  const names = new Set();
  for (const [index, entry] of journal.entries.entries()) {
    const allowed = journal.schemaVersion === 1 ? policy.isAllowedFile(entry?.name)
      : entry?.kind === 'legacy' ? policy.isAllowedFile(entry.name) : entry?.kind === 'ai' && aiPlan.fileLimit(entry.name);
    if (!entry || !allowed || names.has(entry.name.toLowerCase())
      || typeof entry.existed !== 'boolean' || entry.backup !== `${String(index).padStart(4, '0')}.bin`
      || (entry.existed && !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error(tr("导入恢复记录路径无效"));
    if (journal.schemaVersion === 2 && (!/^[a-f0-9]{64}$/.test(entry.afterHash) || entry.beforeHash !== (entry.existed ? entry.sha256 : null))) throw new Error(tr("导入恢复记录校验值无效"));
    names.add(entry.name.toLowerCase());
  }
  journal.preferences = policy.normalizePreferences(journal.preferences);
  journal.previousPreferences = originalPreferences(journal.previousPreferences);
  if (journal.schemaVersion === 2) journal.aiGuards = aiPlan.normalizeGuards(journal.aiGuards);
  journal.recoveryPath = path.join(root, RECOVERY, journal.id);
  return journal;
}

function bytesDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function prepareJournal(root, pending) {
  await checkAiState(root, pending.aiWrites, pending.aiGuards);
  const entries = []; const writes = [];
  let totalBytes = 0;
  let afterBytes = 0;
  const planned = [...pending.payload.files.map(file => ({ ...file, kind: 'legacy' })), ...pending.aiWrites.map(file => ({ ...file, kind: 'ai' }))];
  for (const [index, file] of planned.entries()) {
    const entry = { name: file.name, kind: file.kind, existed: await exists(root, file.name), backup: `${String(index).padStart(4, '0')}.bin` };
    let original = null;
    if (entry.existed) {
      if ((await fs.promises.lstat(await safePath(root, file.name))).nlink !== 1) throw new Error(tr("迁移目标包含硬链接，已停止操作"));
      original = await boundedRead(root, file.name, file.kind === 'ai' ? aiPlan.fileLimit(file.name) : MAX_FILE_BYTES);
      totalBytes += original.length;
      if (totalBytes > MAX_EXPANDED_BYTES) throw new Error(tr("当前数据恢复副本超过 256 MB，未修改数据"));
      entry.sha256 = bytesDigest(original);
      await atomicWrite(root, `${RECOVERY}/${pending.id}/${entry.backup}`, original);
    }
    entry.beforeHash = entry.existed ? entry.sha256 : null;
    if (file.kind === 'ai' && entry.beforeHash !== file.expectedHash) throw new Error(tr("AI 数据在准备恢复记录时已变化，导入已停止"));
    let bytes = file.bytes;
    if (file.kind === 'legacy') {
      let data = file.data;
      if (file.name === 'settings.json' && original) {
        const current = JSON.parse(original.toString('utf8'));
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(tr("当前偏好设置格式无效，已取消导入"));
        data = { ...current, ...data };
      }
      bytes = Buffer.from(JSON.stringify(data, null, 2));
    }
    if (bytes.length > (file.kind === 'ai' ? aiPlan.fileLimit(file.name) : MAX_FILE_BYTES)) throw new Error(tr("导入后的单个文件超过容量限制，未截断"));
    afterBytes += bytes.length; if (afterBytes > MAX_EXPANDED_BYTES) throw new Error(tr("导入后的数据超过 256 MiB，未截断"));
    entry.afterHash = bytesDigest(bytes); writes.push({ name: file.name, bytes, beforeHash: entry.beforeHash, afterHash: entry.afterHash });
    entries.push(entry);
  }
  const journal = {
    schemaVersion: 2, id: pending.id, phase: 'prepared', entries, aiGuards: pending.aiGuards,
    preferences: pending.payload.preferences, previousPreferences: pending.previousPreferences,
    recoveryPath: path.join(root, RECOVERY, pending.id)
  };
  // Keep this independent copy with the exact original byte files even after successful completion.
  await atomicWrite(root, `${RECOVERY}/${pending.id}/recovery.json`, JSON.stringify(journal));
  await atomicWrite(root, JOURNAL, JSON.stringify(journal));
  return { journal, writes };
}

async function rollback(root, journal) {
  // Verify every backup before changing any live target, so corrupt recovery cannot partly restore data.
  let totalBytes = 0;
  for (const entry of journal.entries) {
    await safePath(root, entry.name);
    if (journal.schemaVersion === 2) {
      const current = await currentHash(root, entry.name, entry.kind === 'ai' ? aiPlan.fileLimit(entry.name) : MAX_FILE_BYTES);
      if (current !== entry.beforeHash && current !== entry.afterHash) throw new Error(tr("导入目标出现外部变化，已停止整体恢复，不会覆盖后续修改"));
    }
    if (!entry.existed) continue;
    const bytes = await boundedRead(root, `${RECOVERY}/${journal.id}/${entry.backup}`);
    totalBytes += bytes.length; if (totalBytes > MAX_EXPANDED_BYTES) throw new Error(tr("恢复副本总计超过 256 MiB，已停止整体恢复"));
    if (bytesDigest(bytes) !== entry.sha256) throw new Error(tr("恢复副本校验失败，已停止恢复"));
  }
  for (const entry of journal.entries) {
    let expectedHash;
    if (journal.schemaVersion === 2) {
      const current = await currentHash(root, entry.name, entry.kind === 'ai' ? aiPlan.fileLimit(entry.name) : MAX_FILE_BYTES);
      if (current !== entry.beforeHash && current !== entry.afterHash) throw new Error(tr("导入目标在恢复过程中出现外部变化，已停止恢复"));
      expectedHash = current;
    }
    if (entry.existed) {
      await atomicWrite(root, entry.name, await boundedRead(root, `${RECOVERY}/${journal.id}/${entry.backup}`), expectedHash);
    } else await removeFile(root, entry.name, expectedHash);
  }
  // Keep the old renderer preferences durable until that renderer acknowledges their restoration.
  journal.phase = 'rolled-back';
  await atomicWrite(root, JOURNAL, JSON.stringify(journal));
  await removeFile(root, PENDING);
  return bootstrap(journal, 'rolled-back');
}

async function applyPendingImport(userData) {
  const root = await safeRoot(userData);
  if (await exists(root, JOURNAL)) {
    const journal = await readJournal(root);
    if (journal.phase === 'committed') {
      await removeFile(root, PENDING);
      await removeFile(root, JOURNAL);
      return null;
    }
    if (journal.phase === 'rolled-back') return bootstrap(journal, 'rolled-back');
    return rollback(root, journal);
  }
  if (!await exists(root, PENDING)) return null;
  let pending;
  let journal;
  try {
    pending = await readPending(root);
    const prepared = await prepareJournal(root, pending); journal = prepared.journal;
    // All preview-source leases are checked immediately before the first live write.
    await checkAiState(root, pending.aiWrites, pending.aiGuards);
    for (const file of prepared.writes) {
      if (await currentHash(root, file.name, aiPlan.fileLimit(file.name) || MAX_FILE_BYTES) !== file.beforeHash) throw new Error(tr("导入目标在写入前已发生变化，已停止导入"));
      await atomicWrite(root, file.name, file.bytes, file.beforeHash);
    }
    await checkAiState(root, pending.aiWrites, pending.aiGuards, { after: true });
    for (const file of prepared.writes) if (await currentHash(root, file.name, aiPlan.fileLimit(file.name) || MAX_FILE_BYTES) !== file.afterHash) throw new Error(tr("导入目标在写入后已发生外部变化，已停止导入"));
    journal.phase = 'applied';
    await atomicWrite(root, JOURNAL, JSON.stringify(journal));
    await removeFile(root, PENDING);
    return bootstrap(journal, 'applied');
  } catch (error) {
    if (journal) {
      const result = await rollback(root, journal);
      return { ...result, error: error.message };
    }
    await removeFile(root, PENDING);
    if (pending) {
      journal = { schemaVersion: 1, id: pending.id, phase: 'rolled-back', entries: [],
        preferences: pending.payload.preferences, previousPreferences: pending.previousPreferences,
        recoveryPath: path.join(root, RECOVERY, pending.id) };
      await atomicWrite(root, JOURNAL, JSON.stringify(journal));
      return bootstrap(journal, 'failed', error);
    }
    return bootstrap({ id: pending?.id || null, preferences: pending?.payload.preferences || {},
      previousPreferences: pending?.previousPreferences || {} }, 'failed', error);
  }
}

async function rollbackStartupImport(userData, id) {
  const root = await safeRoot(userData);
  const journal = await readJournal(root);
  if (journal.id !== id || journal.phase === 'committed') throw new Error(tr("导入恢复请求已失效"));
  return rollback(root, journal);
}

async function finalizeStartupImport(userData, id) {
  const root = await safeRoot(userData);
  const journal = await readJournal(root);
  if (journal.id !== id || !['applied', 'rolled-back'].includes(journal.phase)) throw new Error(tr("导入完成请求已失效"));
  journal.phase = 'committed';
  await atomicWrite(root, JOURNAL, JSON.stringify(journal));
  await removeFile(root, PENDING);
  await removeFile(root, JOURNAL);
  return { id, status: 'completed', recoveryPath: journal.recoveryPath };
}

module.exports = {
  createArchive, readArchive, stageImport, applyPendingImport, rollbackStartupImport,
  finalizeStartupImport, hasPendingImport
};
