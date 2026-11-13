const { tr, getLocale, onLocaleChanged } = require('./localization.cjs');
// 自动更新集成 - 使用 electron-updater 实现差分增量更新
// 开发模式下不启用自动更新（electron-updater 需要签名后的应用才能工作）
//
// 该模块管理 updaterStatus 状态缓存，并通过 sendUpdaterEvent 将事件转发到渲染进程

const { app, powerMonitor } = require('electron');
const { types } = require('node:util');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const ctx = require('./app-context.cjs');
const { isDev } = ctx;
const { getAppVersion, compareVersions } = require('./version.cjs');
const { cleanupAndroidToolProcesses } = require('./android-tool-cleanup.cjs');
const { createUpdatePoller } = require('./update-poller.cjs');
const { launchUpdateInstaller } = require('./update-installer-launch.cjs');
const feedback = require('./feedback.cjs');

const UPDATER_MAX_RETRIES = 2;
const UPDATER_RETRY_DELAYS_MS = [2000, 5000];
const UPDATER_MAX_ATTEMPTS = UPDATER_MAX_RETRIES + 1;
const UPDATER_REQUEST_HEADERS = {
  'User-Agent': `adb-workbench/${getAppVersion()} (${process.platform}; ${process.arch})`,
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache'
};

autoUpdater.autoDownload = false;  // 不自动下载，由用户点击或自动检查逻辑触发
autoUpdater.autoInstallOnAppQuit = process.platform !== 'win32'; // Windows uses the acknowledged application-owned handoff.
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
  installing: false,
  refreshing: false,
  error: null,
  info: null             // { version, releaseNotes, releaseName }
};
let quitAndInstallInProgress = false;
let updateInstallPrepared = false;
let installLaunchFlight = null;
let installerReady = false;
let checkFlight = null;
let downloadFlight = null;
let refreshFlight = null;
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
function prepareUpdateInstallIdentity() {
  const supported = process.platform === 'win32' && !isDev && Number.isSafeInteger(process.pid) && process.pid > 0
    && typeof process.execPath === 'string' && path.isAbsolute(process.execPath);
  if (supported) {
    process.env.VEYLO_UPDATE_PID = String(process.pid);
    process.env.VEYLO_UPDATE_EXE = process.execPath;
  } else {
    delete process.env.VEYLO_UPDATE_PID;
    delete process.env.VEYLO_UPDATE_EXE;
  }
}

// electron-updater's automatic quit handler also spawns NSIS from process.env.
// Prepend so the handoff is ready even when its own quit handler is already set.
app.prependListener('quit', () => {
  if (updaterStatus.downloaded) { prepareUpdateInstallLanguage(); prepareUpdateInstallIdentity(); }
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
  const result = await cleanupAndroidToolProcesses({
    includeScrcpy: true,
    includeFastboot: true,
    includeHdc: true
  });
  if (result?.ok !== true) throw new Error('UPDATE_TOOL_CLEANUP_FAILED');
  updateInstallPrepared = true;
}

function shouldInstallDownloadedUpdateOnQuit() {
  return updaterStatus.downloaded && !refreshFlight && !quitAndInstallInProgress;
}

function isQuitAndInstallInProgress() {
  return quitAndInstallInProgress;
}

function recordInstall(installPhase, result = {}) {
  feedback.record({ module: 'updater', operation: 'install', installPhase, installCode: result.code,
    installerPid: result.installerPid, level: installPhase === 'failed' ? 'error' : 'info',
    outcome: installPhase === 'failed' ? result.code === 'UAC_CANCELLED' ? 'cancelled' : 'failure' : installPhase === 'launching' ? 'started' : 'success' });
}

function installerFailureMessage(code) {
  if (code === 'UAC_CANCELLED') return tr('已取消权限确认，应用将继续运行。');
  if (['READY_TIMEOUT', 'HELPER_TIMEOUT'].includes(code)) return tr('等待安装器超时，应用将继续运行。');
  if (code === 'CHECKSUM_MISMATCH') return tr('更新包校验失败，请重新下载');
  return tr('安装器未能就绪，应用将继续运行。');
}

function beginUpdateInstall() {
  if (refreshFlight) return Promise.resolve({ ok: false, code: 'START_FAILED', error: tr('正在检查更新…') });
  if (!updaterStatus.downloaded) return Promise.resolve({ ok: false, code: 'INVALID_INSTALLER', error: tr('更新尚未下载完成') });
  if (installerReady) return Promise.resolve({ ok: true, code: 'READY' });
  if (installLaunchFlight) return installLaunchFlight;
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, code: 'READY' });
  const flight = Promise.resolve().then(async () => {
    updateState({ installing: true, error: null }); recordInstall('launching');
    let result;
    try {
      result = await launchUpdateInstaller({ installerPath: autoUpdater.installerPath, parentPid: process.pid,
        locale: updateInstallLocale, sha512: autoUpdater.downloadedUpdateHelper?.downloadedFileInfo?.sha512 });
    } catch { result = { ok: false, code: 'START_FAILED' }; }
    if (result?.ok === true && result.code === 'READY') {
      installerReady = true; recordInstall('ready', result); return result;
    }
    const code = typeof result?.code === 'string' ? result.code : 'PROTOCOL_ERROR';
    recordInstall('failed', { code });
    quitAndInstallInProgress = false; installerReady = false; updateInstallPrepared = false;
    const invalidPackage = ['CHECKSUM_MISMATCH', 'INVALID_INSTALLER'].includes(code);
    if (invalidPackage) { try { await autoUpdater.downloadedUpdateHelper?.clear?.(); } catch { /* The next explicit download can retry cache cleanup. */ } }
    const error = installerFailureMessage(code); updateState({ installing: false, error, ...(invalidPackage ? { downloaded: false } : {}) });
    return { ok: false, code, error };
  }).finally(() => { if (installLaunchFlight === flight) installLaunchFlight = null; });
  installLaunchFlight = flight;
  return flight;
}

