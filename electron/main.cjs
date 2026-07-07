// 瘦入口：app 生命周期 + createWindow + 注册所有领域模块
// 各领域逻辑已拆分到 electron/lib/ 下的模块中

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ctx = require('./lib/app-context.cjs');
const { isDev } = ctx;

const version = require('./lib/version.cjs');
const updater = require('./lib/updater.cjs');
const adb = require('./lib/adb.cjs');
const window = require('./lib/window.cjs');
const settings = require('./lib/settings.cjs');
const history = require('./lib/history.cjs');
const logAnalyzer = require('./lib/log-analyzer.cjs');
const mcp = require('./lib/mcp-server.cjs');
const autoDiagnose = require('./lib/auto-diagnose.cjs');
const aiAnalyze = require('./lib/ai-analyze.cjs');
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
const environmentCheck = require('./lib/environment-check.cjs');
const { cleanupAndroidToolProcesses } = require('./lib/android-tool-cleanup.cjs');

// 单实例锁定 - 确保只有一个应用实例在运行
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Quitting...');
  app.exit(0);
} else {
  // 当第二个实例尝试启动时，聚焦到第一个实例的窗口
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('Second instance tried to launch');
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
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
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '../icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Prevent navigation
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  ctx.setMainWindow(mainWindow);
}

app.whenReady().then(() => {
  if (!gotTheLock) return;

  // 检测版本升级：必须在 createWindow() 之前执行。
  // 因为 createWindow() 会立即加载页面，渲染进程会马上调用 app:checkChangelog
  // 查询 pendingChangelog；如果此时还没设置标志位，弹窗就会丢失。
  version.cleanupPendingUpdater();
  version.checkVersionAndNotifyChangelog();

  // 注册所有领域模块的 IPC handlers
  // 顺序无依赖（每个模块独立注册自己的 ipcMain.handle/on）
  version.register(ipcMain);
  updater.register(ipcMain);
  adb.register(ipcMain);
  window.register(ipcMain);
  settings.register(ipcMain);
  history.register(ipcMain);
  logAnalyzer.register(ipcMain);
  mcp.register(ipcMain);
  autoDiagnose.register(ipcMain);
  aiAnalyze.register(ipcMain);
  smartSearch.register(ipcMain);
  vip.register(ipcMain);
  // 注册设备巡检报告、App 包管理与性能监控模块
  inspection.register(ipcMain);
  troubleshooting.register(ipcMain);
  packageManager.register(ipcMain);
  performanceMonitor.register(ipcMain);
  taskCenter.register(ipcMain);
  artifactCenter.register(ipcMain);
  environmentCheck.register(ipcMain);

  vip.preload();

  createWindow();
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
  // 清理 AI 相关资源
  aiAnalyze.resetAiState();
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
  // 终止终端中未结束的 shell 命令（如挂起的 su）
  adb.stopAllShellProcs();
}

async function cleanupBeforeQuit({ forUpdateInstall = false } = {}) {
  cleanupRuntimeResources();
  // 停止所有录屏进程（如果有）
  if (adb.hasActiveScreenRecords()) {
    await adb.stopAllScreenRecords();
  }
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
  const shouldInstallUpdate = updater.shouldInstallDownloadedUpdateOnQuit();
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
