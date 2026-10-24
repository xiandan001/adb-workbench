const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { checksum, readSafe, checkHash, atomicReplace, decodeConfig, assertSafeParents, fail } = require('./ai-tools-file-safety.cjs');
const { ID, plain, clone, keyFor, validateId, normalizeMcp, normalizePrompt, publicMcp, publicPrompt } = require('./ai-tools-resources-policy.cjs');
const { createResourceStore } = require('./ai-tools-resources-store.cjs');
const { projectMcp, projectPrompt } = require('./ai-tools-resources-adapters.cjs');
const { validateArguments } = require('./ai-tools-policy.cjs');

const TTL = 5 * 60 * 1000;
const BACKUP_LIMIT = 4 * 1024 * 1024;
const MCP_TOOLS = ['claude', 'codex', 'gemini', 'opencode'];
const NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', grokbuild: 'Grok Build', opencode: 'OpenCode', openclaw: 'OpenClaw', hermes: 'Hermes', pi: 'Pi', mcode: 'MCode', kimi: 'Kimi Code', agy: 'Antigravity CLI' };
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const fingerprint = value => checksum(Buffer.from(JSON.stringify(value)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createAiToolsResources({ directory, home, paths = {}, backupDirectory, canEncrypt, encrypt, decrypt, now = Date.now, filesystem: io = fs } = {}) {
  if (![directory, home, backupDirectory].every(validPath) || !plain(paths)) throw fail('AI_TOOLS_RESOURCE_PATH', tr("资源目录无效"));
  const promptDefaults = {
    claude: ['.claude', 'CLAUDE.md'], codex: ['.codex', 'AGENTS.md'], gemini: ['.gemini', 'GEMINI.md'], grokbuild: ['.grok', 'AGENTS.md'],
    opencode: ['.config', 'opencode', 'AGENTS.md'], openclaw: ['.openclaw', 'AGENTS.md'],
    hermes: process.platform === 'win32' ? ['AppData', 'Local', 'hermes', 'SOUL.md'] : ['.hermes', 'SOUL.md'],
    pi: ['.pi', 'agent', 'AGENTS.md'], mcode: ['.minimax', 'AGENTS.md'], kimi: ['.kimi-code', 'AGENTS.md'], agy: ['.gemini', 'config', 'AGENTS.md'],
  };
  const mcpDefaults = { claude: ['.claude.json'], codex: ['.codex', 'config.toml'], gemini: ['.gemini', 'settings.json'], opencode: ['.config', 'opencode', 'opencode.json'] };
  const fixed = {};
  for (const [kind, values] of [['mcp', mcpDefaults], ['prompt', promptDefaults]]) for (const [tool, parts] of Object.entries(values)) fixed[`${tool}.${kind}`] = path.join(home, ...parts);
  for (const [key, value] of Object.entries(paths)) {
    if (!Object.hasOwn(fixed, key) || !validPath(value) || /^(?:auth\.json|oauth_creds\.json|credentials(?:\.json)?|accounts?\.json|\.credentials\.json)$/i.test(path.basename(value))) throw fail('AI_TOOLS_RESOURCE_PATH', tr("资源目标路径无效，不能指向登录凭据文件"));
    fixed[key] = path.resolve(value);
  }
  const vault = createResourceStore({ directory, canEncrypt, encrypt, decrypt, filesystem: io });
  const tokens = new Map(); let disposed = false;
  function active() { if (disposed) throw fail('AI_TOOLS_RESOURCE_DISPOSED', tr("资源管理已关闭")); }
  function state() { active(); return vault.load(); }
  function toolPath(toolId, kind, resolve = true) {
    if (!Object.hasOwn(fixed, `${toolId}.${kind}`)) throw fail('AI_TOOLS_RESOURCE_UNSUPPORTED', tr("该工具的资源适配尚未完成，不会修改其数据"));
    if (kind === 'mcp' && toolId === 'opencode' && !paths['opencode.mcp'] && resolve) {
      const alternate = path.join(home, '.config', 'opencode', 'opencode.jsonc');
      if (readSafe(alternate, io).exists) return alternate;
    }
    return fixed[`${toolId}.${kind}`];
  }
  function get(kind, id) {
    validateId(id); const found = state()[kind === 'mcp' ? 'mcpServers' : 'prompts'].find(row => row.id === id);
    if (!found) throw fail('AI_TOOLS_RESOURCE_MISSING', tr("资源不存在或已删除"));
    return found;
  }
  function save(kind, input) {
    input = validateArguments(input);
    const current = state(); const existing = input?.id ? get(kind, input.id) : null;
    const row = kind === 'mcp' ? normalizeMcp(input, existing) : normalizePrompt(input); row.id ||= randomUUID();
    const field = kind === 'mcp' ? 'mcpServers' : 'prompts';
    if (!existing && current[field].length >= 256) throw fail('AI_TOOLS_RESOURCE_LIMIT', tr("每类资源最多保存 256 条"));
    const next = clone(current); next[field] = existing ? next[field].map(value => value.id === row.id ? row : value) : [...next[field], row];
    vault.persist(next); return kind === 'mcp' ? publicMcp(row, next.applications) : publicPrompt(row, next.applications);
  }
  function remove(kind, { id } = {}) {
    get(kind, id); const current = state();
    if (current.applications.some(row => row.resourceId === id)) throw fail('AI_TOOLS_RESOURCE_IN_USE', tr("资源仍应用于外部工具，请先预览并停用对应工具，再删除库记录"));
    const next = clone(current); const field = kind === 'mcp' ? 'mcpServers' : 'prompts'; next[field] = next[field].filter(row => row.id !== id); vault.persist(next); return { id };
  }
  function snapshot() {
    const current = state();
    return { mcpServers: current.mcpServers.map(row => publicMcp(row, current.applications)), prompts: current.prompts.map(row => publicPrompt(row, current.applications)),
      tools: Object.entries(NAMES).map(([id, name]) => ({ id, name, mcpSupported: MCP_TOOLS.includes(id), promptSupported: true, ...(MCP_TOOLS.includes(id) ? { mcpPath: toolPath(id, 'mcp', false) } : {}), promptPath: toolPath(id, 'prompt', false) })), ...vault.info() };
  }
  function slot(kind, toolId, resourceId, rows = state().applications) { return rows.find(row => row.kind === kind && row.toolId === toolId && (kind === 'prompt' || row.resourceId === resourceId)) || null; }
  function replaceApplication(rows, before, after) {
    const result = rows.filter(row => !(row.kind === (before || after).kind && row.toolId === (before || after).toolId && ((before || after).kind === 'prompt' || row.resourceId === (before || after).resourceId)));
    if (after) result.push(after); return result;
  }
  function issue(operation) {
    for (const [key, item] of tokens) if (item.expiresAt < now()) tokens.delete(key);
    if (tokens.size >= 16) tokens.delete(tokens.keys().next().value);
    const token = randomUUID(); const expiresAt = now() + TTL;
    tokens.set(token, { ...operation, expiresAt, stateHash: fingerprint(state()) });
    const warnings = [tr("仅修改本应用管理的资源，不接管其他配置；应用前创建系统加密备份，外部修改会使本次预览失效。")];
    if (operation.kind === 'mcp') warnings.push(tr("MCP 命令不会在本应用中执行。目标工具下一次加载配置时可能启动命令或连接服务，请确认命令、参数和地址可信。环境变量及请求头将按目标工具要求明文写入配置。"));
    else if (operation.kind === 'prompt') warnings.push(tr("仅替换本应用的提示词管理块，保留文件其他内容。"));
    else warnings.push(tr("恢复精确原始字节；原先不存在的文件将恢复为不存在。"));
    return { token, expiresAt, kind: operation.kind, operation: operation.kind === 'restore' ? 'restore' : 'apply', toolId: operation.toolId, resourceId: operation.resourceId,
      files: [{ path: operation.file.path, exists: operation.file.exists, beforeHash: operation.file.hash, format: operation.format, changes: operation.changes }], targets: [operation.file.path], changes: operation.changes, warnings };
  }
  function preview(kind, { toolId, mcpId, promptId, enabled } = {}) {
    active(); const target = toolPath(toolId, kind);
    if (typeof enabled !== 'boolean') throw fail('AI_TOOLS_RESOURCE_INVALID', tr("请明确启用或停用资源"));
    const row = get(kind, kind === 'mcp' ? mcpId : promptId); const beforeApplication = slot(kind, toolId, row.id);
    if (!enabled && beforeApplication?.resourceId !== row.id) throw fail('AI_TOOLS_RESOURCE_NOT_ACTIVE', tr("该资源没有应用到此工具"));
    if (beforeApplication && path.resolve(beforeApplication.path) !== path.resolve(target)) throw fail('AI_TOOLS_RESOURCE_CONFLICT', tr("工具实际配置路径已变化，未接管新目标"));
    const file = readSafe(target, io);
    const projection = (kind === 'mcp' ? projectMcp : projectPrompt)(toolId, decodeConfig(file.bytes), row, enabled, beforeApplication?.hash || null);
    const after = Buffer.from(projection.content); const afterApplication = enabled ? { kind, toolId, resourceId: row.id, path: target, hash: projection.hash } : null;
    const changes = [{ field: kind === 'mcp' ? `MCP ${row.name} (${keyFor(row.id)})` : tr("本应用提示词管理块"), before: beforeApplication ? tr("已应用（敏感内容隐藏）") : tr("未应用"), after: enabled ? tr("启用此资源（敏感内容隐藏）") : tr("停用并移除本应用管理内容"), secret: kind === 'mcp' }];
    return issue({ kind, toolId, resourceId: row.id, file, after, afterHash: checksum(after), beforeApplication, afterApplication, format: projection.format, changes });
  }
  function backupPath(id) { validateId(id); return path.join(backupDirectory, `${id}.json`); }
  function backupIds() {
    assertSafeParents(path.join(backupDirectory, 'probe'), io); let entries;
    try { entries = io.readdirSync(backupDirectory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw fail('AI_TOOLS_BACKUP_READ', tr("无法读取资源备份目录")); }
    const ids = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && ID.test(entry.name.slice(0, -5))).map(entry => entry.name.slice(0, -5));
    if (ids.length > 100) throw fail('AI_TOOLS_BACKUP_LIMIT', tr("资源备份超过 100 条，请检查备份目录")); return ids;
  }
  function allowedTarget(toolId, kind, target) {
    if (typeof target !== 'string' || !validPath(target)) return false;
    if (path.resolve(target) === path.resolve(toolPath(toolId, kind, false))) return true;
    return kind === 'mcp' && toolId === 'opencode' && !paths['opencode.mcp'] && path.resolve(target) === path.resolve(path.join(home, '.config', 'opencode', 'opencode.jsonc'));
  }
  function readBackup(id) {
    active();
    try {
      const file = readSafe(backupPath(id), io, BACKUP_LIMIT * 2); if (!file.bytes) throw new Error('Missing');
      const value = vault.decode(file.bytes, BACKUP_LIMIT);
      if (!plain(value) || value.version !== 1 || value.id !== id || !Number.isFinite(value.createdAt) || !['mcp', 'prompt'].includes(value.resourceKind) || !allowedTarget(value.toolId, value.resourceKind, value.path) || ![null, 'string'].includes(value.before === null ? null : typeof value.before)) throw new Error('Backup');
      const original = value.before === null ? null : Buffer.from(value.before, 'base64');
      if (original && (original.length > 1024 * 1024 || original.toString('base64') !== value.before) || checksum(original) !== value.beforeHash || value.appliedHash !== null && !/^[a-f0-9]{64}$/.test(value.appliedHash)) throw new Error('Hash');
      for (const app of [value.beforeApplication, value.afterApplication]) if (app !== null && (!plain(app) || app.kind !== value.resourceKind || app.toolId !== value.toolId || app.path !== value.path || !ID.test(app.resourceId) || !/^[a-f0-9]{64}$/.test(app.hash))) throw new Error('Application');
      return value;
    } catch { throw fail('AI_TOOLS_BACKUP_READ', tr("资源备份无法读取或目标路径已变化，原备份已保留")); }
  }
  function saveBackup(operation) {
    if (!vault.encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，不能安全备份并应用资源"));
    if (backupIds().length >= 100) throw fail('AI_TOOLS_BACKUP_LIMIT', tr("资源备份达到 100 条，本次未修改文件"));
    const value = { version: 1, id: randomUUID(), createdAt: now(), resourceKind: operation.resourceKind || operation.kind, toolId: operation.toolId, resourceId: operation.resourceId,
      path: operation.file.path, before: operation.file.bytes?.toString('base64') ?? null, beforeHash: operation.file.hash, appliedHash: operation.afterHash,
      beforeApplication: operation.beforeApplication, afterApplication: operation.afterApplication };
    atomicReplace(backupPath(value.id), vault.encode(value, BACKUP_LIMIT), null, io, BACKUP_LIMIT * 2); return value;
  }
  function previewRestore({ backupId } = {}) {
    const backup = readBackup(backupId); const beforeApplication = slot(backup.resourceKind, backup.toolId, backup.resourceId);
    if (!same(beforeApplication, backup.afterApplication)) throw fail('AI_TOOLS_RESOURCE_CONFLICT', tr("资源应用状态已经变化，不能覆盖新状态"));
    if (backup.beforeApplication) get(backup.resourceKind, backup.beforeApplication.resourceId);
    const file = checkHash(backup.path, backup.appliedHash, io); const after = backup.before === null ? null : Buffer.from(backup.before, 'base64');
    return issue({ kind: 'restore', resourceKind: backup.resourceKind, toolId: backup.toolId, resourceId: backup.resourceId, file, after, afterHash: checksum(after), beforeApplication, afterApplication: backup.beforeApplication,
      format: 'original-bytes', changes: [{ field: tr("原始文件"), before: tr("当前应用版本"), after: after === null ? tr("恢复为不存在") : tr("恢复原始字节（内容隐藏）"), secret: true }] });
  }
  function apply({ token } = {}) {
    active(); const operation = tokens.get(token); tokens.delete(token);
    if (!operation || operation.expiresAt < now()) throw fail('AI_TOOLS_PREVIEW_EXPIRED', tr("资源预览已过期或失效，请重新预览"));
    if (operation.stateHash !== fingerprint(state())) throw fail('AI_TOOLS_RESOURCE_CHANGED', tr("资源库或应用状态已变化，请重新预览"));
    vault.unchanged(); checkHash(operation.file.path, operation.file.hash, io);
    const backup = saveBackup(operation); let written = false;
    try {
      atomicReplace(operation.file.path, operation.after, operation.file.hash, io); written = true;
      const next = vault.copy(); next.applications = replaceApplication(next.applications, operation.beforeApplication, operation.afterApplication); vault.persist(next);
    } catch {
      let restored = !written;
      if (written) { try { atomicReplace(operation.file.path, operation.file.bytes, operation.afterHash, io); restored = true; } catch { /* Preserve external changes and encrypted recovery backup. */ } }
      const error = fail('AI_TOOLS_RESOURCE_APPLY_FAILED', restored ? tr("资源应用失败，已保留原始配置和加密备份") : tr("资源应用失败且文件已在外部变化，未覆盖外部修改，请检查加密备份")); error.backupId = backup.id; throw error;
    }
    return { backupId: backup.id, toolId: operation.toolId, resourceId: operation.resourceId, files: [operation.file.path], operation: operation.kind === 'restore' ? 'restore' : 'apply' };
  }
  function listBackups() { active(); return backupIds().map(id => { const row = readBackup(id); return { id, createdAt: row.createdAt, toolId: row.toolId, resourceId: row.resourceId, kind: row.resourceKind, files: [{ path: row.path }] }; }).sort((a, b) => b.createdAt - a.createdAt); }
  return { snapshot, saveMcp: value => save('mcp', value), removeMcp: value => remove('mcp', value), savePrompt: value => save('prompt', value), removePrompt: value => remove('prompt', value),
    previewMcp: value => preview('mcp', value), previewPrompt: value => preview('prompt', value), apply, listBackups, previewRestore,
    exportPortable() { active(); return vault.exportPortable(); }, preparePortableImport(value) { active(); return vault.preparePortableImport(value); },
    preparePortableRecovery(value) { active(); return vault.preparePortableRecovery(value); }, getPortableTarget: () => vault.getPortableTarget(), dispose() { disposed = true; tokens.clear(); } };
}

module.exports = { createAiToolsResources };
