const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const ctx = require('./app-context.cjs');
const core = require('./data-migration-core.cjs');

let startupState = null;
let restartRequested = false;

function hasPendingImport() { return core.hasPendingImport(app.getPath('userData')); }
async function prepareStartup() {
  startupState = await core.applyPendingImport(app.getPath('userData'));
}

function register(ipcMain, { restart = () => {
  app.relaunch();
  setTimeout(() => app.quit(), 300);
} } = {}) {
  let preview = null;
  let busy = false;
  let restarting = false;
  const directory = () => app.getPath('userData');
  const authorize = event => {
    if (event.sender !== ctx.getMainWindow()?.webContents) throw new Error('请从主窗口的偏好设置进行数据迁移');
  };
  const action = (channel, operation, exclusive = true) => ipcMain.handle(channel, async (event, args) => {
    let locked = false;
    try {
      authorize(event);
      if (exclusive) {
        if (busy || restarting) throw new Error('正在处理数据迁移，请稍候');
        busy = true; locked = true;
      }
      return { ok: true, ...await operation(event, args || {}) };
    } catch (error) {
      return { ok: false, error: error.message, recoveryPath: startupState?.recoveryPath };
    } finally {
      if (locked) busy = false;
    }
  });

  action('migration:export', async (event, { preferences }) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, {
      title: '导出卓控台数据', defaultPath: path.join(app.getPath('downloads'), `卓控台数据-${new Date().toISOString().slice(0, 10)}.adbbackup`),
      filters: [{ name: '卓控台数据备份', extensions: ['adbbackup'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    const target = path.resolve(result.filePath);
    if (path.extname(target).toLowerCase() !== '.adbbackup') throw new Error('请使用 .adbbackup 文件扩展名');
    const parent = await fs.promises.realpath(path.dirname(target));
    const dataRoot = await fs.promises.realpath(directory());
    const relative = path.relative(dataRoot, parent);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('请将备份保存到桌面、文档或其他应用数据目录之外的位置');
    }
    const previous = await fs.promises.lstat(target).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink > 1)) throw new Error('保存位置必须是普通文件，不能是链接');
    const bytes = await core.createArchive(directory(), preferences || {}, app.getVersion());
    const temporary = path.join(parent, `.adb-export-${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.promises.rename(temporary, path.join(parent, path.basename(target)));
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
    return { path: target, summary: summaryOf(core.readArchive(bytes).summary) };
  });

  action('migration:preview', async event => {
    preview = null;
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '选择卓控台数据备份', properties: ['openFile'], filters: [{ name: '卓控台数据备份', extensions: ['adbbackup'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { cancelled: true };
    const selected = result.filePaths[0];
    const stat = await fs.promises.lstat(selected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) throw new Error('备份文件无效或超过 128 MB 限制');
    const { payload, summary } = core.readArchive(await fs.promises.readFile(selected));
    preview = { token: randomUUID(), payload, sender: event.sender };
    return { token: preview.token, summary: summaryOf(summary) };
  });

  action('migration:import', async (event, { token, preferences, confirmed }) => {
    if (confirmed !== true) throw new Error('请先确认覆盖同名数据并重启应用');
    if (require('./screen-recording.cjs').listUnresolved().length) throw new Error('请先停止录屏并保存待恢复的录屏，再导入数据');
    if (!preview || preview.token !== token || preview.sender !== event.sender) throw new Error('备份预览已失效，请重新选择备份文件');
    const staged = await core.stageImport(directory(), preview.payload, preferences || {});
    preview = null;
    restarting = true;
    restartRequested = true;
    // Only stage now. Existing writers finish during normal quit; replacement happens before the next startup UI.
    try { restart(); }
    catch (error) {
      restarting = false;
      throw new Error(`导入已准备完成，但自动重启失败。请手动关闭并重新打开卓控台：${error.message}`);
    }
    return { id: staged.id, restarting: true };
  });

  action('migration:bootstrap', async () => ({ ...(startupState || { status: 'none' }) }), false);
  action('migration:acknowledge', async (_event, { id }) => {
    if (!startupState || startupState.id !== id) throw new Error('迁移状态已变化，请重新启动应用');
    await core.finalizeStartupImport(directory(), id);
    startupState = { id, status: startupState.status === 'applied' ? 'completed' : startupState.status, recoveryPath: startupState.recoveryPath, error: startupState.error };
    return startupState;
  });
  action('migration:rollback', async (_event, { id }) => {
    if (!startupState || startupState.id !== id) throw new Error('迁移状态已变化，不能恢复未知备份');
    startupState = await core.rollbackStartupImport(directory(), id);
    return startupState;
  });
}

function summaryOf(summary) { return { ...summary, bytes: summary.bytes ?? summary.totalBytes }; }

module.exports = { register, hasPendingImport, prepareStartup, isRestartRequested: () => restartRequested };
