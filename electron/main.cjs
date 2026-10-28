// 瘦入口：app 生命周期 + createWindow + 注册所有领域模块
// 各领域逻辑已拆分到 electron/lib/ 下的模块中

const { app, BrowserWindow, ipcMain, dialog, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

configureUserDataPath();

const ctx = require('./lib/app-context.cjs');
const { isDev } = ctx;

const version = require('./lib/version.cjs');
const updater = require('./lib/updater.cjs');
const adb = require('./lib/adb.cjs');
const window = require('./lib/window.cjs');
const settings = require('./lib/settings.cjs');
const localization = require('./lib/localization.cjs');
const { tr } = localization;
const { installApplicationMenu } = require('./lib/application-menu.cjs');
const history = require('./lib/history.cjs');
const logAnalyzer = require('./lib/log-analyzer.cjs');
const mcp = require('./lib/mcp-server.cjs');
const autoDiagnose = require('./lib/auto-diagnose.cjs');
const aiAnalyze = require('./lib/ai-analyze.cjs');
const aiWorkspace = require('./lib/ai-workspace.cjs');
const aiHandoff = require('./lib/ai-analysis-handoff.cjs');
const aiOutbound = require('./lib/ai-outbound-transport.cjs');
const workbenchActivity = require('./lib/workbench-activity.cjs');
const reproduction = require('./lib/reproduction.cjs');
const smartSearch = require('./lib/smart-search.cjs');
const vip = require('./lib/vip.cjs');
// 设备巡检报告与证据包导出 IPC 模块
const inspection = require('./lib/inspection.cjs');
const troubleshooting = require('./lib/troubleshooting.cjs');
// 管理增强：App 包管理与性能监控 IPC 模块
const packageManager = require('./lib/package-manager.cjs');
const performanceMonitor = require('./lib/performance-monitor.cjs');
const taskCenter = require('./lib/task-center.cjs');
const artifactCenter = require('./lib/artifact-center.cjs');
const dataMigration = require('./lib/data-migration.cjs');
const deviceMedia = require('./lib/device-media.cjs');
const screenRecording = require('./lib/screen-recording.cjs');
const shortcutCapabilities = require('./lib/device-shortcut-capabilities.cjs');
const serial = require('./lib/serial.cjs');
const ssh = require('./lib/ssh.cjs');
const aiTools = require('./lib/ai-tools.cjs');
const appMessageDialog = require('./lib/app-message-dialog.cjs');
const startupSettings = require('./lib/startup-settings.cjs');
const feedback = require('./lib/feedback.cjs');
const { createStartupPresentation } = require('./lib/startup-presentation.cjs');
const { attachWindowRenderContinuity } = require('./lib/window-render-continuity.cjs');
const { getMainWindowBounds } = require('./lib/main-window-bounds.cjs');
const { confirmSerialQuit } = require('./lib/serial-quit.cjs');
const { confirmRecordingQuit } = require('./lib/recording-quit.cjs');
const environmentCheck = require('./lib/environment-check.cjs');
const regressionReport = require('./lib/regression-report.cjs');
const acceptanceSuite = require('./lib/acceptance-suite.cjs');
const deviceGuard = require('./lib/device-guard.cjs');
const { cleanupAndroidToolProcesses } = require('./lib/android-tool-cleanup.cjs');

function configureUserDataPath() {
  const appDataDir = app.getPath('appData');
  const targetDir = path.join(appDataDir, 'adb-workbench');
  const legacyDirs = [
    path.join(appDataDir, 'AdbDeviceManagement'),
    path.join(appDataDir, 'ADB-device-management'),
    path.join(appDataDir, 'scrcpy-gui'),
    path.join(appDataDir, '卓控台')
  ];

  if (!fs.existsSync(targetDir)) {
    const sourceDir = legacyDirs.find(dir => fs.existsSync(dir) && dir !== targetDir);
    if (sourceDir) {
      try {
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false });
      } catch (error) {
        console.warn('[App] userData migration failed:', error);
      }
    }
  }

  app.setPath('userData', targetDir);
}

// 单实例锁定 - 确保只有一个应用实例在运行
const gotTheLock = app.requestSingleInstanceLock();
let startupPresentation = null;
let startupPresented = false;

