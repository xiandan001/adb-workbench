const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getAiToolsCatalog } = require('./ai-tools-catalog.cjs');
const { projectConfig, parseJsonc } = require('./ai-tools-config-adapters.cjs');
const { DESKTOP_PROFILE_ID, validateDesktopOwnership } = require('./ai-tools-config-desktop.cjs');
const { fail, checksum, readSafe, checkHash, atomicReplace, decodeConfig, assertSafeParents } = require('./ai-tools-file-safety.cjs');

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const BACKUP_LIMIT = 8 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const LOGIN_FILES = /^(?:auth\.json|oauth_creds\.json|credentials(?:\.json)?|accounts?\.json|\.credentials\.json)$/i;
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');

function createAiToolsConfig({ home, localAppData, paths = {}, backupDirectory, getProvider, canEncrypt = () => false, encrypt, decrypt, now = Date.now, filesystem: io = fs } = {}) {
  if (!validPath(home) || !validPath(backupDirectory) || typeof getProvider !== 'function') throw fail('AI_TOOLS_CONFIG_PATH', 'AI 工具配置目录无效');
  const localDirectory = localAppData || path.join(home, 'AppData', 'Local');
  if (!validPath(localDirectory)) throw fail('AI_TOOLS_CONFIG_PATH', 'LocalAppData 配置目录无效');
  for (const [key, value] of Object.entries(paths)) {
    if (!['claude', 'codex', 'geminiEnv', 'geminiSettings', 'opencode', 'grokbuild', 'pi', 'mcode', 'kimi', 'hermes', 'openclaw'].includes(key) || !validPath(value) || LOGIN_FILES.test(path.basename(value))) throw fail('AI_TOOLS_CONFIG_PATH', '配置目标路径无效，不能指向登录凭据文件');
  }
  const fixed = {
    claude: paths.claude || path.join(home, '.claude', 'settings.json'),
    codex: paths.codex || path.join(home, '.codex', 'config.toml'),
    geminiEnv: paths.geminiEnv || path.join(home, '.gemini', '.env'),
    geminiSettings: paths.geminiSettings || path.join(home, '.gemini', 'settings.json'),
    grokbuild: paths.grokbuild || path.join(home, '.grok', 'config.toml'),
    pi: paths.pi || path.join(home, '.pi', 'agent', 'models.json'),
    mcode: paths.mcode || path.join(home, '.minimax', 'config.yaml'),
    kimi: paths.kimi || path.join(home, '.kimi-code', 'config.toml'),
    hermes: paths.hermes || path.join(localDirectory, 'hermes', 'config.yaml'),
    openclaw: paths.openclaw || path.join(home, '.openclaw', 'openclaw.json'),
  };
  const tokens = new Map();
  const encrypted = () => { try { return canEncrypt() && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  const providerHash = provider => checksum(Buffer.from(JSON.stringify(provider)));
  function toolFiles(toolId) {
    if (toolId === 'claude-desktop') return [
      { path: path.join(localDirectory, 'Claude', 'claude_desktop_config.json'), role: 'normal' },
      { path: path.join(localDirectory, 'Claude-3p', 'claude_desktop_config.json'), role: 'third-party' },
      { path: path.join(localDirectory, 'Claude-3p', 'configLibrary', `${DESKTOP_PROFILE_ID}.json`), role: 'profile' },
      { path: path.join(localDirectory, 'Claude-3p', 'configLibrary', '_meta.json'), role: 'meta' },
    ];
    if (toolId === 'gemini') return [{ path: fixed.geminiEnv, role: 'env' }, { path: fixed.geminiSettings, role: 'settings' }];
    if (toolId === 'opencode') {
      const jsonc = path.join(home, '.config', 'opencode', 'opencode.jsonc');
      const selected = paths.opencode || (readSafe(jsonc, io).exists ? jsonc : path.join(home, '.config', 'opencode', 'opencode.json'));
      return [{ path: selected, role: 'settings' }];
    }
    return [{ path: fixed[toolId], role: 'settings' }];
  }
  function issue(operation) {
    for (const [key, value] of tokens) if (value.expiresAt < now()) tokens.delete(key);
    if (tokens.size >= 8) tokens.delete(tokens.keys().next().value);
    const token = randomUUID(); const expiresAt = now() + TTL;
    tokens.set(token, { ...operation, expiresAt });
    return {
      token, expiresAt, operation: operation.kind, toolId: operation.toolId, providerId: operation.providerId,
      files: operation.files.map(row => ({ path: row.path, exists: row.exists, beforeHash: row.hash, format: row.format, changes: row.changes })),
      warnings: [
        operation.kind === 'restore' ? '恢复会替换预览所列配置文件；若原文件不存在，则移除本工具此前新建的文件。' : '这些 CLI 需要在配置文件中保存明文 API Key；将仅写入列出的受管理字段，不读取或修改登录凭据文件。',
        '原始文件将以系统加密备份保存在本应用数据目录；外部修改会使本次预览失效。',
        ...(operation.insecure ? ['该服务地址使用 HTTP，CLI 请求可能以未加密网络传输 API Key，请确认此地址可信。'] : []),
        ...operation.files.flatMap(row => row.warnings || []),
      ],
    };
  }
  function preview({ toolId, providerId } = {}) {
    const tool = getAiToolsCatalog().find(row => row.id === toolId);
    if (!tool?.configSupported) throw fail('AI_TOOLS_CONFIG_UNSUPPORTED', '该工具的配置适配尚未完成，不会修改其数据');
    const provider = getProvider(providerId);
    if (!tool.protocols.includes(provider.protocol) || !provider.targetApps.includes(toolId)) throw fail('AI_TOOLS_CONFIG_PROTOCOL', '供应商协议或目标工具与此配置不兼容');
    const beforeFiles = toolFiles(toolId).map(target => ({ ...readSafe(target.path, io), role: target.role }));
    if (toolId === 'claude-desktop') validateDesktopOwnership(beforeFiles, parseJsonc);
    const files = beforeFiles.map(before => {
      const projection = projectConfig(toolId, before.role, decodeConfig(before.bytes), provider);
      const bytes = Buffer.from(projection.content, 'utf8');
      return { ...before, after: bytes, afterHash: checksum(bytes), format: projection.format, changes: projection.changes, warnings: projection.warnings || [] };
    });
    return issue({ kind: 'apply', toolId, providerId, providerHash: providerHash(provider), files, insecure: new URL(provider.baseUrl).protocol === 'http:' });
  }
  async function status({ toolId, providerIds = [], signal } = {}) {
    const tool = getAiToolsCatalog().find(row => row.id === toolId && row.configSupported);
    if (!tool || !Array.isArray(providerIds) || providerIds.length > 200 || providerIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(providerIds).size !== providerIds.length) throw fail('AI_TOOLS_CONFIG_STATUS', '配置状态查询参数无效');
    const checkedAt = now();
    const cancelled = () => { if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', '配置状态检查已取消'); };
    cancelled();
    if (!providerIds.length) return { toolId, checkedAt, providers: [] };
    let beforeFiles;
    try {
      beforeFiles = toolFiles(toolId).map(target => ({ ...readSafe(target.path, io), role: target.role }));
      if (toolId === 'claude-desktop') validateDesktopOwnership(beforeFiles, parseJsonc);
    } catch { return { toolId, checkedAt, providers: providerIds.map(providerId => ({ providerId, state: 'unknown', message: '无法安全读取本机配置，请检查文件权限或配置格式' })) }; }
    const selectsDefault = ['claude', 'codex', 'gemini', 'opencode', 'grokbuild'].includes(toolId);
    const providers = [];
    const providerHashes = new Map();
    for (const providerId of providerIds) {
      cancelled();
      try {
        const provider = getProvider(providerId);
        providerHashes.set(providerId, providerHash(provider));
        if (!tool.protocols.includes(provider.protocol) || !provider.targetApps.includes(toolId)) {
          providers.push({ providerId, state: 'incompatible', message: '协议或目标工具不匹配' });
        } else if (!provider.apiKey || !provider.model) {
          providers.push({ providerId, state: 'incomplete', message: '请先填写 API 密钥和默认模型' });
        } else if (beforeFiles.some(file => !file.exists)) {
          providers.push({ providerId, state: 'inactive', message: '尚未配置到此工具' });
        } else {
          const matches = beforeFiles.every(before => {
            const projection = projectConfig(toolId, before.role, decodeConfig(before.bytes), provider);
            return projection.changes.length === 0 || checksum(Buffer.from(projection.content, 'utf8')) === before.hash;
          });
          providers.push({ providerId, state: matches ? selectsDefault ? 'active' : 'configured' : 'inactive',
            message: matches ? selectsDefault ? '本机受管理配置一致；已运行的会话可能需要重启' : '已登记配置，仍需在工具内选择模型' : '尚未使用或本机配置已变化' });
        }
      } catch { providers.push({ providerId, state: 'unknown', message: '配置格式或供应商信息需要检查' }); }
      // Keep large provider libraries from blocking the main-process UI event loop.
      if (providers.length % 5 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    cancelled();
    try { for (const before of beforeFiles) checkHash(before.path, before.hash, io); }
    catch { return { toolId, checkedAt, providers: providerIds.map(providerId => ({ providerId, state: 'unknown', message: '检查期间配置发生变化，请刷新确认' })) }; }
    for (const row of providers) {
      if (!providerHashes.has(row.providerId)) continue;
      try {
        if (providerHash(getProvider(row.providerId)) === providerHashes.get(row.providerId)) continue;
      } catch { /* A removed or unreadable provider invalidates its previous result. */ }
      row.state = 'unknown'; row.message = '检查期间供应商信息发生变化，请刷新确认';
    }
    cancelled();
    return { toolId, checkedAt, providers };
  }
  function backupPath(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('AI_TOOLS_BACKUP_INVALID', '备份标识无效');
    return path.join(backupDirectory, `${id}.json`);
  }
  function readBackup(id) {
    if (!encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，无法读取配置备份');
    try {
      const raw = readSafe(backupPath(id), io, BACKUP_LIMIT);
      if (!raw.bytes) throw new Error('Missing backup');
      const envelope = JSON.parse(raw.bytes.toString('utf8'));
      if (envelope.version !== 1 || Object.keys(envelope).length !== 2 || typeof envelope.encrypted !== 'string') throw new Error('Envelope');
      const ciphertext = Buffer.from(envelope.encrypted, 'base64');
      if (!ciphertext.length || ciphertext.toString('base64') !== envelope.encrypted) throw new Error('Ciphertext');
      const plain = decrypt(ciphertext);
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > BACKUP_LIMIT) throw new Error('Backup too large');
      const value = JSON.parse(plain);
      if (value.version !== 1 || value.id !== id || !Number.isFinite(value.createdAt) || !getAiToolsCatalog().some(tool => tool.id === value.toolId && tool.configSupported) || !Array.isArray(value.files) || !value.files.length || value.files.length > 4) throw new Error('Invalid backup');
      const targets = new Set(toolFiles(value.toolId).map(row => path.resolve(row.path)));
      const seen = new Set();
      for (const row of value.files) {
        if (!validPath(row.path) || !targets.has(path.resolve(row.path)) || seen.has(path.resolve(row.path)) || ![null, 'string'].includes(row.before === null ? null : typeof row.before)
          || (row.appliedHash !== null && !/^[a-f0-9]{64}$/.test(row.appliedHash))) throw new Error('Invalid target');
        seen.add(path.resolve(row.path));
        const before = row.before === null ? null : Buffer.from(row.before, 'base64');
        if (before !== null && before.toString('base64') !== row.before) throw new Error('Invalid original');
        if (checksum(before) !== row.beforeHash) throw new Error('Invalid checksum');
      }
      return value;
    } catch { throw fail('AI_TOOLS_BACKUP_READ', '配置备份无法读取或目标路径已变化，已保留备份文件'); }
  }
  const publicBackup = value => ({ id: value.id, createdAt: value.createdAt, toolId: value.toolId, providerId: value.providerId, files: value.files.map(row => ({ path: row.path })) });
  function backupIds() {
    let entries;
    try { entries = io.readdirSync(backupDirectory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw fail('AI_TOOLS_BACKUP_READ', '无法读取配置备份目录'); }
    const ids = entries.filter(entry => entry.isFile() && /^[a-f0-9-]{36}\.json$/i.test(entry.name)).map(entry => entry.name.slice(0, -5));
    if (ids.length > 100) throw fail('AI_TOOLS_BACKUP_LIMIT', '配置备份超过 100 条，请先检查备份目录');
    return ids;
  }
  function listBackups() { return backupIds().map(id => publicBackup(readBackup(id))).sort((a, b) => b.createdAt - a.createdAt); }
  function saveBackup(operation) {
    if (!encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，不能安全备份并应用配置');
    if (backupIds().length >= 100) throw fail('AI_TOOLS_BACKUP_LIMIT', '配置备份已达到 100 条，本次未修改文件');
    const value = { version: 1, id: randomUUID(), createdAt: now(), toolId: operation.toolId, providerId: operation.providerId, files: operation.files.map(row => ({ path: row.path, before: row.bytes?.toString('base64') ?? null, beforeHash: row.hash, appliedHash: row.afterHash })) };
    let ciphertext;
    try { ciphertext = encrypt(JSON.stringify(value)); if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error('Invalid ciphertext'); }
    catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', '配置备份加密失败，未修改配置'); }
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, encrypted: ciphertext.toString('base64') })}\n`, 'utf8');
    atomicReplace(backupPath(value.id), bytes, null, io, BACKUP_LIMIT);
    return value;
  }
  function previewRestore({ backupId } = {}) {
    const backup = readBackup(backupId);
    const files = backup.files.map(row => {
      const current = readSafe(row.path, io);
      if (current.hash !== row.appliedHash) throw fail('AI_TOOLS_CONFIG_CHANGED', '当前配置与该备份对应的已应用版本不同，未覆盖外部变化');
      const original = row.before === null ? null : Buffer.from(row.before, 'base64');
      return { ...current, after: original, afterHash: checksum(original), format: 'original-bytes', changes: [{ field: '文件内容', before: '当前已应用版本', after: original === null ? '恢复为不存在' : '恢复原始备份（内容已隐藏）', secret: true }] };
    });
    return issue({ kind: 'restore', toolId: backup.toolId, providerId: backup.providerId, files });
  }
  function applyOperation(operation) {
    for (const row of operation.files) checkHash(row.path, row.hash, io);
    const backup = saveBackup(operation); const written = [];
    try {
      for (const row of operation.files) { atomicReplace(row.path, row.after, row.hash, io); written.push(row); }
    } catch {
      let failedRollback = false;
      for (const row of written.reverse()) {
        try { atomicReplace(row.path, row.bytes, row.afterHash, io); } catch { failedRollback = true; }
      }
      const result = fail('AI_TOOLS_CONFIG_APPLY_FAILED', failedRollback ? '配置应用失败且部分文件发生外部变化，未覆盖变化；请检查加密备份后恢复' : '配置应用失败，已恢复此前写入的文件并保留加密备份');
      result.backupId = backup.id; throw result;
    }
    return { backupId: backup.id, toolId: operation.toolId, providerId: operation.providerId, files: operation.files.map(row => row.path), operation: operation.kind };
  }
  function apply({ token } = {}) {
    const operation = tokens.get(token); tokens.delete(token);
    if (!operation || operation.expiresAt < now()) throw fail('AI_TOOLS_PREVIEW_EXPIRED', '配置预览已过期或失效，请重新预览');
    if (operation.kind === 'apply' && providerHash(getProvider(operation.providerId)) !== operation.providerHash) throw fail('AI_TOOLS_PROVIDER_CHANGED', '供应商配置已变化，请重新预览');
    if (operation.toolId !== 'mcode') return applyOperation(operation);
    const lock = `${operation.files[0].path}.lock`;
    assertSafeParents(lock, io); io.mkdirSync(path.dirname(lock), { recursive: true }); assertSafeParents(lock, io);
    try { io.mkdirSync(lock); } catch { throw fail('AI_TOOLS_CONFIG_BUSY', 'MCode 配置锁正在被占用，请等待其保存完成后重试；不会抢占或删除现有锁'); }
    const owned = io.lstatSync(lock);
    try { return applyOperation(operation); }
    finally {
      try { const current = io.lstatSync(lock); if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) io.rmdirSync(lock); }
      catch { /* Only remove the exact empty lock directory this operation created. */ }
    }
  }
  return { preview, status, apply, listBackups, previewRestore, dispose() { tokens.clear(); } };
}

module.exports = { createAiToolsConfig };
