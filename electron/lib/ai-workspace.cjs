const { tr } = require('./localization.cjs');
const { createAiWorkspaceService } = require('./ai-workspace-service.cjs');
const { createEvidenceAdapter } = require('./ai-workspace-evidence.cjs');
const { createBuiltinClient } = require('./ai-workspace-client.cjs');
const { createWorkerReportStore, runWorkspaceJob, cleanupWorkspaceProcessor } = require('./ai-workspace-processor.cjs');

const instances = new Map();
const watchedOwners = new WeakSet();
function register(ipcMain) {
  const ctx = require('./app-context.cjs');
  const ssh = require('./ssh.cjs');
  const { app, dialog } = require('electron');
  const path = require('node:path');
  const outbound = require('./ai-outbound-transport.cjs');
  const client = createBuiltinClient({ request: outbound.request, deferTimeoutUntilAuthorized: true,
    serializeBody: (payload, options) => runWorkspaceJob('transportBody', { payload }, options) });
  const factory = sender => createAiWorkspaceService({ client: args => outbound.withOperation({ title: tr('AI 工作区'), kind: 'summary', contentFormat: 'workspace-json', signal: args.signal }, () => client(args), sender), processor: runWorkspaceJob,
    evidence: createEvidenceAdapter({ getLogs: require('./log-analyzer.cjs').getAnalysisSnapshots,
      getSerial: require('./serial.cjs').snapshots, getSsh: ssh.getAnalysisSources, readSsh: ssh.readAnalysisTerminal,
      runAdb: require('./adb-runtime.cjs').runAdb, processor: runWorkspaceJob }),
    membership: () => require('./vip.cjs').getStatusAsync(), saveTask: (draft, metadata) => require('./task-center.cjs').saveAiDraft(draft, metadata),
    history: createWorkerReportStore({ directory: path.join(app.getPath('userData'), 'ai-workspace-reports') }),
    casebook: createWorkerReportStore({ directory: path.join(app.getPath('userData'), 'ai-workspace-casebook'), casebook: true }),
    resolveHandoff: id => require('./ai-analysis-handoff.cjs').resolveForWorkspace(id),
    resolveTaskTargets: tokens => require('./task-center.cjs').resolveAiTaskTargets(tokens, sender.id),
    activity: require('./workbench-activity.cjs'),
    confirmDelete: async report => {
      const answer = await require('./app-message-dialog.cjs').ask({ type: 'question', title: tr('删除已保存报告'),
        message: report.name, detail: tr('仅删除这份本地分析报告，不会删除原始日志或修改设备。'),
        buttons: [tr('取消'), tr('删除')], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1;
    },
    exportReport: async (text, assertCurrent, signal) => {
      const answer = await dialog.showSaveDialog(ctx.getMainWindow(), { title: tr('导出分析报告'), defaultPath: 'ai-report.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: tr('文本文件'), extensions: ['txt'] }] });
      assertCurrent();
      if (answer.canceled || !answer.filePath) return { cancelled: true };
      await runWorkspaceJob('export', { filename: answer.filePath, text }, { signal });
      return { path: answer.filePath };
    },
    confirmSave: async draft => {
      const answer = await require('./app-message-dialog.cjs').ask({ type: 'question', title: tr('保存 AI 测试任务'),
        message: draft.name, detail: [tr('将创建包含 {0} 个步骤的新任务，不会自动执行。请在任务中心核对目标设备和操作后再运行。', { 0: draft.steps.length }),
          ...(draft.missingInformation || [])].join('\n'),
        buttons: [tr('取消'), tr('保存到任务中心')], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1;
    } });
  registerHandlers(ipcMain, { getOwner: ctx.getMainWindow, factory });
}

function registerHandlers(ipcMain, { getOwner, factory }) {
  for (const method of ['sources', 'plan', 'collect', 'analyze', 'generateTask', 'saveTask', 'cancel', 'close',
    'historyList', 'historyLoad', 'historySave', 'historyDelete', 'reportText', 'historyExport', 'comparisonPreview',
    'casebookList', 'casebookLoad', 'casebookSave', 'casebookUpdate', 'casebookDelete', 'casebookSimilar']) {
    ipcMain.handle(`ai-workspace:${method}`, async (event, args) => {
      const owner = getOwner();
      if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
        return { ok: false, code: 'AI_OWNER', error: tr('仅允许在应用主窗口使用 AI 工作区。') };
      }
      let instance = instances.get(event.sender);
      if (!instance) {
        instance = factory(event.sender); instances.set(event.sender, instance);
        if (!watchedOwners.has(event.sender)) {
          const sender = event.sender;
          watchedOwners.add(sender);
          const discard = () => { instances.get(sender)?.dispose(); instances.delete(sender); };
          sender.once('destroyed', discard);
          sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) discard(); });
        }
      }
      return instance.call(method, args);
    });
  }
}
function cleanup() { for (const instance of instances.values()) instance.dispose(); instances.clear(); void cleanupWorkspaceProcessor(); }
module.exports = { register, registerHandlers, cleanup };