if (!gotTheLock) {
  console.log('Another instance is already running. Quitting...');
  app.exit(0);
} else {
  // 当第二个实例尝试启动时，聚焦到第一个实例的窗口
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('Second instance tried to launch');
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      startupPresentation?.reveal();
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 主窗口创建（Log Analyzer 窗口的创建由 log-analyzer 模块负责）
function createWindow() {
  const presentStartup = !startupPresented;
  const mainWindow = new BrowserWindow({
    title: tr('卓控台'),
    ...getMainWindowBounds(screen.getPrimaryDisplay().workArea),
    autoHideMenuBar: true,
    show: !presentStartup,
    backgroundColor: '#081417',
    icon: path.join(__dirname, '../icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: localization.windowArguments(),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });
  attachWindowRenderContinuity(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('page-title-updated', event => event.preventDefault());
  const removeTitleListener = localization.onLocaleChanged(locale => {
    if (!mainWindow.isDestroyed()) mainWindow.setTitle(tr('卓控台', {}, locale));
  });
  mainWindow.once('closed', removeTitleListener);
  startupPresented = true;
  ctx.setMainWindow(mainWindow);
  const presentation = presentStartup ? createStartupPresentation({ BrowserWindow, ipcMain, screen, mainWindow }) : null;
  startupPresentation = presentation;
  mainWindow.on('closed', () => {
    presentation?.dispose();
    if (startupPresentation === presentation) startupPresentation = null;
  });
  mainWindow.webContents.on('render-process-gone', () => feedback.record({ level: 'error', module: 'renderer', operation: 'renderer-error', outcome: 'failure', errorCode: 'UNKNOWN' }));
  mainWindow.webContents.on('did-fail-load', () => feedback.record({ level: 'error', module: 'app', operation: 'failure', outcome: 'failure', errorCode: 'UNKNOWN' }));
  mainWindow.webContents.once('did-finish-load', () => feedback.record({ level: 'info', module: 'app', operation: 'ready', outcome: 'success' }));

  // Permit retrying the current document, but never navigate to another URL.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl || url !== currentUrl) event.preventDefault();
  });
  mainWindow.on('close', event => {
    if (!quitCleanupFinished && (screenRecording.listUnresolved().length || serial.needsQuitConfirmation() || ssh.needsQuitConfirmation())) {
      event.preventDefault();
      app.quit();
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173').catch(() => presentation?.reveal());
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).catch(() => presentation?.reveal());
  }
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;

  if (dataMigration.hasPendingImport()) {
    try { await dataMigration.prepareStartup(); }
    catch (error) {
      try { await localization.initialize(); } catch { /* Preserve the migration failure as the primary startup error. */ }
      dialog.showErrorBox(tr('数据迁移未完成'), tr('为保护现有数据，应用暂未启动。请保留数据目录中的恢复备份后重试。\n{0}', { 0: error.message }));
      app.exit(1);
      return;
    }
  }

  // 检测版本升级：必须在 createWindow() 之前执行。
  try { await localization.initialize(); }
  catch {
    // No renderer/profile storage may be created before the first-run marker is durable.
    dialog.showErrorBox(tr('语言设置保存失败，请重试'), tr('语言设置保存失败，原语言未改变。请重试。'));
    app.exit(1);
    return;
  }
  installApplicationMenu({ Menu, getMainWindow: ctx.getMainWindow, getLogAnalyzerWindow: ctx.getLogAnalyzerWindow });
  // 因为 createWindow() 会立即加载页面，渲染进程会马上调用 app:checkChangelog
  // 查询 pendingChangelog；如果此时还没设置标志位，弹窗就会丢失。
  version.cleanupPendingUpdater();
  version.checkVersionAndNotifyChangelog();

  // 注册所有领域模块的 IPC handlers
  // 顺序无依赖（每个模块独立注册自己的 ipcMain.handle/on）
  feedback.register(ipcMain);
  const diagnosticIpc = localization.scopeIpc(feedback.observedIpc(ipcMain));
  feedback.record({ level: 'info', module: 'app', operation: 'startup', outcome: 'success' });
  version.register(diagnosticIpc);
  updater.register(diagnosticIpc);
  adb.register(diagnosticIpc);
  window.register(diagnosticIpc);
  settings.register(diagnosticIpc);
  localization.register(diagnosticIpc);
  startupSettings.register(diagnosticIpc);
  history.register(diagnosticIpc);
  logAnalyzer.register(diagnosticIpc);
  mcp.register(diagnosticIpc);
  autoDiagnose.register(diagnosticIpc);
  aiAnalyze.register(diagnosticIpc);
  smartSearch.register(diagnosticIpc);
  vip.register(diagnosticIpc);
  // 注册设备巡检报告、App 包管理与性能监控模块
  inspection.register(diagnosticIpc);
  troubleshooting.register(diagnosticIpc);
  packageManager.register(diagnosticIpc);
  performanceMonitor.register(diagnosticIpc);
  taskCenter.register(diagnosticIpc);
  artifactCenter.register(diagnosticIpc);
  dataMigration.register(diagnosticIpc);
  deviceMedia.register(diagnosticIpc);
  shortcutCapabilities.register(diagnosticIpc);
  serial.register(diagnosticIpc);
  appMessageDialog.register(diagnosticIpc);
  ssh.register(diagnosticIpc);
  aiTools.register(diagnosticIpc);
  aiWorkspace.register(diagnosticIpc);
  aiHandoff.register(diagnosticIpc);
  aiOutbound.register(diagnosticIpc);
  workbenchActivity.register(diagnosticIpc);
  reproduction.register(diagnosticIpc);
  environmentCheck.register(diagnosticIpc);
  regressionReport.register(diagnosticIpc);
  acceptanceSuite.register(diagnosticIpc);
  deviceGuard.register(diagnosticIpc);

  vip.preload();

  createWindow();
  void startupSettings.initialize();
  mcp.initMcpServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

let quitCleanupRunning = false;
let quitCleanupFinished = false;

function cleanupRuntimeResources() {
  startupPresentation?.dispose();
  startupPresentation = null;
  startupSettings.cleanup();
  // 清理 AI 相关资源
  aiAnalyze.resetAiState();
  aiWorkspace.cleanup();
  aiHandoff.cleanup();
  aiOutbound.cleanup();
  workbenchActivity.cleanup();
  mcp.closeMcpServer();
  // 关闭 Log Analyzer 窗口（如有）
  const logWin = ctx.getLogAnalyzerWindow();
  if (logWin && !logWin.isDestroyed()) {
    logWin.destroy();
  }
  // 停止性能监控定时器，避免退出时仍有 ADB 采样任务。
  performanceMonitor.cleanup();
  // 取消任务中心仍在执行的复现脚本，避免退出后残留 ADB 子进程。
  taskCenter.cleanup();
  deviceGuard.cleanup();
  // 终止终端中未结束的 shell 命令（如挂起的 su）
  adb.stopAllShellProcs();
}

async function cleanupBeforeQuit({ forUpdateInstall = false } = {}) {
  // Quit is confirmed: late animation callbacks must not reveal a closing app.
  startupPresentation?.dispose();
  startupPresentation = null;
  appMessageDialog.cleanup();
  feedback.record({ level: 'info', module: 'app', operation: 'shutdown', outcome: 'success' });
  let feedbackCleanup;
  try { feedbackCleanup = Promise.resolve(feedback.cleanup()).catch(() => {}); }
  catch { feedbackCleanup = Promise.resolve(); }
  // Invalidate pending AI dialogs/CLI launches immediately after quit confirmation.
  const aiCleanup = aiTools.cleanup().catch(() => console.warn('[AI Tools] quit cleanup failed'));
  await reproduction.cleanup().catch(() => console.warn('[Reproduction] quit cleanup failed'));
  // Quit is already confirmed; keep other cleanup running even if a driver refuses to close.
  await serial.cleanup().catch(error => console.warn('[Serial] quit cleanup failed:', error.message));
  await ssh.cleanup().catch(() => console.warn('[SSH] quit cleanup failed'));
  await aiCleanup;
  cleanupRuntimeResources();
  // Flush optional diagnostic records without delaying device cleanup or waiting indefinitely on disk IO.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 1000);
    feedbackCleanup.then(() => { clearTimeout(timer); resolve(); });
  });
  if (forUpdateInstall) {
    await updater.prepareForUpdateInstall();
  } else {
    await cleanupAndroidToolProcesses();
  }
}

app.on('before-quit', async (event) => {
  if (quitCleanupFinished || updater.isQuitAndInstallInProgress()) return;
  event.preventDefault();
  if (quitCleanupRunning) return;

  quitCleanupRunning = true;
  try {
    const owner = ctx.getMainWindow();
    if ((!owner || owner.isDestroyed()) && (serial.needsQuitConfirmation() || ssh.needsQuitConfirmation() || screenRecording.listUnresolved().length || reproduction.hasActive())) {
      createWindow(); quitCleanupRunning = false; return;
    }
    const ask = options => appMessageDialog.ask(options);
    if (!await reproduction.confirmQuit(ask)) { quitCleanupRunning = false; return; }
    if (!await confirmSerialQuit({ serial, ask, save: () => serial.saveAll() })) { quitCleanupRunning = false; return; }
    if (!await ssh.confirmQuit(ask)) { quitCleanupRunning = false; return; }
    const proceed = await confirmRecordingQuit({ recordings: screenRecording, ask });
    if (!proceed) { quitCleanupRunning = false; return; }
  } catch (error) {
    quitCleanupRunning = false;
    await appMessageDialog.ask({ type: 'error', title: tr('未能完成退出前保存'), message: tr('应用尚未退出，请返回相关页面重试。'), detail: error.message,
      buttons: [tr('返回应用')], defaultId: 0, cancelId: 0 });
    return;
  }
  const shouldInstallUpdate = !dataMigration.isRestartRequested() && updater.shouldInstallDownloadedUpdateOnQuit();
  try {
    await cleanupBeforeQuit({ forUpdateInstall: shouldInstallUpdate });
  } catch (err) {
    console.warn('[App] before-quit cleanup failed:', err);
  } finally {
    quitCleanupFinished = true;
    quitCleanupRunning = false;
  }

  if (shouldInstallUpdate) {
    const started = updater.quitAndInstallPreparedUpdate();
    if (!started) app.quit();
    return;
  }
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
