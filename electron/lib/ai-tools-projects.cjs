const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readSafe, atomicReplace, checksum, assertSafeParents, fail } = require('./ai-tools-file-safety.cjs');
const { exact, text, validatePortableList, portablePathHint, prepareStateWrite, UUID } = require('./ai-tools-migration-common.cjs');

const TOOLS = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', grokbuild: 'grok', opencode: 'opencode', openclaw: 'openclaw', hermes: 'hermes', pi: 'pi', mcode: 'mcode', kimi: 'kimi', agy: 'agy' });
const ID = /^[a-f0-9-]{36}$/i;
function createAiToolsProjects({ directory, home, canEncrypt, encrypt, decrypt, findExecutable, launchTerminal, openDirectory, getProvider, now = Date.now }) {
  const file = path.join(directory, 'projects.v1.json'); let state; let observed; let disposed = false; let generation = 0; const tokens = new Map(); const launches = new Map(); const launchControllers = new Set();
  const active = () => { if (disposed) throw fail('AI_TOOLS_DISPOSED', tr("项目工作区已关闭，未继续启动 CLI")); };
  const current = epoch => { active(); if (epoch !== generation) throw fail('AI_TOOLS_CANCELLED', tr("项目操作已取消，请重新预览")); };
  function validDirectory(value) {
    active();
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.resolve(value) === path.parse(path.resolve(value)).root || path.resolve(value).toLowerCase() === path.resolve(home).toLowerCase()) throw fail('AI_TOOLS_PROJECT_PATH', tr("请选择具体项目文件夹，不要选择磁盘根目录或整个用户目录"));
    assertSafeParents(path.join(value, '.scope'));
    const stat = fs.lstatSync(value); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AI_TOOLS_PROJECT_PATH', tr("项目路径不是普通文件夹"));
    return path.resolve(value);
  }
  function load() {
    active();
    if (state) return state;
    const source = readSafe(file); observed = source.hash;
    if (!source.exists) return state = { version: 1, projects: [] };
    if (!canEncrypt()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("无法解密项目库"));
    try {
      const value = JSON.parse(decrypt(Buffer.from(JSON.parse(source.bytes.toString('utf8')).encrypted, 'base64')));
      if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 100 || new Set(value.projects.map(row => row.id)).size !== value.projects.length) throw new Error();
      for (const row of value.projects) {
        if (!ID.test(row.id) || typeof row.name !== 'string' || row.name.length > 100 || !Object.hasOwn(TOOLS, row.toolId) || typeof row.pinned !== 'boolean') throw new Error();
        if (row.needsRelocation === true) { if (row.path !== '') throw new Error(); portablePathHint(row.oldPath); }
        else if (typeof row.path !== 'string' || !path.isAbsolute(row.path) || row.oldPath !== undefined || row.needsRelocation !== undefined && row.needsRelocation !== false) throw new Error();
      }
      return state = value;
    } catch { throw fail('AI_TOOLS_PROJECT_STORAGE', tr("项目库无法读取，原文件已保留")); }
  }
  function persist(value) {
    if (!canEncrypt()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，不能保存项目库"));
    let ciphertext;
    try { ciphertext = encrypt(JSON.stringify(value)); if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error(); } catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', tr("项目库加密失败，原文件未修改")); }
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, encrypted: ciphertext.toString('base64') })}\n`);
    atomicReplace(file, bytes, observed); observed = checksum(bytes); state = value;
  }
  function get(id) { const project = load().projects.find(row => row.id === id); if (!project) throw fail('AI_TOOLS_PROJECT_MISSING', tr("项目不存在")); return project; }
  function usable(project) { if (project.needsRelocation) throw fail('AI_TOOLS_PROJECT_RELOCATE', tr("这是迁移的项目，请先通过目录选择器重新选择本机项目目录")); return project; }
  function offerDirectory(selected) {
    const resolved = validDirectory(selected); const token = randomUUID();
    for (const [id, row] of tokens) if (row.expiresAt < now()) tokens.delete(id);
    if (tokens.size >= 8) tokens.delete(tokens.keys().next().value);
    tokens.set(token, { path: resolved, expiresAt: now() + 300000 }); return { token, path: resolved, name: path.basename(resolved) };
  }
  function save(input) {
    const current = load();
    if (!input || Object.keys(input).some(key => !['id', 'name', 'toolId', 'pinned', 'directoryToken'].includes(key)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || Array.from(input.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !Object.hasOwn(TOOLS, input.toolId) || typeof input.pinned !== 'boolean') throw fail('AI_TOOLS_PROJECT_INVALID', tr("项目名称或工具选择无效"));
    const old = input.id ? get(input.id) : null; let target = old?.path; let relocated = false;
    if (input.directoryToken) { const grant = tokens.get(input.directoryToken); tokens.delete(input.directoryToken); if (!grant || grant.expiresAt < now()) throw fail('AI_TOOLS_PREVIEW_EXPIRED', tr("所选文件夹已过期，请重新选择")); target = grant.path; relocated = true; }
    const awaitingRelocation = old?.needsRelocation === true && !relocated;
    if (!target && !awaitingRelocation) throw fail('AI_TOOLS_PROJECT_PATH', tr("请先选择项目文件夹"));
    if (!awaitingRelocation) validDirectory(target);
    if (!old && current.projects.length >= 100) throw fail('AI_TOOLS_PROJECT_LIMIT', tr("最多保存 100 个项目"));
    const project = { id: old?.id || randomUUID(), name: input.name.trim(), path: target, toolId: input.toolId, pinned: input.pinned, updatedAt: now(), ...(awaitingRelocation ? { oldPath: old.oldPath, needsRelocation: true } : {}) };
    persist({ version: 1, projects: [...current.projects.filter(row => row.id !== project.id), project] }); return { ...project };
  }
  async function previewLaunch({ projectId, providerId } = {}) {
    const epoch = generation;
    const project = usable(get(projectId)); const cwd = validDirectory(project.path); const executable = await findExecutable(TOOLS[project.toolId]);
    current(epoch);
    if (!executable) throw fail('AI_TOOLS_CLI_MISSING', tr("未在 PATH 中找到 {0}；请先自行安装该 CLI，本应用不会自动下载或执行安装脚本", { 0: TOOLS[project.toolId] }));
    let provider = null;
    if (project.toolId === 'agy') {
      provider = getProvider(providerId);
      if (provider.protocol !== 'gemini' || !provider.apiKey || !provider.model || !provider.targetApps.includes('agy')) throw fail('AI_TOOLS_PROJECT_PROVIDER', tr("Antigravity 受管启动需选择具有密钥和模型的 Gemini 协议供应商"));
    } else if (providerId !== undefined && providerId !== null && providerId !== '') throw fail('AI_TOOLS_PROJECT_PROVIDER', tr("此 CLI 使用已预览应用的原生配置；不会悄悄改写供应商"));
    const token = randomUUID(); const expiresAt = now() + 300000;
    if (launches.size >= 8) launches.delete(launches.keys().next().value);
    launches.set(token, { project: { ...project }, executable, cwd, provider, expiresAt });
    return { token, expiresAt, projectId, toolId: project.toolId, cwd, executable, providerName: provider?.name || null,
      warnings: [tr("将在新的外部终端窗口执行已安装 CLI，CLI 可读写所选项目并按自身配置访问服务；此操作不会安装软件或修改登录状态。"), ...(provider ? [tr("仅给本次进程传入密钥和地址，并使用本应用独立配置目录，不改写全局登录配置。"), tr("此独立目录暂不继承全局 AGY 提示词、MCP 与 Skills；不代表已有全局资源已经同步。"), ...(new URL(provider.baseUrl).protocol === 'http:' ? [tr("所选服务地址为 HTTP；CLI 可能以未加密网络发送 API 密钥，请确认该地址可信。")] : [])] : [tr("使用 CLI 现有原生配置；如需更换供应商，请先在「配置应用」中预览并应用。")])] };
  }
  async function launch({ token }) {
    active(); const epoch = generation;
    const plan = launches.get(token); launches.delete(token);
    if (!plan || plan.expiresAt < now()) throw fail('AI_TOOLS_PREVIEW_EXPIRED', tr("启动预览已过期，请重新预览"));
    const executable = await findExecutable(TOOLS[plan.project.toolId]); current(epoch);
    if (JSON.stringify(usable(get(plan.project.id))) !== JSON.stringify(plan.project) || executable !== plan.executable) throw fail('AI_TOOLS_PROJECT_CHANGED', tr("项目或 CLI 路径已变化，请重新预览"));
    validDirectory(plan.cwd);
    if (plan.provider && checksum(Buffer.from(JSON.stringify(getProvider(plan.provider.id)))) !== checksum(Buffer.from(JSON.stringify(plan.provider)))) throw fail('AI_TOOLS_PROVIDER_CHANGED', tr("供应商已变化，请重新预览启动"));
    const args = []; const env = {};
    if (plan.provider) {
      const isolated = path.join(directory, 'agy', plan.provider.id); const target = path.join(isolated, 'antigravity-cli', 'settings.json');
      const before = readSafe(target); let settings = {};
      if (before.exists) { try { settings = JSON.parse(before.bytes.toString('utf8')); if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(); } catch { throw fail('AI_TOOLS_PROJECT_CONFIG', tr("受管 AGY 配置无法读取，未覆盖")); } }
      // This private profile contains model preferences, never API keys or OAuth tokens.
      settings.model = plan.provider.model; settings.modelProvider = 'gemini';
      atomicReplace(target, Buffer.from(`${JSON.stringify(settings, null, 2)}\n`), before.hash);
      args.push(`--gemini_dir=${isolated}`); env.GEMINI_API_KEY = plan.provider.apiKey; env.GOOGLE_GEMINI_BASE_URL = plan.provider.baseUrl;
    }
    const controller = new AbortController(); launchControllers.add(controller);
    try {
      const result = await launchTerminal({ executable: plan.executable, args, cwd: plan.cwd, env, signal: controller.signal });
      current(epoch);
      return { launched: true, projectId: plan.project.id, ...(result?.terminalReady === true ? { terminalReady: true, terminalPid: result.terminalPid, launcherPid: result.launcherPid } : {}) };
    } finally { launchControllers.delete(controller); }
  }
  function exportPortable() {
    return { version: 1, projects: load().projects.map(row => ({ id: row.id, name: row.name, toolId: row.toolId, pinned: row.pinned, updatedAt: row.updatedAt, oldPath: row.needsRelocation ? row.oldPath : row.path })) };
  }
  function preparePortableImport(payload) {
    const currentState = load(); const ids = new Set(); let skipped = 0;
    const incoming = validatePortableList(payload, 'projects', 100, tr("项目迁移")).map(row => {
      exact(row, ['id', 'name', 'toolId', 'pinned', 'updatedAt', 'oldPath'], tr("项目条目"));
      if (!UUID.test(row.id) || ids.has(row.id) || !Object.hasOwn(TOOLS, row.toolId) || typeof row.pinned !== 'boolean' || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) throw fail('AI_TOOLS_MIGRATION_FORMAT', tr("项目条目标识、工具或时间无效"));
      ids.add(row.id);
      return { id: row.id, name: text(row.name, 100, tr("项目名称")), toolId: row.toolId, pinned: row.pinned, updatedAt: row.updatedAt, path: '', oldPath: portablePathHint(row.oldPath), needsRelocation: true };
    }).filter(row => { if (currentState.projects.some(old => old.id === row.id)) { skipped++; return false; } return true; });
    if (currentState.projects.length + incoming.length > 100) throw fail('AI_TOOLS_PROJECT_LIMIT', tr("合并后超过 100 个项目，未导入或截断"));
    return { target: prepareStateWrite(file, { version: 1, projects: [...currentState.projects, ...incoming] }, observed, { canEncrypt, encrypt, decrypt }, 2 * 1024 * 1024), counts: { added: incoming.length, skipped } };
  }
  return { offerDirectory, save, previewLaunch, launch, exportPortable, preparePortableImport,
    getMigrationGuards() { load(); return [{ path: file, expectedHash: observed, limit: 2 * 1024 * 1024 }]; },
    snapshot: () => ({ projects: load().projects.map(row => ({ ...row })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), tools: Object.entries(TOOLS).map(([id, command]) => ({ id, command })) }),
    remove(id) { get(id); persist({ version: 1, projects: load().projects.filter(row => row.id !== id) }); return { id }; },
    async open(id) { const selected = validDirectory(usable(get(id)).path); await openDirectory(selected); return { opened: true }; },
    async environment() { active(); const epoch = generation; const tools = await Promise.all(Object.entries(TOOLS).map(async ([id, command]) => ({ id, command, path: await findExecutable(command) || null }))); current(epoch); return { tools }; },
    cancelPending() { generation++; tokens.clear(); launches.clear(); for (const controller of launchControllers) controller.abort(); },
    dispose() { disposed = true; generation++; tokens.clear(); launches.clear(); for (const controller of launchControllers) controller.abort(); } };
}

module.exports = { createAiToolsProjects, PROJECT_TOOLS: TOOLS };
