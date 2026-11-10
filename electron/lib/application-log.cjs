const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { createApplicationLogSession } = require('./application-log-session.cjs');
const { classifyApplicationError } = require('./application-log-policy.cjs');

async function writeApplicationLogExport(file, text, { io = fs.promises } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw Error('Invalid export path');
  const lookup = () => io.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const stat = await lookup();
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw Error('Unsafe export destination');
  const temporary = path.join(path.dirname(file), `.veylo-app-log-${randomUUID()}.tmp`);
  const handle = await io.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  let closed = false;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw Error('Unsafe export file');
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); closed = true;
    const written = await io.lstat(temporary), current = await lookup();
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1 || written.dev !== opened.dev || written.ino !== opened.ino
      || Boolean(stat) !== Boolean(current) || current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)) throw Error('Export destination changed');
    await io.rename(temporary, file);
  } finally {
    if (!closed) await handle.close().catch(() => {});
    await io.unlink(temporary).catch(() => {});
  }
}
function createApplicationLogController({ session, getOwner, showSaveDialog, writeExport = writeApplicationLogExport }) {
  let busy = false;
  function authorize(event) {
    const owner = getOwner();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || !owner.webContents.mainFrame
      || event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw Error('APP_LOG_OWNER');
    return owner;
  }
  const publicState = state => ({ ...state, error: state.error ? tr('应用日志写入失败，请检查磁盘空间和目录权限。') : '' });
  async function invoke(event, kind, value) {
    let locked = false;
    try {
      authorize(event); if (value !== undefined) throw Error('APP_LOG_INPUT');
      if (kind !== 'status') { if (busy) throw Error('APP_LOG_BUSY'); busy = true; locked = true; }
      let state = await session.status(); authorize(event);
      if (kind === 'start') state = await session.start();
      if (kind === 'stop') state = await session.stop();
      authorize(event);
      if (kind === 'export') {
        if (state.recording) throw Error('APP_LOG_RECORDING');
        if (!state.available) throw Error('APP_LOG_EMPTY');
        const result = await showSaveDialog(authorize(event), { title: tr('导出应用日志'),
          defaultPath: `Veylo-application-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
          filters: [{ name: tr('日志文件'), extensions: ['log'] }] });
        authorize(event);
        if (result.canceled || !result.filePath) return { success: true, cancelled: true, state: publicState(state) };
        const text = await session.text(); authorize(event);
        await writeExport(result.filePath, text); authorize(event);
      }
      return { success: kind === 'status' || kind === 'export' || !state.error, state: publicState(state),
        ...(state.error && ['start', 'stop'].includes(kind) ? { error: publicState(state).error } : {}) };
    } catch (error) {
      const messages = { APP_LOG_OWNER: tr('请在卓控台主窗口操作应用日志。'), APP_LOG_RECORDING: tr('请先停止应用日志记录。'), APP_LOG_EMPTY: tr('当前没有可导出的应用日志。') };
      return { success: false, error: messages[error.message] || tr('应用日志操作未完成，请重试。') };
    } finally { if (locked) busy = false; }
  }
  return { register(ipcMain) { for (const kind of ['status', 'start', 'stop', 'export']) ipcMain.handle('app-log:' + kind, (event, value) => invoke(event, kind, value)); } };
}
let session;
const removers = [];
function record(value) { return session?.record(value) || false; }
function observeWebContents(contents, recordEvent = record) {
  const onConsole = details => {
    if (!details || typeof details !== 'object' || !['warning', 'error'].includes(details.level)) return;
    recordEvent({ source: 'app', event: 'console', component: 'renderer', level: details.level === 'warning' ? 'warn' : 'error', ...classifyApplicationError(details.message) });
  };
  const onGone = (_event, details) => recordEvent({ source: 'app', event: 'renderer-gone', component: 'renderer', errorNumber: Math.abs(details?.exitCode || 0) });
  contents.on('console-message', onConsole); contents.on('render-process-gone', onGone);
}
function register(ipcMain) {
  const { app, dialog, webContents } = require('electron');
  const status = app.getGPUFeatureStatus?.() || {};
  session = createApplicationLogSession({ directory: path.join(app.getPath('userData'), 'application-logs'),
    metadata: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
      platform: process.platform, architecture: process.arch, osRelease: os.release(),
      acceleration: status.video_decode === 'enabled' ? 'enabled' : status.video_decode ? 'disabled' : 'unknown' } });
  const controller = createApplicationLogController({ session, getOwner: () => require('./app-context.cjs').getMainWindow(), showSaveDialog: (owner, options) => dialog.showSaveDialog(owner, options) });
  controller.register(ipcMain);
  for (const contents of webContents.getAllWebContents()) observeWebContents(contents);
  const onContents = (_event, contents) => observeWebContents(contents);
  const onUncaught = error => record({ source: 'app', event: 'failure', level: 'error', ...classifyApplicationError(error) });
  app.on('web-contents-created', onContents); process.on('uncaughtExceptionMonitor', onUncaught);
  removers.push(() => app.removeListener('web-contents-created', onContents), () => process.removeListener('uncaughtExceptionMonitor', onUncaught));
  const { autoUpdater } = require('electron-updater');
  for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
    const listener = payload => record({ source: 'updater', event: name,
      ...(name === 'error' ? classifyApplicationError(payload) : {}),
      ...(name === 'download-progress' ? { percent: payload?.percent } : {}) });
    autoUpdater.on(name, listener); removers.push(() => autoUpdater.removeListener(name, listener));
  }
}
module.exports = { createApplicationLogController, writeApplicationLogExport, observeWebContents, register, record,
  async cleanup() { for (const remove of removers.splice(0)) remove(); await session?.dispose(); } };
