const { tr } = require('./localization.cjs');
const { createAiWorkspaceService } = require('./ai-workspace-service.cjs');
const { createEvidenceAdapter } = require('./ai-workspace-evidence.cjs');
const { createBuiltinClient } = require('./ai-workspace-client.cjs');

const instances = new Map();
const watchedOwners = new WeakSet();
function register(ipcMain) {
  const ctx = require('./app-context.cjs');
  const ssh = require('./ssh.cjs');
  const factory = () => createAiWorkspaceService({ client: createBuiltinClient(),
    evidence: createEvidenceAdapter({ getLogs: require('./log-analyzer.cjs').getAnalysisSnapshots,
      getSerial: require('./serial.cjs').snapshots, getSsh: ssh.getAnalysisSources, readSsh: ssh.readAnalysisTerminal,
      runAdb: require('./adb-runtime.cjs').runAdb }),
    membership: () => require('./vip.cjs').getStatusAsync(), saveTask: draft => require('./task-center.cjs').saveAiDraft(draft),
    confirmSave: async draft => {
      const answer = await require('./app-message-dialog.cjs').ask({ type: 'question', title: tr('保存 AI 测试任务'),
        message: draft.name, detail: tr('将创建包含 {0} 个步骤的新任务，不会自动执行。请在任务中心核对目标设备和操作后再运行。', { 0: draft.steps.length }),
        buttons: [tr('取消'), tr('保存到任务中心')], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1;
    } });
  registerHandlers(ipcMain, { getOwner: ctx.getMainWindow, factory });
}

function registerHandlers(ipcMain, { getOwner, factory }) {
  for (const method of ['sources', 'plan', 'collect', 'analyze', 'generateTask', 'saveTask', 'cancel', 'close']) {
    ipcMain.handle(`ai-workspace:${method}`, async (event, args) => {
      const owner = getOwner();
      if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
        return { ok: false, code: 'AI_OWNER', error: tr('仅允许在应用主窗口使用 AI 工作区。') };
      }
      let instance = instances.get(event.sender);
      if (!instance) {
        instance = factory(); instances.set(event.sender, instance);
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
function cleanup() { for (const instance of instances.values()) instance.dispose(); instances.clear(); }
module.exports = { register, registerHandlers, cleanup };
