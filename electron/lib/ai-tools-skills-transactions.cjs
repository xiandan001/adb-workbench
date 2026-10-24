const { tr } = require('./localization.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, assertSafeParents } = require('./ai-tools-file-safety.cjs');
const { scanTree, validateTree, writeTree, removeOwnedTree, SLUG } = require('./ai-tools-skills-tree.cjs');
const { UUID, HASH } = require('./ai-tools-skills-store.cjs');

function createSkillsTransactions({ store, resolveTarget, filesystem: io, now }) {
  const ownerKey = value => `${value.toolId}:${value.name}`;
  const sameOwner = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  function pending() {
    const saved = store.readObject('journal'); const item = saved.value;
    if (!item) return null;
    const target = resolveTarget(item.toolId, item.name);
    const temporaryParent = path.dirname(path.dirname(target));
    if (!UUID.test(item.id) || !UUID.test(item.backupId) || item.target !== target || item.stage !== path.join(temporaryParent, `.awb-stage-${item.id}`) || item.retired !== path.join(temporaryParent, `.awb-retired-${item.id}`)
      || ![item.beforeHash, item.afterHash].every(hash => hash === null || HASH.test(hash)) || !Array.isArray(item.cleanup) || item.cleanup.length > 8) throw fail('AI_TOOLS_SKILL_RECOVERY', tr("技能操作记录无效，已停止修改，请保留数据后检查"));
    for (const row of item.cleanup) if (path.dirname(row.path) !== temporaryParent || !/^\.awb-(?:stage|retired)-[a-f0-9-]{36}$/.test(path.basename(row.path)) || !HASH.test(row.hash)) throw fail('AI_TOOLS_SKILL_RECOVERY', tr("技能临时目录记录无效，未清理"));
    return { ...item, journalHash: saved.hash };
  }
  function readBackup(id) {
    const item = store.readObject('backup', id).value;
    if (!item || item.version !== 1 || item.id !== id || !SLUG.test(item.name) || !UUID.test(item.skillId) || item.targetPath !== resolveTarget(item.toolId, item.name) || !(item.afterHash === null || HASH.test(item.afterHash))) throw fail('AI_TOOLS_SKILL_BACKUP', tr("技能备份不存在或目标不匹配"));
    validateTree(item.before);
    for (const owner of [item.beforeOwner, item.afterOwner]) if (owner && (owner.toolId !== item.toolId || owner.name !== item.name || !UUID.test(owner.skillId) || !HASH.test(owner.hash))) throw fail('AI_TOOLS_SKILL_BACKUP', tr("技能备份归属信息无效"));
    return item;
  }
  function updateOwnership(state, operation) {
    const key = ownerKey(operation);
    state.installations = state.installations.filter(row => ownerKey(row) !== key);
    if (operation.afterOwner) state.installations.push(operation.afterOwner);
  }
  function check(operation) {
    store.unchanged();
    if (operation.revision !== store.revision()) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能库在预览后已变化，请重新预览"));
    const current = scanTree(operation.targetPath, io);
    if ((current?.hash || null) !== (operation.before?.hash || null)) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能目标目录已发生外部变化，未修改"));
    const owner = store.load().installations.find(row => ownerKey(row) === ownerKey(operation));
    if (!sameOwner(owner, operation.beforeOwner)) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能安装归属已变化，请重新预览"));
    const journal = pending();
    if (journal && operation.recoveryHash !== journal.journalHash || !journal && operation.recoveryHash) throw fail('AI_TOOLS_SKILL_RECOVERY', tr("有未结束的技能操作，请先从配置备份恢复"));
    return journal;
  }
  function execute(operation) {
    store.requireEncryption(); const previousPending = check(operation); const beforeState = store.copy();
    const id = randomUUID(); const parent = path.dirname(operation.targetPath);
    // Prepare outside the tool's skills directory: a crash cannot expose a half-copied skill to its loader.
    const temporaryParent = path.dirname(parent);
    const stage = path.join(temporaryParent, `.awb-stage-${id}`); const retired = path.join(temporaryParent, `.awb-retired-${id}`);
    const backup = { version: 1, id: randomUUID(), skillId: operation.skillId, name: operation.name, toolId: operation.toolId, targetPath: operation.targetPath, operation: operation.operation, createdAt: now(), before: operation.before, beforeOwner: operation.beforeOwner || null, afterHash: operation.after?.hash || null, afterOwner: operation.afterOwner || null };
    const next = store.copy();
    next.backups.push({ id: backup.id, createdAt: backup.createdAt, skillId: backup.skillId, name: backup.name, toolId: backup.toolId, bytes: backup.before?.bytes || 0, operation: backup.operation });
    store.writeObject('backup', backup.id, backup);
    store.persist(next);
    let journalHash = previousPending?.journalHash || null; let journalCreated = false; let movedOld = false; let activated = false; let metadataWritten = false;
    const cleanup = [...(previousPending?.cleanup || [])];
    if (previousPending?.afterHash) cleanup.push({ path: previousPending.stage, hash: previousPending.afterHash });
    if (previousPending?.beforeHash) cleanup.push({ path: previousPending.retired, hash: previousPending.beforeHash });
    try {
      assertSafeParents(operation.targetPath, io); io.mkdirSync(parent, { recursive: true }); assertSafeParents(operation.targetPath, io);
      if (operation.after) writeTree(stage, operation.after, io);
      const current = scanTree(operation.targetPath, io);
      if ((current?.hash || null) !== (operation.before?.hash || null)) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能目录在准备时发生变化，未替换"));
      const journal = { version: 1, id, backupId: backup.id, target: operation.targetPath, toolId: operation.toolId, name: operation.name, stage, retired, beforeHash: operation.before?.hash || null, afterHash: operation.after?.hash || null, cleanup };
      journalHash = store.writeObject('journal', undefined, journal, journalHash); journalCreated = true;
      if (operation.before) { io.renameSync(operation.targetPath, retired); movedOld = true; }
      if (operation.after) { io.renameSync(stage, operation.targetPath); activated = true; }
      if ((scanTree(operation.targetPath, io)?.hash || null) !== (operation.after?.hash || null)) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能安装后校验失败"));
      const committed = store.copy(); updateOwnership(committed, operation); store.persist(committed); metadataWritten = true;
      if (movedOld) removeOwnedTree(retired, operation.before.hash, io);
      for (const item of cleanup) removeOwnedTree(item.path, item.hash, io);
      store.writeObject('journal', undefined, null, journalHash);
      return { backupId: backup.id, operation: operation.operation, targetPath: operation.targetPath, skillId: operation.skillId, toolId: operation.toolId };
    } catch (error) {
      let restored = !metadataWritten;
      // Once metadata committed, retain the journal and exact backup for explicit recovery.
      if (!metadataWritten) {
        try {
          if (activated) { removeOwnedTree(operation.targetPath, operation.after.hash, io); activated = false; }
          if (movedOld) {
            if (scanTree(operation.targetPath, io) !== null || scanTree(retired, io)?.hash !== operation.before.hash) throw new Error('External change');
            io.renameSync(retired, operation.targetPath); movedOld = false;
          }
          if (operation.after) removeOwnedTree(stage, operation.after.hash, io);
          if (journalCreated && !previousPending) store.writeObject('journal', undefined, null, journalHash);
          else if (journalCreated && previousPending) {
            const old = { ...previousPending }; delete old.journalHash;
            store.writeObject('journal', undefined, old, journalHash);
          }
        } catch { restored = false; }
      }
      // beforeState is only an ownership reference, never a wholesale rollback over newer library edits.
      if (restored && !sameOwner(beforeState.installations.find(row => ownerKey(row) === ownerKey(operation)), operation.beforeOwner)) restored = false;
      const result = fail(error.code === 'AI_TOOLS_SKILL_CHANGED' ? error.code : 'AI_TOOLS_SKILL_APPLY', restored ? tr("技能操作失败，原目录已保留或恢复，备份已加密保存") : tr("技能操作未能完整结束，未删除外部变化；请从技能备份恢复后继续"));
      result.backupId = backup.id; throw result;
    }
  }
  function restoreOperation(backupId) {
    const backup = readBackup(backupId); const journal = pending(); const current = scanTree(backup.targetPath, io);
    const owner = store.load().installations.find(row => ownerKey(row) === ownerKey(backup)) || null;
    const currentHash = current?.hash || null;
    if (journal) {
      if (journal.backupId !== backupId || journal.target !== backup.targetPath || ![journal.beforeHash, journal.afterHash, null].includes(currentHash)
        || !(sameOwner(owner, backup.beforeOwner) || sameOwner(owner, backup.afterOwner))) throw fail('AI_TOOLS_SKILL_CHANGED', tr("恢复目标存在外部变化或不是当前待恢复操作，未修改"));
      if (currentHash === null && journal.beforeHash && scanTree(journal.retired, io)?.hash !== journal.beforeHash) throw fail('AI_TOOLS_SKILL_RECOVERY', tr("原技能目录暂存数据不匹配，已停止自动恢复"));
    } else if (currentHash !== backup.afterHash || !sameOwner(owner, backup.afterOwner)) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能目录或归属已在外部变化，未覆盖"));
    return { operation: 'restore', skillId: backup.skillId, name: backup.name, toolId: backup.toolId, targetPath: backup.targetPath, before: current, beforeOwner: owner, after: backup.before, afterOwner: backup.beforeOwner, revision: store.revision(), recoveryHash: journal?.journalHash || null };
  }
  return { execute, pending, readBackup, restoreOperation };
}

module.exports = { createSkillsTransactions };
