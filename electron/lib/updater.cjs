// 自动更新集成 - 使用 electron-updater 实现差分增量更新
// 开发模式下不启用自动更新（electron-updater 需要签名后的应用才能工作）
//
// 该模块管理 updaterStatus 状态缓存，并通过 sendUpdaterEvent 将事件转发到渲染进程

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const ctx = require('./app-context.cjs');
const { isDev } = ctx;
const { getAppVersion, compareVersions } = require('./version.cjs');
const { cleanupAndroidToolProcesses } = require('./android-tool-cleanup.cjs');

const UPDATER_MAX_RETRIES = 2;
const UPDATER_RETRY_DELAYS_MS = [2000, 5000];
const UPDATER_MAX_ATTEMPTS = UPDATER_MAX_RETRIES + 1;
const UPDATER_REQUEST_HEADERS = {
  'User-Agent': `adb-workbench/${getAppVersion()} (${process.platform}; ${process.arch})`,
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache'
};

autoUpdater.autoDownload = false;  // 不自动下载，由用户点击或自动检查逻辑触发
autoUpdater.autoInstallOnAppQuit = true;  // 下载完成后退出应用时自动安装
autoUpdater.logger = console;  // 启用日志，便于排查更新问题
autoUpdater.requestHeaders = {
  ...(autoUpdater.requestHeaders || {}),
  ...UPDATER_REQUEST_HEADERS
};

// 自动更新事件状态缓存（供渲染进程查询）
let updaterStatus = {
  checking: false,
  available: false,
  downloading: false,
  progress: null,        // { percent, transferred, total, bytesPerSecond }
  downloaded: false,
  error: null,
  info: null             // { version, releaseNotes, releaseName }
};
let quitAndInstallInProgress = false;
let updateInstallPrepared = false;

