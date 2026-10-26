const { tr, getLocale, onLocaleChanged } = require('./localization.cjs');
// 自动更新集成 - 使用 electron-updater 实现差分增量更新
// 开发模式下不启用自动更新（electron-updater 需要签名后的应用才能工作）
//
// 该模块管理 updaterStatus 状态缓存，并通过 sendUpdaterEvent 将事件转发到渲染进程

const { app, powerMonitor } = require('electron');
const { types } = require('node:util');
const { autoUpdater } = require('electron-updater');
const ctx = require('./app-context.cjs');
const { isDev } = ctx;
const { getAppVersion, compareVersions } = require('./version.cjs');
const { cleanupAndroidToolProcesses } = require('./android-tool-cleanup.cjs');
const { createUpdatePoller } = require('./update-poller.cjs');

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
  notAvailable: false,
  downloading: false,
  progress: null,        // { percent, transferred, total, bytesPerSecond }
  downloaded: false,
  error: null,
  info: null             // { version, releaseNotes, releaseName }
};
let quitAndInstallInProgress = false;
let updateInstallPrepared = false;
let checkFlight = null;
let downloadFlight = null;
let updatePoller = null;
let pollingDisposed = false;
let updateInstallLocale = getLocale();
const removeLocaleListener = onLocaleChanged(locale => { updateInstallLocale = locale; });

function prepareUpdateInstallLanguage() {
  if (process.platform !== 'win32' || isDev) return;
  if (['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'].includes(updateInstallLocale)) {
    process.env.VEYLO_UPDATE_LANGUAGE = updateInstallLocale;
  } else delete process.env.VEYLO_UPDATE_LANGUAGE;
}

// electron-updater's automatic quit handler also spawns NSIS from process.env.
// Prepend so the handoff is ready even when its own quit handler is already set.
app.prependListener('quit', () => {
  if (updaterStatus.downloaded) prepareUpdateInstallLanguage();
  removeLocaleListener();
});

// 自动更新事件转发到渲染进程（同时发送到主窗口 + Log Analyzer 窗口）
function sendUpdaterEvent(eventName, payload) {
  for (const window of [ctx.getMainWindow(), ctx.getLogAnalyzerWindow()]) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) continue;
    try { window.webContents.send('updater:event', { eventName, payload }); }
    catch { /* A renderer closing cannot invalidate a native update operation. */ }
  }
}

function fullUpdaterStatus() { return { ...updaterStatus, currentVersion: getAppVersion() }; }
function updateState(patch) {
  Object.assign(updaterStatus, patch);
  sendUpdaterEvent('state', fullUpdaterStatus());
}
function checkResultFromState() {
  if (updaterStatus.error && !updaterStatus.downloaded) return { success: false, error: updaterStatus.error };
  return { success: true, available: updaterStatus.available, notAvailable: updaterStatus.notAvailable, info: updaterStatus.info };
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
  let message = err?.message || String(err || tr("未知错误"));
  const cutMarkers = ['\n    at ', '\n at ', ', XML:', ' XML:', '<?xml', '<feed '];
  for (const marker of cutMarkers) {
    const index = message.indexOf(marker);
    if (index >= 0) message = message.slice(0, index);
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > 180) message = `${message.slice(0, 180)}...`;
  return message || tr("未知错误");
}

