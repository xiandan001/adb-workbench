const path = require('node:path');
const { createHash } = require('node:crypto');
const { createAiToolsStore, validateProvider } = require('./ai-tools-store.cjs');
const { createAiToolsResources } = require('./ai-tools-resources.cjs');
const { createAiToolsSkills } = require('./ai-tools-skills.cjs');
const { createAiToolsProjects } = require('./ai-tools-projects.cjs');
const { createRouterConfig } = require('./ai-tools-router-config.cjs');
const { readSafe, fail } = require('./ai-tools-file-safety.cjs');
const { exact, UUID, requireEncryption, validatePortableList } = require('./ai-tools-migration-common.cjs');
const { fileLimit, MAX_AI_FILES } = require('./data-migration-ai-plan.cjs');

const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
const MAX_STAGED = 256 * 1024 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const routerUrl = (port, protocol) => `http://127.0.0.1:${port}/${protocol === 'gemini' ? 'v1beta' : 'v1'}`;

function getExportSummary(ai) {
  return { ai: {
    providers: { count: ai.providers.providers.length }, mcpServers: { count: ai.resources.mcpServers.length }, prompts: { count: ai.resources.prompts.length },
    skills: { count: ai.skills.skills.length }, projects: { count: ai.projects.projects.length }, routes: { count: ai.router.routes.length }, sessions: { count: ai.sessions.records.length },
  }, includesAiSessions: ai.sessions.included === true };
}

