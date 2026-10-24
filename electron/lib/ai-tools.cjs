const { tr } = require('./localization.cjs');
const path = require('node:path');
const { createAiToolsController } = require('./ai-tools-controller.cjs');
const { createAiToolsStore } = require('./ai-tools-store.cjs');
const { createAiToolsConfig } = require('./ai-tools-config.cjs');
const { getAiToolsCatalog } = require('./ai-tools-catalog.cjs');
const { createAiToolsQuota } = require('./ai-tools-quota.cjs');
const { createAiToolsModels } = require('./ai-tools-models.cjs');
const { createAiToolsProbe } = require('./ai-tools-probe.cjs');
const { createAiToolsSessions } = require('./ai-tools-sessions.cjs');
const { createAiToolsRouter } = require('./ai-tools-router.cjs');
const { createAiToolsResources } = require('./ai-tools-resources.cjs');
const { createAiToolsProjects } = require('./ai-tools-projects.cjs');
const { createAiToolsPortable } = require('./ai-tools-portable.cjs');
const { createAiToolsSkills } = require('./ai-tools-skills.cjs');
const { readSafe, fail } = require('./ai-tools-file-safety.cjs');
const { findExecutable, launchTerminal } = require('./ai-tools-launcher.cjs');
const { requestJson, createAiToolsNetwork } = require('./ai-tools-network.cjs');
const appMessageDialog = require('./app-message-dialog.cjs');

let controller;
function register(ipcMain) {
  const { app, safeStorage, clipboard, dialog, shell } = require('electron');
  const { getMainWindow } = require('./app-context.cjs');
  const vip = require('./vip.cjs');
  const directory = path.join(app.getPath('userData'), 'ai-tools');
  const encryption = {
    canEncrypt: () => safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: bytes => safeStorage.decryptString(bytes),
  };
  // Constructors are lazy: no CLI configuration, credential import or quota
  // request is performed when this feature registers or a page opens.
  const store = createAiToolsStore({ directory, ...encryption });
  const config = createAiToolsConfig({ home: app.getPath('home'), backupDirectory: path.join(directory, 'config-backups'), getProvider: store.getProvider, ...encryption });
  const router = createAiToolsRouter({ directory, ...encryption, getProvider: store.getProvider, saveProvider: store.saveProvider, getMembership: () => vip.getStatusAsync() });
  const probeRequest = createAiToolsNetwork({ timeoutMs: 45000, maxBytes: 128 * 1024 }).requestJson;
  const localProbeRequest = createAiToolsNetwork({ transport: require('node:http').request, allowLoopback: true, timeoutMs: 45000, maxBytes: 128 * 1024 }).requestJson;
  const resources = createAiToolsResources({ directory, home: app.getPath('home'), backupDirectory: path.join(directory, 'resource-backups'), ...encryption });
  controller = createAiToolsController({ store, config, quota: createAiToolsQuota(), models: createAiToolsModels({ request: requestJson, resolveLocal: router.localModels }), sessions: createAiToolsSessions({ home: app.getPath('home'), directory, ...encryption }),
    probe: createAiToolsProbe({ request: probeRequest, requestLocal: localProbeRequest, resolveLocal: router.localProbe }),
    confirmProbe: async plan => {
      const answer = await appMessageDialog.ask({ type: 'question', title: tr("测试模型连接"), message: tr("测试 {0} 的模型连接？", { 0: plan.name }),
        detail: tr("模型：{0}\n接口：{1}\n\n模型调用测试仅发送固定短文本“Reply OK.”，输出上限 {2} tokens，不发送项目文件，不自动重试，可能消耗少量服务商额度。\n\n也可选择只读接口检查；不提供模型列表不代表模型不能调用。", { 0: plan.model, 1: plan.endpoint, 2: plan.maxOutputTokens }),
        buttons: [tr("开始最小模型测试"), tr("仅检查只读接口"), tr("取消")], defaultId: 2, cancelId: 2, noLink: true });
      return answer.response === 0 ? 'inference' : answer.response === 1 ? 'read-only' : 'cancel';
    },
    skills: createAiToolsSkills({ directory: path.join(directory, 'skills'), home: app.getPath('home'), ...encryption }),
    projects: createAiToolsProjects({ directory, home: app.getPath('home'), ...encryption, getProvider: store.getProvider, findExecutable, launchTerminal, openDirectory: async target => { const error = await shell.openPath(target); if (error) throw new Error(tr("打开项目文件夹失败")); } }),
    pickDirectory: async title => { const result = await dialog.showOpenDialog(getMainWindow(), { title, properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] || null; },
    resources, portable: createAiToolsPortable({ directory: path.join(directory, 'portable-recovery'), providers: store, resources }),
    pickBackup: async saving => {
      const options = { title: saving ? tr("导出加密 AI 工具库") : tr("选择加密 AI 工具库"), filters: [{ name: tr("加密 AI 工具库"), extensions: ['awbai'] }] };
      const result = saving ? await dialog.showSaveDialog(getMainWindow(), { ...options, defaultPath: path.join(app.getPath('downloads'), tr("AI工具库-{0}.awbai", { 0: new Date().toISOString().slice(0, 10) })) }) : await dialog.showOpenDialog(getMainWindow(), { ...options, properties: ['openFile'] });
      const selected = result.filePath || result.filePaths?.[0]; if (result.canceled || !selected) return null;
      const target = path.resolve(selected); const relative = path.relative(app.getPath('userData'), target);
      if (path.extname(target).toLowerCase() !== '.awbai' || !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw fail('AI_TOOLS_PORTABLE_PATH', tr("请选择应用数据目录外的 .awbai 文件"));
      return { path: target, ...(saving ? { expectedHash: readSafe(target, undefined, 16 * 1024 * 1024).hash } : {}) };
    },
    router, copyText: text => clipboard.writeText(text),
    tools: getAiToolsCatalog(), getMembership: () => vip.getStatusAsync(), getOwner: getMainWindow });
  controller.register(ipcMain);
}

function createMigrationService() {
  const { app, safeStorage } = require('electron');
  const { createAiToolsMigration } = require('./ai-tools-migration-state.cjs');
  return createAiToolsMigration({ directory: path.join(app.getPath('userData'), 'ai-tools'), home: app.getPath('home'),
    canEncrypt: () => safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: bytes => safeStorage.decryptString(bytes) });
}

module.exports = { register, createMigrationService, reserveForMigration: () => controller?.reserveForMigration() ?? Promise.resolve(() => {}), cleanup: () => controller?.dispose() ?? Promise.resolve() };