function formatUpdaterError(err) {
  const text = getErrorText(err);
  const statusCode = getUpdaterHttpStatus(err);

  if (/ERR_TIMED_OUT|ETIMEDOUT|Request timed out|net::ERR_TIMED_OUT/i.test(text)) {
    return tr("网络超时，请重试");
  }
  if (/net::ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i.test(text)) {
    return tr("网络不可用，请检查网络后重试");
  }
  if (/EAI_AGAIN|ENOTFOUND/i.test(text)) {
    return tr("网络解析失败，请检查网络后重试");
  }
  if (/ECONNRESET|ECONNABORTED|EPIPE|net::ERR_NETWORK_CHANGED|net::ERR_CONNECTION_(?:RESET|CLOSED|TIMED_OUT)/i.test(text)) {
    return tr("网络连接中断，请重试");
  }
  if (statusCode === 408) {
    return tr("网络超时，请重试");
  }
  if (statusCode === 429) {
    return tr("更新服务请求过于频繁，请稍后重试");
  }
  if (statusCode >= 500) {
    return tr("更新服务暂时不可用，请稍后重试");
  }
  if (statusCode === 403) {
    return tr("更新服务访问受限，请稍后重试或联系管理员");
  }
  if (statusCode === 404 || /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(text)) {
    return tr("未找到更新信息，请稍后重试或联系管理员");
  }
  if (/ERR_UPDATER_INVALID_SIGNATURE|ERR_UPDATER_NO_CHECKSUM|checksum|sha512|signature/i.test(text)) {
    return tr("更新包校验失败，请重新下载");
  }
  if (/ERR_UPDATER_INVALID_UPDATE_INFO|Cannot parse update info|Cannot parse releases feed/i.test(text)) {
    return tr("更新信息格式异常，请稍后重试或联系管理员");
  }
  if (/Unable to find latest version on GitHub|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(text)) {
    return tr("更新服务连接失败，请稍后重试");
  }
  return tr("更新失败，请稍后重试");
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
  prepareUpdateInstallLanguage();
  quitAndInstallInProgress = true;
  updateInstallPrepared = true;
  autoUpdater.quitAndInstall();
  return true;
}

// 绑定 autoUpdater 事件（在模块加载时绑定一次，与原 main.cjs 行为一致）
function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    if (updaterStatus.downloaded) return;
    updateState({ checking: true, available: false, notAvailable: false, error: null });
    sendUpdaterEvent('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    if (updaterStatus.downloaded) return;
    updateState({ checking: false, available: true, notAvailable: false, info, error: null });
    sendUpdaterEvent('update-available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    if (updaterStatus.downloaded) return;
    updateState({ checking: false, available: false, notAvailable: true, info, error: null });
    sendUpdaterEvent('update-not-available', info);
  });

  autoUpdater.on('error', (err) => {
    updateState({ checking: false, downloading: false, error: formatUpdaterError(err) });
    sendUpdaterEvent('error', updaterStatus.error);
  });

  autoUpdater.on('download-progress', (progress) => {
    if (updaterStatus.downloaded) return;
    updateState({ downloading: true, progress: {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    } });
    sendUpdaterEvent('download-progress', updaterStatus.progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState({ checking: false, downloading: false, downloaded: true, available: true, notAvailable: false, info, error: null });
    sendUpdaterEvent('update-downloaded', info);
  });
}

// 在模块加载时立即绑定事件（保持与原 main.cjs 顶层绑定的行为一致）
setupAutoUpdater();

function checkForUpdates() {
  if (isDev) return Promise.resolve({ success: false, error: tr('开发模式不支持自动更新，请打包后使用') });
  if (updaterStatus.downloaded) return Promise.resolve(checkResultFromState());
  // Reuse the original check first: a download may itself be waiting for it.
  if (checkFlight) return checkFlight;
  if (downloadFlight) return downloadFlight.then(() => checkResultFromState());
  const flight = Promise.resolve().then(async () => {
    updateState({ checking: true, available: false, notAvailable: false, error: null });
    try {
      const result = await runUpdaterTaskWithRetry(tr('检查更新'), () => autoUpdater.checkForUpdates());
      if (updaterStatus.downloaded) return checkResultFromState();
      const info = result?.updateInfo || null;
      const available = Boolean(info && compareVersions(info.version, getAppVersion()) > 0 && result.isUpdateAvailable !== false);
      updateState({ checking: false, available, notAvailable: !available, info, error: null });
      return checkResultFromState();
    } catch (error) {
      updateState({ checking: false, error: formatUpdaterError(error) });
      return { success: false, error: updaterStatus.error };
    }
  }).finally(() => { if (checkFlight === flight) checkFlight = null; });
  checkFlight = flight;
  return flight;
}

