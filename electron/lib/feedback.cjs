const path = require('node:path');
const { exact, fail } = require('./feedback-policy.cjs');
const { createFeedbackService } = require('./feedback-service.cjs');
const { createFeedbackGithub } = require('./feedback-github.cjs');
const { createAppDiagnostics } = require('./app-diagnostics.cjs');
const { createAppDiagnosticLog } = require('./app-diagnostic-log.cjs');
const { createDiagnosticIpc } = require('./app-diagnostic-observer.cjs');

function createFeedbackController({ service, auth, logger, getOwner }) {
  let disposed = false; let errorListener; let channelHost;
  const channels = ['context', 'auth-start', 'auth-status', 'auth-cancel', 'auth-logout', 'preview', 'submit', 'open-issue'];
  function authorize(event) {
    const owner = getOwner();
    if (disposed || !owner || owner.isDestroyed() || owner.webContents.isDestroyed() || !owner.webContents.mainFrame
      || event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw fail('FEEDBACK_OWNER', '请在卓控台主窗口进行问题上报');
    return true;
  }
  const guardFor = event => () => authorize(event);
  async function invoke(event, kind, value) {
    try {
      const guard = guardFor(event); guard();
      if (!['preview', 'submit', 'open-issue'].includes(kind) && value !== undefined && !exact(value, [])) throw fail('FEEDBACK_INPUT', '此操作不接受额外参数');
      let result;
      if (kind === 'context') result = await service.context(guard);
      else if (kind === 'preview') result = await service.preview(value, guard);
      else if (kind === 'submit') result = await service.submit(value, guard);
      else if (kind === 'open-issue') result = await service.openIssue(value, guard);
      else {
        const method = { 'auth-start': 'start', 'auth-status': 'status', 'auth-cancel': 'cancel', 'auth-logout': 'logout' }[kind];
        result = { auth: await auth[method](guard) };
      }
      guard(); return { ok: true, ...result };
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('FEEDBACK_');
      return { ok: false, error: { code: known ? error.code : 'FEEDBACK_FAILED', message: known ? error.message : '问题上报操作未完成，请重试' }, ...(error?.uncertain === true ? { uncertain: true } : {}) };
    }
  }
  return {
    register(ipcMain) {
      channelHost = ipcMain;
      for (const kind of channels) ipcMain.handle(`feedback:${kind}`, (event, value) => invoke(event, kind, value));
      errorListener = event => { try { authorize(event); logger.record({ level: 'error', module: 'renderer', operation: 'renderer-error', outcome: 'failure', errorCode: 'UNKNOWN' }); } catch { /* Foreign frames cannot add diagnostic records. */ } };
      ipcMain.on('feedback:renderer-error', errorListener);
    },
    async dispose() {
      disposed = true; service.dispose(); await auth.dispose();
      if (channelHost && errorListener) channelHost.removeListener('feedback:renderer-error', errorListener);
      await logger.dispose();
    },
  };
}
let controller; let logger;
function register(ipcMain) {
  const { app, screen, safeStorage, shell } = require('electron');
  const { createFeedbackAuth } = require('./feedback-auth.cjs');
  const { clientId } = require('../feedback-config.json');
  logger = createAppDiagnosticLog({ directory: path.join(app.getPath('userData'), 'diagnostics'), version: app.getVersion() });
  const github = createFeedbackGithub();
  const auth = createFeedbackAuth({ clientId, directory: path.join(app.getPath('userData'), 'feedback'), github,
    canEncrypt: () => safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes), openExternal: url => shell.openExternal(url) });
  const service = createFeedbackService({ diagnostics: createAppDiagnostics({ app, screen }), logger, auth, github, openExternal: url => shell.openExternal(url) });
  controller = createFeedbackController({ service, auth, logger, getOwner: () => require('./app-context.cjs').getMainWindow() });
  controller.register(ipcMain);
}
module.exports = { createFeedbackController, register,
  observedIpc: ipcMain => logger ? createDiagnosticIpc(ipcMain, logger) : ipcMain,
  record: event => logger?.record(event), cleanup: () => controller?.dispose(),
};