// 自动更新事件转发到渲染进程（同时发送到主窗口 + Log Analyzer 窗口）
function sendUpdaterEvent(eventName, payload) {
  const mainWindow = ctx.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:event', { eventName, payload });
  }
  const logAnalyzerWindow = ctx.getLogAnalyzerWindow();
  if (logAnalyzerWindow && !logAnalyzerWindow.isDestroyed()) {
    logAnalyzerWindow.webContents.send('updater:event', { eventName, payload });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorText(err) {
  if (!err) return '';
  return [err.code, err.message, err.stack]
    .filter(Boolean)
    .join('\n') || String(err);
}

function isRetriableUpdaterError(err) {
  const statusCode = getUpdaterHttpStatus(err);
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return true;

  const text = getErrorText(err);
  return /(?:ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|Request timed out|net::ERR_(?:TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_(?:RESET|CLOSED|TIMED_OUT))|HTTP_ERROR_(?:408|429|5\d\d)|status (?:408|429|5\d\d))/i.test(text);
}

function getUpdaterHttpStatus(err) {
  const directStatusCode = Number(err?.statusCode);
  if (Number.isFinite(directStatusCode)) return directStatusCode;

  const text = getErrorText(err);
  const match = text.match(/(?:HTTP_ERROR_|status |statusCode[^\d]*|HTTP error:\s*)(\d{3})/i);
  return match ? Number(match[1]) : NaN;
}

function compactUpdaterError(err) {
  let message = err?.message || String(err || '未知错误');
  const cutMarkers = ['\n    at ', '\n at ', ', XML:', ' XML:', '<?xml', '<feed '];
  for (const marker of cutMarkers) {
    const index = message.indexOf(marker);
    if (index >= 0) message = message.slice(0, index);
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > 180) message = `${message.slice(0, 180)}...`;
  return message || '未知错误';
}

function formatUpdaterError(err) {
  const text = getErrorText(err);
  const statusCode = getUpdaterHttpStatus(err);

  if (/ERR_TIMED_OUT|ETIMEDOUT|Request timed out|net::ERR_TIMED_OUT/i.test(text)) {
    return '网络超时，请重试';
  }
  if (/net::ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i.test(text)) {
    return '网络不可用，请检查网络后重试';
  }
  if (/EAI_AGAIN|ENOTFOUND/i.test(text)) {
    return '网络解析失败，请检查网络后重试';
  }
  if (/ECONNRESET|ECONNABORTED|EPIPE|net::ERR_NETWORK_CHANGED|net::ERR_CONNECTION_(?:RESET|CLOSED|TIMED_OUT)/i.test(text)) {
    return '网络连接中断，请重试';
  }
  if (statusCode === 408) {
    return '网络超时，请重试';
  }
  if (statusCode === 429) {
    return '更新服务请求过于频繁，请稍后重试';
  }
  if (statusCode >= 500) {
    return '更新服务暂时不可用，请稍后重试';
  }
  if (statusCode === 403) {
    return '更新服务访问受限，请稍后重试或联系管理员';
  }
  if (statusCode === 404 || /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(text)) {
    return '未找到更新信息，请稍后重试或联系管理员';
  }
  if (/ERR_UPDATER_INVALID_SIGNATURE|ERR_UPDATER_NO_CHECKSUM|checksum|sha512|signature/i.test(text)) {
    return '更新包校验失败，请重新下载';
  }
  if (/ERR_UPDATER_INVALID_UPDATE_INFO|Cannot parse update info|Cannot parse releases feed/i.test(text)) {
    return '更新信息格式异常，请稍后重试或联系管理员';
  }
  if (/Unable to find latest version on GitHub|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(text)) {
    return '更新服务连接失败，请稍后重试';
  }
  return '更新失败，请稍后重试';
}

async function runUpdaterTaskWithRetry(action, task) {
  let lastError = null;
  for (let attempt = 1; attempt <= UPDATER_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[Updater] ${action}重试 ${attempt}/${UPDATER_MAX_ATTEMPTS}`);
      }
      return await task();
    } catch (err) {
      lastError = err;
      const canRetry = attempt <= UPDATER_MAX_RETRIES && isRetriableUpdaterError(err);
      if (!canRetry) throw err;

      const delayMs = UPDATER_RETRY_DELAYS_MS[attempt - 1] || UPDATER_RETRY_DELAYS_MS[UPDATER_RETRY_DELAYS_MS.length - 1];
      console.warn(`[Updater] ${action}失败，${delayMs}ms 后重试 (${attempt}/${UPDATER_MAX_ATTEMPTS}): ${compactUpdaterError(err)}`);
      sendUpdaterEvent('retry', {
        action,
        attempt: attempt + 1,
        maxAttempts: UPDATER_MAX_ATTEMPTS,
        error: compactUpdaterError(err)
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function prepareForUpdateInstall() {
  if (updateInstallPrepared) return;
  await cleanupAndroidToolProcesses({
    includeScrcpy: true,
    includeFastboot: true
  });
  updateInstallPrepared = true;
}

function shouldInstallDownloadedUpdateOnQuit() {
  return updaterStatus.downloaded && !quitAndInstallInProgress;
}

function isQuitAndInstallInProgress() {
  return quitAndInstallInProgress;
}

function quitAndInstallPreparedUpdate() {
  if (!updaterStatus.downloaded) return false;
  quitAndInstallInProgress = true;
  updateInstallPrepared = true;
  autoUpdater.quitAndInstall();
  return true;
}

// 绑定 autoUpdater 事件（在模块加载时绑定一次，与原 main.cjs 行为一致）
function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    updaterStatus.checking = true;
    updaterStatus.available = false;
    updaterStatus.error = null;
    sendUpdaterEvent('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    updaterStatus.checking = false;
    updaterStatus.available = true;
    updaterStatus.info = info;
    sendUpdaterEvent('update-available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    updaterStatus.checking = false;
    updaterStatus.available = false;
    updaterStatus.info = info;
    sendUpdaterEvent('update-not-available', info);
  });

  autoUpdater.on('error', (err) => {
    updaterStatus.checking = false;
    updaterStatus.downloading = false;
    updaterStatus.error = formatUpdaterError(err);
    sendUpdaterEvent('error', updaterStatus.error);
  });

  autoUpdater.on('download-progress', (progress) => {
    updaterStatus.progress = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    };
    sendUpdaterEvent('download-progress', updaterStatus.progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updaterStatus.downloading = false;
    updaterStatus.downloaded = true;
    updaterStatus.info = info;
    sendUpdaterEvent('update-downloaded', info);
  });
}

// 在模块加载时立即绑定事件（保持与原 main.cjs 顶层绑定的行为一致）
setupAutoUpdater();

// 自动更新 IPC handlers
// electron-updater 打包后会自动读取 resources/app-update.yml 中的 publish 配置
// 无需手动检测 electron-builder.json（该文件打包后不存在于 asar 中）

function register(ipcMain) {
  // 检查更新（手动触发）
  // 直接使用 checkForUpdates() 返回值判断，不依赖事件监听器
  // 事件仍会触发并通过 sendUpdaterEvent 转发，用于 UI 状态同步
  ipcMain.handle('updater:check', async () => {
    if (isDev) {
      return { success: false, error: '开发模式不支持自动更新，请打包后使用' };
    }
    try {
      console.log('[Updater] 开始检查更新...');
      const result = await runUpdaterTaskWithRetry('检查更新', () => autoUpdater.checkForUpdates());
      console.log('[Updater] checkForUpdates 返回:', result ? `有更新 v${result.updateInfo?.version}` : '无更新');
      if (result && result.updateInfo) {
        // 比较版本号：如果服务器版本高于当前版本，则有更新
        const currentVersion = getAppVersion();
        const serverVersion = result.updateInfo.version;
        const hasUpdate = compareVersions(serverVersion, currentVersion) > 0;
        console.log(`[Updater] 当前: ${currentVersion}, 服务器: ${serverVersion}, 有更新: ${hasUpdate}`);
        return {
          success: true,
          available: hasUpdate,
          notAvailable: !hasUpdate,
          info: result.updateInfo
        };
      }
      // result 为 null，表示没有更新
      return { success: true, available: false, notAvailable: true, info: null };
    } catch (err) {
      console.error('[Updater] 检查更新失败:', err);
      return { success: false, error: formatUpdaterError(err) };
    }
  });

  // 下载更新
  ipcMain.handle('updater:download', async () => {
    if (isDev) {
      return { success: false, error: '开发模式不支持自动更新' };
    }
    try {
      console.log('[Updater] 开始下载更新...');
      updaterStatus.downloading = true;
      updaterStatus.downloaded = false;
      await runUpdaterTaskWithRetry('下载更新', () => autoUpdater.downloadUpdate());
      console.log('[Updater] 下载完成');
      return { success: true };
    } catch (err) {
      console.error('[Updater] 下载失败:', err);
      updaterStatus.downloading = false;
      return { success: false, error: formatUpdaterError(err) };
    }
  });

  // 安装更新（退出应用并安装）
  ipcMain.handle('updater:install', async () => {
    if (updaterStatus.downloaded) {
      app.quit();
      return { success: true };
    }
    return { success: false, error: '更新尚未下载完成' };
  });

  // 获取当前更新状态
  ipcMain.handle('updater:status', async () => {
    return { ...updaterStatus, currentVersion: getAppVersion() };
  });
}

module.exports = {
  register,
  prepareForUpdateInstall,
  shouldInstallDownloadedUpdateOnQuit,
  isQuitAndInstallInProgress,
  quitAndInstallPreparedUpdate
};
