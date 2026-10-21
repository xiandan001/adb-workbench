const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { gzip, gunzipSync } = require('zlib');
const { promisify } = require('util');
const policy = require('./data-migration-policy.cjs');
const {
  createArchive, readArchive, validatePayload, digest, safeRoot, safePath, boundedRead, MAX_EXPANDED_BYTES
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

async function atomicWrite(root, relative, bytes) {
  const target = await safePath(root, relative, { createParents: true });
  const tempRelative = `${relative}.${randomUUID()}.tmp`;
  const temporary = await safePath(root, tempRelative);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Recheck the destination after writing; no renderer-selected path can be renamed over.
    await safePath(root, relative);
    await fs.promises.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function removeFile(root, relative) {
  const target = await safePath(root, relative);
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

async function stageImport(userData, input, currentPreferences) {
  const root = await safeRoot(userData);
  if (await exists(root, PENDING) || await exists(root, JOURNAL)) throw new Error('已有待完成的数据导入，请先重启应用');
  const { payload } = validatePayload(input);
  const previousPreferences = originalPreferences(currentPreferences);
  const pending = { schemaVersion: 1, id: randomUUID(), payload, previousPreferences };
  const encoded = Buffer.from(JSON.stringify({ pending, sha256: digest(pending) }));
  if (encoded.length > MAX_EXPANDED_BYTES) throw new Error('待导入数据超过大小限制');
  await atomicWrite(root, PENDING, await gzipAsync(encoded));
  return { id: pending.id };
}

async function readPending(root) {
  let envelope;
  try {
    envelope = JSON.parse(gunzipSync(await boundedRead(root, PENDING, MAX_EXPANDED_BYTES), {
      maxOutputLength: MAX_EXPANDED_BYTES
    }).toString('utf8'));
  } catch { throw new Error('待导入数据损坏或超出大小限制，原数据未修改'); }
  const pending = envelope?.pending;
  if (!pending || pending.schemaVersion !== 1 || !UUID.test(pending.id)
    || envelope.sha256 !== digest(pending)) throw new Error('待导入数据校验失败，原数据未修改');
  return { ...pending, payload: validatePayload(pending.payload).payload,
    previousPreferences: originalPreferences(pending.previousPreferences) };
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
  if (!journal || journal.schemaVersion !== 1 || !UUID.test(journal.id)
    || !['prepared', 'applied', 'rolled-back', 'committed'].includes(journal.phase) || !Array.isArray(journal.entries)
    || journal.entries.length > 2000) throw new Error('导入恢复记录损坏，请保留恢复目录并联系支持');
  const names = new Set();
  for (const [index, entry] of journal.entries.entries()) {
    if (!entry || !policy.isAllowedFile(entry.name) || names.has(entry.name.toLowerCase())
      || typeof entry.existed !== 'boolean' || entry.backup !== `${String(index).padStart(4, '0')}.bin`
      || (entry.existed && !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error('导入恢复记录路径无效');
    names.add(entry.name.toLowerCase());
  }
  journal.preferences = policy.normalizePreferences(journal.preferences);
  journal.previousPreferences = originalPreferences(journal.previousPreferences);
  journal.recoveryPath = path.join(root, RECOVERY, journal.id);
  return journal;
}

function bytesDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function prepareJournal(root, pending) {
  const entries = [];
  let totalBytes = 0;
  for (const [index, file] of pending.payload.files.entries()) {
    const entry = { name: file.name, existed: await exists(root, file.name), backup: `${String(index).padStart(4, '0')}.bin` };
    if (entry.existed) {
      const original = await boundedRead(root, file.name);
      totalBytes += original.length;
      if (totalBytes > MAX_EXPANDED_BYTES) throw new Error('当前数据恢复副本超过 256 MB，未修改数据');
      entry.sha256 = bytesDigest(original);
      await atomicWrite(root, `${RECOVERY}/${pending.id}/${entry.backup}`, original);
    }
    entries.push(entry);
  }
  const journal = {
    schemaVersion: 1, id: pending.id, phase: 'prepared', entries,
    preferences: pending.payload.preferences, previousPreferences: pending.previousPreferences,
    recoveryPath: path.join(root, RECOVERY, pending.id)
  };
  // Keep this independent copy with the exact original byte files even after successful completion.
  await atomicWrite(root, `${RECOVERY}/${pending.id}/recovery.json`, JSON.stringify(journal));
  await atomicWrite(root, JOURNAL, JSON.stringify(journal));
  return journal;
}

async function rollback(root, journal) {
  // Verify every backup before changing any live target, so corrupt recovery cannot partly restore data.
  for (const entry of journal.entries) {
    await safePath(root, entry.name);
    if (!entry.existed) continue;
    const bytes = await boundedRead(root, `${RECOVERY}/${journal.id}/${entry.backup}`);
    if (bytesDigest(bytes) !== entry.sha256) throw new Error('恢复副本校验失败，已停止恢复');
  }
  for (const entry of journal.entries) {
    if (entry.existed) {
      await atomicWrite(root, entry.name, await boundedRead(root, `${RECOVERY}/${journal.id}/${entry.backup}`));
    } else await removeFile(root, entry.name);
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
    journal = await prepareJournal(root, pending);
    for (const file of pending.payload.files) {
      let data = file.data;
      if (file.name === 'settings.json' && await exists(root, file.name)) {
        const current = JSON.parse((await boundedRead(root, file.name)).toString('utf8'));
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('当前偏好设置格式无效，已取消导入');
        data = { ...current, ...data };
      }
      await atomicWrite(root, file.name, JSON.stringify(data, null, 2));
    }
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
  if (journal.id !== id || journal.phase === 'committed') throw new Error('导入恢复请求已失效');
  return rollback(root, journal);
}

async function finalizeStartupImport(userData, id) {
  const root = await safeRoot(userData);
  const journal = await readJournal(root);
  if (journal.id !== id || !['applied', 'rolled-back'].includes(journal.phase)) throw new Error('导入完成请求已失效');
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