function createAiToolsMigration({ directory, home, canEncrypt, encrypt, decrypt } = {}) {
  if (![directory, home].every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))) throw fail('AI_TOOLS_MIGRATION_PATH', 'AI 迁移目录无效');
  const encryption = { canEncrypt, encrypt, decrypt }; let disposed = false; const instances = new Set();
  const active = () => { if (disposed) throw fail('AI_TOOLS_MIGRATION_CANCELLED', 'AI 迁移已取消，未生成待导入文件'); };
  function services() {
    active(); requireEncryption(encryption);
    const options = { directory, home, ...encryption };
    const providers = createAiToolsStore(options);
    const resources = createAiToolsResources({ ...options, backupDirectory: path.join(directory, 'resource-backups') });
    const skills = createAiToolsSkills({ ...options, directory: path.join(directory, 'skills') });
    const projects = createAiToolsProjects({ ...options });
    const router = createRouterConfig({ ...options, getProvider: providers.getProvider });
    for (const service of [resources, skills, projects]) instances.add(service);
    return { providers, resources, skills, projects, router };
  }
  function sessions() {
    const { createAiToolsSessionArchives } = require('./ai-tools-session-archives.cjs');
    const service = createAiToolsSessionArchives({ directory, home, ...encryption }); instances.add(service); return service;
  }
  function nameFor(file) {
    const relative = path.relative(directory, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('AI_TOOLS_MIGRATION_PATH', 'AI 迁移目标超出本应用目录');
    const name = `ai-tools/${relative.split(path.sep).join('/')}`;
    if (!fileLimit(name)) throw fail('AI_TOOLS_MIGRATION_PATH', 'AI 迁移目标不在允许列表中');
    return name;
  }
  function initialGuards() {
    return ['ai-tools-store.v1.json', 'ai-tools-resources.v1.json', 'projects.v1.json', 'router.v1.json'].map(name => {
      const file = path.join(directory, name); const limit = fileLimit(`ai-tools/${name}`);
      return { path: file, expectedHash: readSafe(file, undefined, limit).hash, limit };
    });
  }
  function normalizeGuards(rows) {
    const output = new Map();
    for (const row of rows) {
      const name = nameFor(row.path); const old = output.get(name);
      if (old && old.expectedHash !== row.expectedHash) throw fail('AI_TOOLS_MIGRATION_CHANGED', 'AI 数据在预览期间已变化，请重新预览');
      output.set(name, { name, expectedHash: row.expectedHash });
    }
    return [...output.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  function checkGuards(rows) {
    for (const row of rows) {
      const file = path.join(path.dirname(directory), ...row.name.split('/'));
      if (readSafe(file, undefined, fileLimit(row.name)).hash !== row.expectedHash) throw fail('AI_TOOLS_MIGRATION_CHANGED', 'AI 数据在读取或预览期间已变化，请重新操作');
    }
  }
  async function exportState({ includeSessions = true } = {}) {
    active(); requireEncryption(encryption);
    if (typeof includeSessions !== 'boolean') throw fail('AI_TOOLS_MIGRATION_FORMAT', '请明确是否包含 AI 会话历史');
    const before = initialGuards(); const service = services();
    const providers = service.providers.exportPortable(); const router = service.router.exportPortable(); service.router.validatePortable(router);
    const sourceKey = service.router.getKey(); const localProfiles = [];
    for (const provider of providers.providers) {
      const route = router.routes.find(row => provider.model === `awb-${row.id}` && row.protocol === provider.protocol);
      const localCredential = provider.apiKey === sourceKey && provider.baseUrl === routerUrl(router.port, provider.protocol);
      if (localCredential && !route) throw fail('AI_TOOLS_MIGRATION_ROUTER_DEPENDENCY', '有本机路由供应商引用的路由已删除或失效，请先修复该记录再导出；不会携带源网关密钥');
      if (route && localCredential) {
        localProfiles.push({ providerId: provider.id, routeId: route.id, protocol: provider.protocol }); delete provider.apiKey;
      }
    }
    const localIds = new Set(localProfiles.map(row => row.providerId));
    if (router.routes.some(row => row.providerIds.some(id => localIds.has(id)))) throw fail('AI_TOOLS_MIGRATION_ROUTER_DEPENDENCY', '路由上游引用了本应用本机路由供应商，存在循环依赖风险；请先解除后再导出');
    const result = { version: 1, providers, resources: service.resources.exportPortable(), skills: service.skills.exportPortable(), projects: service.projects.exportPortable(), router,
      sessions: { version: 1, included: false, records: [] }, localProfiles };
    const guards = normalizeGuards([...before, ...service.skills.getMigrationGuards()]);
    if (includeSessions) result.sessions = await sessions().exportPortable();
    active(); checkGuards(guards);
    return result;
  }
  function normalizedProviders(payload) {
    const ids = new Set();
    return validatePortableList(payload, 'providers', 200, '供应商迁移').map(input => {
      const row = validateProvider(input);
      if (!UUID.test(row.id) || ids.has(row.id)) throw fail('AI_TOOLS_MIGRATION_FORMAT', '供应商标识缺失或重复');
      ids.add(row.id); for (const key of ['apiKey', 'quotaKey']) if (row[key] === null) delete row[key];
      return row;
    });
  }
  function bindings(ai, providers, router) {
    if (!Array.isArray(ai.localProfiles) || ai.localProfiles.length > 200) throw fail('AI_TOOLS_MIGRATION_FORMAT', '本机路由绑定列表无效');
    const byProvider = new Map();
    for (const item of ai.localProfiles) {
      exact(item, ['providerId', 'routeId', 'protocol'], '本机路由绑定');
      const provider = providers.find(row => row.id === item.providerId); const route = router.routes.find(row => row.id === item.routeId);
      if (!UUID.test(item.providerId) || !UUID.test(item.routeId) || !PROTOCOLS.includes(item.protocol) || byProvider.has(item.providerId) || !provider || !route
        || provider.protocol !== item.protocol || route.protocol !== item.protocol || provider.model !== `awb-${route.id}` || provider.baseUrl !== routerUrl(router.port, item.protocol) || Object.hasOwn(provider, 'apiKey')) throw fail('AI_TOOLS_MIGRATION_FORMAT', '本机路由绑定与供应商/模型/地址不一致，未导入');
      byProvider.set(item.providerId, item);
    }
    if (router.routes.some(route => route.providerIds.some(id => byProvider.has(id)))) throw fail('AI_TOOLS_MIGRATION_ROUTER_DEPENDENCY', '备份包含本机路由互相依赖，不会自动导入循环方案');
    return byProvider;
  }
  async function previewImport(ai) {
    active(); requireEncryption(encryption);
    exact(ai, ['version', 'providers', 'resources', 'skills', 'projects', 'router', 'sessions', 'localProfiles'], 'AI 迁移');
    if (ai.version !== 1) throw fail('AI_TOOLS_MIGRATION_FORMAT', 'AI 迁移版本不受支持');
    const before = initialGuards(); const service = services(); const incoming = normalizedProviders(ai.providers);
    const sourceRouter = service.router.validatePortable(ai.router); const local = bindings(ai, incoming, sourceRouter);
    const existing = service.providers.exportPortable().providers; const merged = new Map(existing.map(row => [row.id, row])); const conflicts = [];
    for (const row of incoming) {
      if (local.has(row.id)) continue;
      if (!merged.has(row.id)) merged.set(row.id, row);
      else if (!same(merged.get(row.id), row)) conflicts.push(row.id);
    }
    const routerPlan = service.router.preparePortableImport(sourceRouter, { resolveProvider: id => merged.get(id), conflictingProviderIds: conflicts });
    const accepted = new Set(routerPlan.acceptedRouteIds); const warnings = [...routerPlan.warnings]; let skippedLocal = 0;
    const selectedProviders = incoming.flatMap(row => {
      const binding = local.get(row.id);
      if (!binding || existing.some(current => current.id === row.id)) return [row];
      if (!accepted.has(binding.routeId)) { skippedLocal++; warnings.push(`本机路由供应商 ${row.name} 关联的路由或上游存在冲突，未导入此记录。`); return []; }
      return [{ ...row, apiKey: routerPlan.key, baseUrl: routerUrl(routerPlan.port, row.protocol) }];
    });
    const providerPlan = service.providers.preparePortableImport({ version: 1, providers: selectedProviders });
    const resourcePlan = service.resources.preparePortableImport(ai.resources);
    const skillPlan = service.skills.preparePortableImport(ai.skills);
    const projectPlan = service.projects.preparePortableImport(ai.projects);
    exact(ai.sessions, ['version', 'included', 'records'], 'AI 会话迁移');
    if (ai.sessions.version !== 1 || typeof ai.sessions.included !== 'boolean' || !Array.isArray(ai.sessions.records) || !ai.sessions.included && ai.sessions.records.length) throw fail('AI_TOOLS_MIGRATION_FORMAT', 'AI 会话包含标记或内容无效');
    const sessionPlan = ai.sessions.included ? await sessions().preparePortableImport(ai.sessions) : { targets: [], guards: [], counts: { added: 0, skipped: 0 } };
    active();
    const targets = [providerPlan.target, resourcePlan.target, projectPlan.target, routerPlan.target, ...skillPlan.targets, ...sessionPlan.targets];
    const writes = targets.map(target => {
      const name = nameFor(target.path);
      if (!Buffer.isBuffer(target.after) || target.after.length > fileLimit(name)) throw fail('AI_TOOLS_MIGRATION_LIMIT', 'AI 密文超过单文件大小限制，未导入或截断');
      return { name, bytes: target.after, expectedHash: target.beforeHash };
    });
    if (new Set(writes.map(row => row.name)).size !== writes.length || writes.length > MAX_AI_FILES) throw fail('AI_TOOLS_MIGRATION_FORMAT', 'AI 写入计划重复或超过数量限制');
    const stagedBytes = writes.reduce((total, row) => total + Math.ceil(row.bytes.length / 3) * 4 + row.name.length + 128, 0);
    if (stagedBytes > MAX_STAGED) throw fail('AI_TOOLS_MIGRATION_LIMIT', 'AI 待导入密文超过 256 MiB，请取消会话历史或减少数据后重试；未导入或截断');
    const guards = normalizeGuards([...before, ...skillPlan.guards, ...sessionPlan.guards, ...targets.map(target => ({ path: target.path, expectedHash: target.beforeHash, limit: target.limit }))]);
    checkGuards(guards);
    if (projectPlan.counts.added) warnings.push('新导入项目保留来源路径提示，但必须通过目录选择器重新绑定后才能打开或启动。');
    if (skillPlan.counts.added) warnings.push('仅导入 Skills 加密库内容，不安装到任何工具，也不执行脚本。');
    warnings.push('路由仅导入定义并保持停止；本机路由供应商使用目标机器自己的网关密钥。');
    if (!ai.sessions.included) warnings.push('此备份未包含 AI 会话历史，目标机器已有会话归档会保留。');
    return { writes, guards, stateHash: createHash('sha256').update(JSON.stringify(guards)).digest('hex'), summary: {
      providers: { added: providerPlan.counts.added, skipped: providerPlan.counts.skipped + skippedLocal }, mcpServers: resourcePlan.counts.mcpServers, prompts: resourcePlan.counts.prompts,
      skills: skillPlan.counts, projects: projectPlan.counts, routes: routerPlan.counts, sessions: sessionPlan.counts,
    }, warnings };
  }
  return { exportState, previewImport, getExportSummary,
    dispose() { disposed = true; for (const service of instances) service.dispose?.(); instances.clear(); } };
}

module.exports = { createAiToolsMigration, getExportSummary };
