const { tr } = require('./localization.cjs');
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const ctx = require('./app-context.cjs');
const core = require('./data-migration-core.cjs');
const archive = require('./data-migration-archive.cjs');
const v2 = require('./data-migration-v2.cjs');
const { readSafe, atomicReplace } = require('./ai-tools-file-safety.cjs');

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
  let selection = null;
  let busy = false;
  let restarting = false;
  const directory = () => app.getPath('userData');
  const authorize = event => {
    const owner = ctx.getMainWindow();
    if (!owner || owner.isDestroyed?.() || !owner.webContents?.mainFrame || event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error(tr("请从主窗口的偏好设置进行数据迁移"));
  };
  const action = (channel, operation, exclusive = true) => ipcMain.handle(channel, async (event, args) => {
    let locked = false;
    try {
      authorize(event);
      if (exclusive) {
        if (busy || restarting) throw new Error(tr("正在处理数据迁移，请稍候"));
        busy = true; locked = true;
      }
      return { ok: true, ...await operation(event, args || {}) };
    } catch (error) {
      return { ok: false, error: error.message, recoveryPath: startupState?.recoveryPath };
    } finally {
      if (locked) busy = false;
    }
  });

  action('migration:export', async (event, { preferences, password, includeAiSessions = true }) => {
    v2.assertPassword(password);
    if (typeof includeAiSessions !== 'boolean') throw new Error(tr("请选择是否包含 AI 会话"));
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, {
      title: tr("导出卓控台数据"), defaultPath: path.join(app.getPath('downloads'), tr("卓控台数据-{0}.adbbackup", { 0: new Date().toISOString().slice(0, 10) })),
      filters: [{ name: tr("卓控台数据备份"), extensions: ['adbbackup'] }]
    });
    authorize(event);
    if (result.canceled || !result.filePath) return { cancelled: true };
    const target = path.resolve(result.filePath);
    if (path.extname(target).toLowerCase() !== '.adbbackup') throw new Error(tr("请使用 .adbbackup 文件扩展名"));
    const parent = await fs.promises.realpath(path.dirname(target));
    const dataRoot = await fs.promises.realpath(directory());
    const relative = path.relative(dataRoot, parent);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(tr("请将备份保存到桌面、文档或其他应用数据目录之外的位置"));
    }
    const previous = readSafe(target, fs, v2.MAX_ARCHIVE_BYTES);
    const legacy = core.readArchive(await core.createArchive(directory(), preferences || {}, app.getVersion()));
    const migration = require('./ai-tools.cjs').createMigrationService();
    try {
      const ai = await migration.exportState({ includeSessions: includeAiSessions }); authorize(event);
      const bytes = await v2.encode({ payload: legacy.payload, ai }, password); authorize(event);
      atomicReplace(target, bytes, previous.hash, fs, v2.MAX_ARCHIVE_BYTES);
      return { path: target, summary: summaryOf({ ...legacy.summary, ...migration.getExportSummary(ai), encrypted: true, archiveBytes: bytes.length }) };
    } finally { migration.dispose?.(); }
  });

  action('migration:preview', async (event, { password, selectionToken } = {}) => {
    preview = null;
    if (selectionToken) {
      if (!selection || selection.token !== selectionToken || selection.sender !== event.sender || selection.frame !== event.senderFrame || selection.expiresAt < Date.now()) throw new Error(tr("备份文件选择已过期，请重新选择文件"));
    } else {
      selection = null;
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: tr("选择卓控台数据备份"), properties: ['openFile'], filters: [{ name: tr("卓控台数据备份"), extensions: ['adbbackup'] }]
      });
      authorize(event);
      if (result.canceled || !result.filePaths?.[0]) return { cancelled: true };
      const selected = readSafe(result.filePaths[0], fs, v2.MAX_ARCHIVE_BYTES);
      if (!selected.bytes) throw new Error(tr("备份文件不存在"));
      selection = { token: randomUUID(), path: selected.path, hash: selected.hash, sender: event.sender, frame: event.senderFrame, expiresAt: Date.now() + 300000 };
    }
    const currentSelection = selection;
    const selected = readSafe(currentSelection.path, fs, v2.MAX_ARCHIVE_BYTES);
    if (!selected.bytes || selected.hash !== currentSelection.hash) throw new Error(tr("备份文件已变化，请重新选择文件"));
    if (v2.isEncrypted(selected.bytes) && (password === undefined || password === '')) return { passwordRequired: true, selectionToken: currentSelection.token, fileName: path.basename(selected.path) };
    let payload; let summary; let aiPlan = null;
    if (v2.isEncrypted(selected.bytes)) {
      const decoded = await v2.decode(selected.bytes, password); authorize(event);
      ({ payload, summary } = archive.validatePayload(decoded.payload));
      const migration = require('./ai-tools.cjs').createMigrationService();
      try {
        aiPlan = await migration.previewImport(decoded.ai); authorize(event);
        const metadata = migration.getExportSummary(decoded.ai);
        summary = { ...summary, encrypted: true, ai: aiPlan.summary, includesAiSessions: metadata.includesAiSessions, warnings: aiPlan.warnings };
      } finally { migration.dispose?.(); }
    } else {
      ({ payload, summary } = core.readArchive(selected.bytes));
      summary = { ...summary, encrypted: false, includesAiSessions: false };
    }
    authorize(event);
    if (readSafe(currentSelection.path, fs, v2.MAX_ARCHIVE_BYTES).hash !== currentSelection.hash) throw new Error(tr("备份文件已变化，请重新选择文件"));
    preview = { token: randomUUID(), payload, aiPlan, sender: event.sender, frame: event.senderFrame, selection: currentSelection, expiresAt: Date.now() + 300000 };
    selection = null;
    return { token: preview.token, summary: summaryOf({ ...summary, archiveBytes: selected.bytes.length }) };
  });

  action('migration:import', async (event, { token, preferences, confirmed }) => {
    if (confirmed !== true) throw new Error(tr("请先确认覆盖同名数据并重启应用"));
    if (require('./screen-recording.cjs').listUnresolved().length) throw new Error(tr("请先停止录屏并保存待恢复的录屏，再导入数据"));
    if (!preview || preview.token !== token || preview.sender !== event.sender || preview.frame !== event.senderFrame || preview.expiresAt < Date.now()) throw new Error(tr("备份预览已失效，请重新选择备份文件"));
    const pendingPreview = preview;
    if (readSafe(pendingPreview.selection.path, fs, v2.MAX_ARCHIVE_BYTES).hash !== pendingPreview.selection.hash) throw new Error(tr("备份文件已变化，请重新选择"));
    const releaseSerialReservation = require('./serial.cjs').reserveForMigration();
    let releaseSshReservation;
    let releaseAiReservation;
    let staged;
    try {
      releaseSshReservation = require('./ssh.cjs').reserveForMigration();
      releaseAiReservation = await require('./ai-tools.cjs').reserveForMigration(); authorize(event);
      staged = await core.stageImport(directory(), pendingPreview.payload, preferences || {}, { aiWrites: pendingPreview.aiPlan?.writes || [], aiGuards: pendingPreview.aiPlan?.guards || [] });
    }
    catch (error) { releaseSerialReservation(); releaseSshReservation?.(); releaseAiReservation?.(); throw error; }
    preview = null;
    restarting = true;
    restartRequested = true;
    // Only stage now. Existing writers finish during normal quit; replacement happens before the next startup UI.
    try { restart(); }
    catch (error) {
      restarting = false;
      throw new Error(tr("导入已准备完成，但自动重启失败。请手动关闭并重新打开卓控台：{0}", { 0: error.message }));
    }
    return { id: staged.id, restarting: true };
  });

  action('migration:bootstrap', async () => ({ ...(startupState || { status: 'none' }) }), false);
  action('migration:acknowledge', async (_event, { id }) => {
    if (!startupState || startupState.id !== id) throw new Error(tr("迁移状态已变化，请重新启动应用"));
    await core.finalizeStartupImport(directory(), id);
    startupState = { id, status: startupState.status === 'applied' ? 'completed' : startupState.status, recoveryPath: startupState.recoveryPath, error: startupState.error };
    return startupState;
  });
  action('migration:rollback', async (_event, { id }) => {
    if (!startupState || startupState.id !== id) throw new Error(tr("迁移状态已变化，不能恢复未知备份"));
    startupState = await core.rollbackStartupImport(directory(), id);
    return startupState;
  });
}

function summaryOf(summary) { return { ...summary, bytes: summary.bytes ?? summary.totalBytes }; }

module.exports = { register, hasPendingImport, prepareStartup, isRestartRequested: () => restartRequested };
