const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./ai-tools-file-safety.cjs');
const { createSkillsStore, UUID } = require('./ai-tools-skills-store.cjs');
const { createSkillsTransactions } = require('./ai-tools-skills-transactions.cjs');
const { scanTree, validateTree, skillMetadata, SLUG } = require('./ai-tools-skills-tree.cjs');
const { exact, validatePortableList, prepareStateWrite, UUID: PORTABLE_UUID, HASH } = require('./ai-tools-migration-common.cjs');

const TTL = 5 * 60 * 1000;
function createAiToolsSkills({ directory, home, paths = {}, canEncrypt, encrypt, decrypt, now = Date.now, filesystem: io = fs } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0')) throw fail('AI_TOOLS_SKILL_PATH', '技能目标用户目录无效');
  const roots = {
    claude: path.join(home, '.claude', 'skills'), codex: path.join(home, '.codex', 'skills'),
    gemini: path.join(home, '.gemini', 'skills'), opencode: path.join(home, '.config', 'opencode', 'skills'),
  };
  for (const [toolId, value] of Object.entries(paths)) {
    if (!Object.hasOwn(roots, toolId) || typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail('AI_TOOLS_SKILL_PATH', '技能目标路径无效');
    roots[toolId] = path.resolve(value);
  }
  const store = createSkillsStore({ directory, canEncrypt, encrypt, decrypt, filesystem: io });
  const tokens = new Map(); let disposed = false;
  const alive = () => { if (disposed) throw fail('AI_TOOLS_SKILL_CLOSED', '技能工作区已关闭'); };
  function resolveTarget(toolId, name) {
    if (!Object.hasOwn(roots, toolId) || typeof name !== 'string' || !SLUG.test(name)) throw fail('AI_TOOLS_SKILL_PATH', '不支持的工具或不安全的技能名称');
    const root = path.resolve(roots[toolId]); const target = path.join(root, name);
    if (path.dirname(target) !== root || target === path.parse(target).root) throw fail('AI_TOOLS_SKILL_PATH', '技能目标超出限定子目录');
    return target;
  }
  const transactions = createSkillsTransactions({ store, resolveTarget, filesystem: io, now });
  function ensureIdle() { if (transactions.pending()) throw fail('AI_TOOLS_SKILL_RECOVERY', '有未结束的技能操作，请先从技能备份恢复'); }
  function get(id) {
    alive(); if (typeof id !== 'string' || !UUID.test(id)) throw fail('AI_TOOLS_SKILL_ID', '技能标识无效');
    const row = store.load().skills.find(item => item.id === id);
    if (!row) throw fail('AI_TOOLS_SKILL_MISSING', '技能不存在或库中已更新');
    return row;
  }
  function archive(row) {
    const saved = store.readObject('archive', row.id); const value = saved.value;
    if (!value || value.version !== 1 || value.id !== row.id || value.name !== row.name) throw fail('AI_TOOLS_SKILL_DATA', '技能内容不存在或归属无效');
    const tree = validateTree(value.tree);
    if (!tree || tree.hash !== row.hash || tree.bytes !== row.bytes || tree.fileCount !== row.fileCount) throw fail('AI_TOOLS_SKILL_DATA', '技能库内容校验失败，未应用');
    return { tree, archiveHash: saved.hash };
  }
  function list() {
    alive(); const current = store.load();
    return current.skills.map(row => ({ ...row, installations: current.installations.filter(item => item.name === row.name).map(item => ({ toolId: item.toolId, hash: item.hash, currentLibraryVersion: item.hash === row.hash })) }));
  }
  function read({ id } = {}) {
    const row = get(id); const { tree } = archive(row);
    return { id, name: row.name, content: skillMetadata(tree, row.name).content };
  }
  function importDirectory({ sourceDirectory } = {}) {
    alive(); store.requireEncryption(); ensureIdle(); store.unchanged();
    if (typeof sourceDirectory !== 'string' || !path.isAbsolute(sourceDirectory) || sourceDirectory.includes('\0')) throw fail('AI_TOOLS_SKILL_PATH', '请通过本机目录选择器选择技能目录');
    const tree = scanTree(sourceDirectory, io); const meta = skillMetadata(tree, sourceDirectory);
    if (scanTree(sourceDirectory, io)?.hash !== tree.hash) throw fail('AI_TOOLS_SKILL_CHANGED', '技能源目录在导入时发生变化，请重新选择');
    const current = store.copy(); const existing = current.skills.find(row => row.name === meta.name);
    if (existing?.hash === tree.hash) return { ...existing, unchanged: true };
    const row = { id: randomUUID(), name: meta.name, description: meta.description, fileCount: tree.fileCount, bytes: tree.bytes, hash: tree.hash, createdAt: now() };
    const next = { ...current, skills: [...current.skills.filter(item => item.name !== meta.name), row] };
    const savedHash = store.writeObject('archive', row.id, { version: 1, id: row.id, name: row.name, tree });
    try { store.persist(next); }
    catch (error) { try { store.writeObject('archive', row.id, null, savedHash); } catch { /* Preserve an owned encrypted orphan if it changed. */ } throw error; }
    // Old immutable archives are not externally installed files. Keep until no pending action can reference them.
    if (existing) {
      try { const previous = store.readObject('archive', existing.id); if (previous.hash) store.writeObject('archive', existing.id, null, previous.hash); }
      catch { /* New index is committed; preserve a damaged old encrypted archive rather than deleting unknown data. */ }
    }
    return { ...row };
  }
  function issue(operation) {
    for (const [token, value] of tokens) if (value.expiresAt <= now()) tokens.delete(token);
    while (tokens.size >= 2) tokens.delete(tokens.keys().next().value);
    const token = randomUUID(); const expiresAt = now() + TTL;
    tokens.set(token, { ...operation, expiresAt });
    const before = operation.before?.entries || []; const after = operation.after?.entries || [];
    const names = [...new Set([...before, ...after].map(row => row.path))].sort();
    const changes = names.flatMap(name => {
      const old = before.find(row => row.path === name); const next = after.find(row => row.path === name);
      if (JSON.stringify(old) === JSON.stringify(next)) return [];
      return [{ path: name, action: !old ? 'add' : !next ? 'remove' : 'replace', bytes: next?.type === 'file' ? Buffer.byteLength(next.data, 'base64') : 0 }];
    });
    return { token, expiresAt, operation: operation.operation, toolId: operation.toolId, skillId: operation.skillId, name: operation.name, targetPath: operation.targetPath,
      files: names, changes, warnings: ['技能内容属于用户选择的文件，不会由本软件执行或联网下载。', '安装会将所列文件解密复制到目标工具的技能子目录，目标工具可能在后续使用时读取或执行其中脚本，请先审查内容。', '库和恢复备份均系统加密；目标目录若被外部修改，本次操作会停止。'] };
  }
  function previewInstall({ skillId, toolId } = {}) {
    alive(); ensureIdle(); const row = get(skillId); const { tree, archiveHash } = archive(row);
    const targetPath = resolveTarget(toolId, row.name); const before = scanTree(targetPath, io);
    const owner = store.load().installations.find(item => item.toolId === toolId && item.name === row.name) || null;
    if (before && !owner) throw fail('AI_TOOLS_SKILL_OWNER', '目标已有同名技能，不能证明属于本应用，未接管');
    if (before && owner.hash !== before.hash) throw fail('AI_TOOLS_SKILL_CHANGED', '目标技能已有外部变化，未覆盖');
    return issue({ operation: 'install', skillId, name: row.name, toolId, targetPath, before, beforeOwner: owner, after: tree, afterOwner: { skillId, toolId, name: row.name, hash: tree.hash }, revision: store.revision(), archiveHash });
  }
  function remove({ id } = {}) {
    alive(); ensureIdle(); store.requireEncryption(); const row = get(id); const next = store.copy();
    const owned = next.installations.filter(item => item.name === row.name);
    for (const item of owned) if (scanTree(resolveTarget(item.toolId, item.name), io)) throw fail('AI_TOOLS_SKILL_INSTALLED', '此技能仍安装在外部工具中，请先卸载后再删除库记录');
    const saved = store.readObject('archive', id);
    next.skills = next.skills.filter(item => item.id !== id);
    next.installations = next.installations.filter(item => item.name !== row.name);
    store.persist(next);
    let archiveRetained = false;
    try { if (saved.hash) store.writeObject('archive', id, null, saved.hash); }
    catch { archiveRetained = true; }
    return { id, archiveRetained };
  }
  function previewUninstall({ skillId, toolId } = {}) {
    alive(); ensureIdle(); const row = get(skillId); const targetPath = resolveTarget(toolId, row.name);
    const owner = store.load().installations.find(item => item.toolId === toolId && item.name === row.name) || null;
    if (!owner) throw fail('AI_TOOLS_SKILL_OWNER', '此技能没有本应用的安装记录，不会删除');
    const before = scanTree(targetPath, io);
    if (!before || before.hash !== owner.hash) throw fail('AI_TOOLS_SKILL_CHANGED', '目标技能已被移除或有外部变化，未删除');
    return issue({ operation: 'uninstall', skillId, name: row.name, toolId, targetPath, before, beforeOwner: owner, after: null, afterOwner: null, revision: store.revision() });
  }
  function previewRestore({ backupId } = {}) { alive(); return issue(transactions.restoreOperation(backupId)); }
  function listBackups() {
    alive(); const pending = transactions.pending();
    return [...store.load().backups].reverse().map(row => ({ ...row, targetPath: resolveTarget(row.toolId, row.name), recoveryPending: pending?.backupId === row.id }));
  }
  function apply({ token } = {}) {
    alive(); const operation = tokens.get(token); tokens.delete(token);
    if (!operation || operation.expiresAt <= now()) throw fail('AI_TOOLS_SKILL_PREVIEW', '技能预览已过期或失效，请重新预览');
    if (operation.archiveHash && archive(get(operation.skillId)).archiveHash !== operation.archiveHash) throw fail('AI_TOOLS_SKILL_CHANGED', '技能库内容在预览后已变化，未应用');
    return transactions.execute(operation);
  }
  function getMigrationGuards() {
    alive(); const current = store.load();
    return [{ path: path.join(directory, 'index.v1.json'), expectedHash: store.revision(), limit: 2 * 1024 * 1024 }, ...current.skills.map(row => ({ path: path.join(directory, 'archives', `${row.id}.json`), expectedHash: archive(row).archiveHash, limit: 48 * 1024 * 1024 }))];
  }
  function exportPortable() {
    alive(); store.requireEncryption(); ensureIdle();
    return { version: 1, skills: store.load().skills.map(row => ({ id: row.id, name: row.name, description: row.description, fileCount: row.fileCount, bytes: row.bytes, hash: row.hash, createdAt: row.createdAt, tree: structuredClone(archive(row).tree) })) };
  }
  function preparePortableImport(payload) {
    alive(); store.requireEncryption(); ensureIdle(); store.unchanged();
    const ids = new Set(); const names = new Set();
    const incoming = validatePortableList(payload, 'skills', 50, '技能迁移').map(row => {
      exact(row, ['id', 'name', 'description', 'fileCount', 'bytes', 'hash', 'createdAt', 'tree'], '技能条目');
      if (!PORTABLE_UUID.test(row.id) || ids.has(row.id) || !SLUG.test(row.name) || names.has(row.name) || typeof row.description !== 'string' || row.description.length > 512 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !HASH.test(row.hash)) throw fail('AI_TOOLS_MIGRATION_FORMAT', '技能标识、名称或元数据无效');
      ids.add(row.id); names.add(row.name);
      exact(row.tree, ['entries', 'bytes', 'fileCount', 'hash'], '技能文件树');
      if (!Array.isArray(row.tree.entries)) throw fail('AI_TOOLS_MIGRATION_FORMAT', '技能文件列表无效');
      for (const entry of row.tree.entries) exact(entry, entry.type === 'file' ? ['path', 'type', 'mode', 'data'] : ['path', 'type'], '技能文件条目');
      const tree = validateTree(row.tree); const meta = skillMetadata(tree, row.name);
      if (tree.hash !== row.hash || tree.bytes !== row.bytes || tree.fileCount !== row.fileCount || meta.name !== row.name || meta.description !== row.description) throw fail('AI_TOOLS_MIGRATION_FORMAT', '技能内容与元数据不匹配，未导入');
      return structuredClone(row);
    });
    const next = store.copy(); const targets = []; const guards = getMigrationGuards(); let added = 0; let skipped = 0;
    for (const row of incoming) {
      if (next.skills.some(current => current.id === row.id || current.name === row.name)) { skipped++; continue; }
      const existing = store.readObject('archive', row.id); const archiveFile = path.join(directory, 'archives', `${row.id}.json`);
      guards.push({ path: archiveFile, expectedHash: existing.hash, limit: 48 * 1024 * 1024 });
      if (existing.value) {
        if (existing.value.version !== 1 || existing.value.id !== row.id || existing.value.name !== row.name || validateTree(existing.value.tree)?.hash !== row.hash) throw fail('AI_TOOLS_SKILL_CHANGED', '目标技能库存在未登记且不匹配的同 ID 文件，未覆盖');
      } else targets.push(prepareStateWrite(archiveFile, { version: 1, id: row.id, name: row.name, tree: row.tree }, null, { canEncrypt, encrypt, decrypt }, 48 * 1024 * 1024));
      const metadata = { ...row }; delete metadata.tree; next.skills.push(metadata); added++;
    }
    if (next.skills.length > 50 || next.skills.reduce((sum, row) => sum + row.bytes, 0) > 64 * 1024 * 1024) throw fail('AI_TOOLS_SKILL_LIMIT', '合并后技能库超过 50 项或 64 MiB，未导入或截断');
    targets.push(prepareStateWrite(path.join(directory, 'index.v1.json'), next, store.revision(), { canEncrypt, encrypt, decrypt }, 2 * 1024 * 1024));
    return { targets, guards, counts: { added, skipped } };
  }
  return { list, read, importDirectory, remove, previewInstall, previewUninstall, apply, listBackups, previewRestore, exportPortable, preparePortableImport, getMigrationGuards,
    dispose() { disposed = true; tokens.clear(); } };
}

module.exports = { createAiToolsSkills };