function downloadUpdate() {
  if (isDev) return Promise.resolve({ success: false, error: tr('开发模式不支持自动更新') });
  if (updaterStatus.downloaded) return Promise.resolve({ success: true });
  if (downloadFlight) return downloadFlight;
  const pendingCheck = checkFlight;
  const flight = Promise.resolve().then(async () => {
    // Capture the existing check, never wait for a new check that might join this download.
    if (pendingCheck) {
      const result = await pendingCheck;
      if (!result.success) return result;
      if (!result.available) return { success: false, error: tr('当前暂无可下载的更新，请先检查更新') };
    }
    if (updaterStatus.downloaded) return { success: true };
    updateState({ checking: false, downloading: true, progress: null, error: null });
    try {
      await runUpdaterTaskWithRetry(tr('下载更新'), () => autoUpdater.downloadUpdate());
      updateState({ downloading: false, downloaded: true, available: true, notAvailable: false, error: null });
      return { success: true };
    } catch (error) {
      updateState({ downloading: false, error: formatUpdaterError(error) });
      return { success: false, error: updaterStatus.error };
    }
  }).finally(() => { if (downloadFlight === flight) downloadFlight = null; });
  downloadFlight = flight;
  return flight;
}

function configureAuto(event, value) {
  const main = ctx.getMainWindow();
  if (!main || main.isDestroyed() || main.webContents.isDestroyed() || !main.webContents.mainFrame
    || event?.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) {
    return { success: false, error: tr('请在主窗口设置自动更新') };
  }
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return { success: false, error: tr('自动更新设置无效') };
  const descriptor = Object.getOwnPropertyDescriptor(value, 'enabled');
  if (Reflect.ownKeys(value).length !== 1 || !descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') {
    return { success: false, error: tr('自动更新设置无效') };
  }
  if (pollingDisposed) return { success: false, error: tr('自动更新服务已停止') };
  updatePoller.setEnabled(descriptor.value);
  return { success: true, enabled: descriptor.value };
}

// 自动更新 IPC handlers
// electron-updater 打包后会自动读取 resources/app-update.yml 中的 publish 配置
// 无需手动检测 electron-builder.json（该文件打包后不存在于 asar 中）

function register(ipcMain) {
  if (!updatePoller) {
    updatePoller = createUpdatePoller({
      canRun: () => !isDev && !updaterStatus.downloaded && !quitAndInstallInProgress,
      run: async isCurrent => {
        const result = await checkForUpdates();
        if (result.success && result.available && isCurrent() && !updaterStatus.downloaded) await downloadUpdate();
      },
    });
    const wake = () => updatePoller.wake();
    powerMonitor.on('resume', wake);
    app.once('will-quit', () => { pollingDisposed = true; updatePoller.dispose(); powerMonitor.removeListener('resume', wake); });
  }
  ipcMain.handle('updater:configure-auto', configureAuto);
  ipcMain.handle('updater:check', checkForUpdates);
  ipcMain.handle('updater:download', downloadUpdate);

  // 安装更新（退出应用并安装）
  ipcMain.handle('updater:install', async () => {
    if (updaterStatus.downloaded) {
      app.quit();
      return { success: true };
    }
    return { success: false, error: tr("更新尚未下载完成") };
  });

  // 获取当前更新状态
  ipcMain.handle('updater:status', async () => {
    return fullUpdaterStatus();
  });
}

module.exports = {
  register,
  prepareForUpdateInstall,
  shouldInstallDownloadedUpdateOnQuit,
  isQuitAndInstallInProgress,
  quitAndInstallPreparedUpdate
};