function noteUpdateInstallQuitting() { if (installerReady) recordInstall('quitting', { code: 'READY' }); }

function quitAndInstallPreparedUpdate() {
  if (!updaterStatus.downloaded || refreshFlight) return false;
  if (process.platform === 'win32') {
    if (!installerReady) return false;
    quitAndInstallInProgress = true;
    app.quit();
    return true;
  }
  prepareUpdateInstallLanguage();
  prepareUpdateInstallIdentity();
  quitAndInstallInProgress = true;
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

function checkForUpdates({ refreshReady = false } = {}) {
  if (isDev) return Promise.resolve({ success: false, error: tr('开发模式不支持自动更新，请打包后使用') });
  if (updaterStatus.downloaded && !refreshReady) return Promise.resolve(checkResultFromState());
  // Reuse the original check first: a download may itself be waiting for it.
  if (checkFlight) return checkFlight;
  if (downloadFlight) return downloadFlight.then(() => checkResultFromState());
  const flight = Promise.resolve().then(async () => {
    const keepReady = refreshReady && updaterStatus.downloaded;
    updateState(keepReady ? { checking: true, error: null } : { checking: true, available: false, notAvailable: false, error: null });
    try {
      const result = await runUpdaterTaskWithRetry(tr('检查更新'), () => autoUpdater.checkForUpdates());
      if (updaterStatus.downloaded && !keepReady) return checkResultFromState();
      const info = result?.updateInfo || null;
      const available = Boolean(info && compareVersions(info.version, getAppVersion()) > 0 && result.isUpdateAvailable !== false);
      if (keepReady) {
        updateState({ checking: false, error: null });
        return { success: true, available, notAvailable: !available, info };
      }
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

function installHandoffActive() {
  return Boolean(installLaunchFlight || installerReady || quitAndInstallInProgress || pollingDisposed);
}

function handoffBusyResult() {
  return { success: false, error: tr('正在启动安装器…') };
}

async function refreshDownloadedUpdate(cachedVersion, pendingDownload) {
  if (pendingDownload) await pendingDownload;
  if (installHandoffActive()) return handoffBusyResult();
  const checked = await checkForUpdates({ refreshReady: true });
  if (!checked.success) return checked;
  if (installHandoffActive()) return handoffBusyResult();
  const info = checked.info;
  if (!checked.available || typeof cachedVersion !== 'string' || typeof info?.version !== 'string'
    || compareVersions(info.version, cachedVersion) <= 0) return checkResultFromState();
  updateInstallPrepared = false;
  updateState({ checking: false, downloaded: false, available: true, notAvailable: false, info, progress: null, error: null });
  // The check's finally has completed. Never start a download inside its own check flight.
  const downloaded = await downloadUpdate();
  return downloaded.success ? checkResultFromState() : downloaded;
}

function manualCheckForUpdates() {
  if (installHandoffActive()) return Promise.resolve(handoffBusyResult());
  if (refreshFlight) return refreshFlight;
  if (isDev || !updaterStatus.downloaded) return checkForUpdates();
  const cachedVersion = updaterStatus.info?.version, pendingDownload = downloadFlight;
  const flight = Promise.resolve().then(() => refreshDownloadedUpdate(cachedVersion, pendingDownload))
    .catch(error => {
      const message = formatUpdaterError(error); updateState({ checking: false, error: message });
      return { success: false, error: message };
    }).finally(() => {
      if (refreshFlight === flight) { refreshFlight = null; updateState({ refreshing: false, checking: false }); }
    });
  refreshFlight = flight;
  updateState({ refreshing: true, checking: true, error: null });
  return flight;
}

function manualDownloadUpdate() {
  if (installHandoffActive()) return Promise.resolve(handoffBusyResult());
  return refreshFlight || downloadUpdate();
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
      canRun: () => !isDev && !updaterStatus.downloaded && !refreshFlight && !quitAndInstallInProgress,
      run: async isCurrent => {
        if (refreshFlight) return refreshFlight;
        const result = await checkForUpdates();
        if (result.success && result.available && isCurrent() && !updaterStatus.downloaded) await downloadUpdate();
      },
    });
    const wake = () => updatePoller.wake();
    powerMonitor.on('resume', wake);
    app.once('will-quit', () => { pollingDisposed = true; updatePoller.dispose(); powerMonitor.removeListener('resume', wake); });
  }
  ipcMain.handle('updater:configure-auto', configureAuto);
  ipcMain.handle('updater:check', manualCheckForUpdates);
  ipcMain.handle('updater:download', manualDownloadUpdate);

  // 安装更新（退出应用并安装）
  ipcMain.handle('updater:install', async () => {
    if (refreshFlight) return { success: false, error: tr('正在检查更新…') };
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
  beginUpdateInstall,
  noteUpdateInstallQuitting,
  shouldInstallDownloadedUpdateOnQuit,
  isQuitAndInstallInProgress,
  quitAndInstallPreparedUpdate
};
