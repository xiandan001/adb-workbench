const { tr, windowArguments, onLocaleChanged } = require('./localization.cjs');
// Android Log Analyzer 集成 - IPC 处理程序 + Log Analyzer 窗口生命周期
// 该模块管理：
//   - logcatProc / logStore / currentLogSource / pidPackageMap / logBatch 等
//   - createLogAnalyzerWindow()（窗口的 closed 事件需要清理本模块的内部状态）
// 与其他模块的依赖关系：
//   - 调用 auto-diagnose.autoDiagnoseOnLine / autoDiagnoseScanFile / resetAutoDiagnoseLastFire
//   - 被 mcp-server 通过 getter 读取 logStore / currentLogSource / logcatProc 等

const { dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const ctx = require('./app-context.cjs');
const { runAdb, spawnAdb } = require('./adb-runtime.cjs');
const { createLogCaptureBuffer } = require('./log-capture-buffer.cjs');
const { parseLogLine } = require('./log-line-parser.cjs');
const { createLogFileImporter, idleImportState } = require('./log-file-importer.cjs');
const { createBoundedLines } = require('./log-bounded-lines.cjs');
const { createLogArchive, normalizeArchiveOptions, emptyArchiveState, ownedArchiveDirectory } = require('./log-archive.cjs');
const { isHarmonyDevice, devicePlatform } = require('./device-platform.cjs');
const { buildHiLogArgs, spawnHiLog, clearHiLog } = require('./harmony-log.cjs');
const { isDev } = ctx;

let logcatProc = null;
let currentLogSource = 'realtime';
let currentLogDeviceId = '';
let currentLogSourceLabel = '';
let currentLogBuffers = [];
let currentLogBufferMode = 'device-default';
let realtimeLogDeviceId = '';
let captureSerial = 0;
let captureError = '';
let captureStarting = false;
let captureEpoch = 0;
let capturePreparing = null;
let finishCaptureLine = null;
let archiveSession = null;
let archiveState = emptyArchiveState();
let captureOmitted = { omittedLines: 0, omittedBytes: 0 };
const captureOperations = {};
let navigationContext = null;
function normalizeNavigationContext(context) {
  const { normalizePart } = require('./workbench-worksets-policy.cjs');
  const application = normalizePart('application', { deviceId: context.deviceId, packageName: typeof context.packageName === 'string' ? context.packageName : '' });
  const logs = context.worksetLogs ? normalizePart('logs', context.worksetLogs) : null;
  if (logs && logs.deviceId !== application.deviceId) throw new Error(tr('工作集数据无效，原文件已保留。'));
  return { ...application, ...(logs ? { worksetLogs: logs } : {}) };
}
let pkgResolverTimer = null;
let pidPackageMap = new Map();
// logStore 字节总量追踪：用于按字节限制内存占用（防止超大日志导致 OOM）
// - realtime: 实时日志字节总量上限 100MB
// - file: 文件日志字节总量追踪
const LOG_STORE_BYTES_LIMIT = 100 * 1024 * 1024; // 100MB
const LOG_STORE_REALTIME_MAX_ENTRIES = 200000;
const realtimeLogStore = createLogCaptureBuffer({ maxEntries: LOG_STORE_REALTIME_MAX_ENTRIES, maxBytes: LOG_STORE_BYTES_LIMIT });
let realtimeSourceTruncated = false;
const analysisSourceGeneration = { realtime: 0, file: 0 };
let fileLogEntries = [];
let fileLogTruncated = false;
let currentImportedPath = '';
let fileImporter = null;
let fileDialogTicket = 0;
function cancelPendingImport(reason) { fileDialogTicket++; fileImporter?.cancelCurrent(reason); }
const logStore = {
  get realtime() { return realtimeLogStore.toArray(); },
  set realtime(entries) {
    analysisSourceGeneration.realtime++;
    realtimeSourceTruncated = false; captureOmitted = { omittedLines: 0, omittedBytes: 0 };
    realtimeLogStore.clear();
    for (const entry of entries) realtimeLogStore.push(entry);
  },
  get file() { return fileLogEntries; },
  set file(entries) { analysisSourceGeneration.file++; fileLogEntries = entries; }
};
const logStoreBytes = { get realtime() { return realtimeLogStore.bytes; }, file: 0 };
function getSourceIdentity() { return JSON.stringify([currentLogSource, currentLogDeviceId, analysisSourceGeneration[currentLogSource]]); }

// 每 100ms 合并推送，突发积压只保留最新 50,000 条 / 100MB，并显式标记截断。
// 主进程另存最新 200,000 条 / 100MB；这不是完整日志的无损归档。
const LOG_BATCH_FLUSH_INTERVAL_MS = 100;
const pendingLogBatch = createLogCaptureBuffer({ maxEntries: 50000, maxBytes: LOG_STORE_BYTES_LIMIT });
let logBatchFlushTimer = null;

function entryBytes(entry) {
  return Buffer.byteLength(entry?.raw || '', 'utf8');
}

function clearLogBatchState() {
  if (logBatchFlushTimer) {
    clearTimeout(logBatchFlushTimer);
    logBatchFlushTimer = null;
  }
  pendingLogBatch.clear();
}

function resetLogStoreSource(source) {
  if (source === 'realtime') { analysisSourceGeneration.realtime++; realtimeLogStore.clear(); realtimeSourceTruncated = false; captureOmitted = { omittedLines: 0, omittedBytes: 0 }; }
  else {
    fileLogTruncated = false;
    logStore[source] = [];
    logStoreBytes[source] = 0;
  }
}

function appendRealtimeEntry(entry) {
  return realtimeLogStore.push(entry);
}
function sendRawToLogWindow(channel, payload) {
  const window = ctx.getLogAnalyzerWindow?.();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) return;
  try { window.webContents.send(channel, payload); }
  catch { /* The cache remains available when its owning renderer closes during delivery. */ }
}

function flushLogBatch() {
  clearLogBatchFlushTimer();
  if (pendingLogBatch.length === 0 && !pendingLogBatch.truncated) return;
  const batch = { source: 'realtime', captureId: String(captureSerial), deviceId: realtimeLogDeviceId, sourceIdentity: getSourceIdentity(),
    entries: pendingLogBatch.toArray(), truncated: pendingLogBatch.truncated || captureOmitted.omittedLines > 0 };
  pendingLogBatch.clear();
  sendRawToLogWindow('log:appendBatch', batch);
}

function scheduleLogBatchFlush() {
  if (logBatchFlushTimer) return;
  logBatchFlushTimer = setTimeout(() => {
    logBatchFlushTimer = null;
    flushLogBatch();
  }, LOG_BATCH_FLUSH_INTERVAL_MS);
}

function pushLogToBatch(entry) {
  pendingLogBatch.push(entry);
  scheduleLogBatchFlush();
}

function startPidPackageResolver(adbPathOrDeviceId, maybeDeviceId) {
  const deviceId = maybeDeviceId !== undefined
    ? maybeDeviceId
    : (adbPathOrDeviceId && adbPathOrDeviceId !== 'adb' ? adbPathOrDeviceId : '');
  stopPidPackageResolver();
  if (isHarmonyDevice(deviceId)) return;
  function refresh() {
    const args = [];
    if (deviceId) args.push('-s', deviceId);
    args.push('shell', 'ps -A -o PID=,NAME= 2>/dev/null || ps -o PID=,NAME=');
    runAdb(args, { timeoutMs: 10000 }).then((res) => {
      if (!res.ok) return;
      const lines = String(res.stdout || '').split(/\r?\n/).filter(Boolean);
      const newMap = new Map();
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (m) {
          const pid = Number(m[1]);
          const name = m[2].trim();
          if (pid > 0 && name) newMap.set(pid, name);
        }
      }
      pidPackageMap = newMap;
    });
  }
  refresh();
  pkgResolverTimer = setInterval(refresh, 30000);
}

function stopPidPackageResolver() {
  if (pkgResolverTimer) {
    clearInterval(pkgResolverTimer);
    pkgResolverTimer = null;
  }
  pidPackageMap.clear();
}

function resolvePkg(pid) {
  if (!pid) return '';
  return pidPackageMap.get(pid) ?? '';
}

// ============ Log Analyzer 窗口生命周期 ============

function createLogAnalyzerWindow() {
  if (require('./log-window-close.cjs').isQuitting?.()) throw new Error(tr('应用正在退出，请稍后重试。'));
  const { BrowserWindow } = require('electron');
  let logAnalyzerWindow = ctx.getLogAnalyzerWindow();
  const lifecycle = require('./log-window-lifecycle.cjs');
  if (logAnalyzerWindow && !logAnalyzerWindow.isDestroyed() && !logAnalyzerWindow.webContents.isDestroyed()) {
    const controller = lifecycle.getLogWindowLifecycle(logAnalyzerWindow);
    if (controller) controller.open();
    else { if (logAnalyzerWindow.isMinimized?.()) logAnalyzerWindow.restore(); logAnalyzerWindow.show?.(); logAnalyzerWindow.focus(); }
    return logAnalyzerWindow;
  }

  logAnalyzerWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    icon: path.join(__dirname, '../../icon.png'),
    title: tr('AI 日志助手'),
    backgroundColor: '#181818',
    webPreferences: {
      preload: path.join(__dirname, '../preload.cjs'),
      additionalArguments: windowArguments(),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  logAnalyzerWindow.setMenu(null);
  logAnalyzerWindow.on('page-title-updated', event => event.preventDefault());
  const stopLanguageUpdates = onLocaleChanged(locale => {
    if (!logAnalyzerWindow.isDestroyed()) logAnalyzerWindow.setTitle(tr('AI 日志助手', {}, locale));
  });
  logAnalyzerWindow.once('closed', stopLanguageUpdates);
  ctx.setLogAnalyzerWindow(logAnalyzerWindow);
  require('./log-window-close.cjs').attach(logAnalyzerWindow);

  lifecycle.attachLogWindowLifecycle(logAnalyzerWindow, {
    isCurrent: () => ctx.getLogAnalyzerWindow() === logAnalyzerWindow, getSourceIdentity,
    record: value => require('./application-log.cjs').record(value), focusReviewHost: () => {
      const main = ctx.getMainWindow?.();
      if (main && !main.isDestroyed()) { if (main.isMinimized?.()) main.restore(); main.show(); main.focus(); }
    },
    ask: options => require('./app-message-dialog.cjs').ask(options),
    load: () => isDev ? logAnalyzerWindow.loadURL('http://localhost:5173/log-analyzer.html') : logAnalyzerWindow.loadFile(path.join(__dirname, '../../dist/log-analyzer.html')),
  }).load();

  logAnalyzerWindow.on('closed', () => {
    if (ctx.getLogAnalyzerWindow() !== logAnalyzerWindow) return;
    captureEpoch++;
    cancelPendingImport('owner-lost');
    require('./auto-diagnose.cjs').resetAutoDiagnoseLastFire?.();
    finishCaptureLine?.();
    void archiveSession?.stop();
    // 停止 logcat 进程
    if (logcatProc) {
      try { logcatProc.kill(); } catch {}
      logcatProc = null;
    }
    // 停止 PID 包名解析器
    stopPidPackageResolver();
    clearLogBatchState();
    // 清空日志存储（释放大量内存）
    resetLogStoreSource('realtime');
    resetLogStoreSource('file');
    // 中止正在进行的 AI 分析并清空对话上下文
    const aiModule = require('./ai-analyze.cjs');
    aiModule.abortAiRequest();
    aiModule.clearAiConversation();
    ctx.setLogAnalyzerWindow(null);
  });

  return logAnalyzerWindow;
}

// ============ IPC handlers ============

function register(ipcMain) {
  for (const [channel, method] of [['startup:ready', 'ready'], ['startup:failed', 'failure']]) ipcMain.on?.(channel, event => {
    const owner = ctx.getLogAnalyzerWindow();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return;
    require('./log-window-lifecycle.cjs').getLogWindowLifecycle(owner)?.[method]();
  });
  const logOwner = event => {
    const windows = [ctx.getLogAnalyzerWindow?.(), ctx.getMainWindow?.()].filter(Boolean);
    if (!windows.some(window => !window.isDestroyed() && window.webContents === event?.sender && event.senderFrame === window.webContents.mainFrame)) {
      throw new Error(tr('请在应用日志窗口执行此操作。'));
    }
    return event.sender;
  };
  fileImporter = createLogFileImporter({
    onState: state => ctx.broadcastToAllWindows('log:import-state', state),
    onCommit(entries, stats) {
      if (require('./log-window-close.cjs').isQuitting?.()) throw new Error(tr('应用正在退出，请稍后重试。'));
      currentImportedPath = stats.filePath;
      currentLogSource = 'file'; currentLogDeviceId = ''; fileLogTruncated = stats.truncated;
      currentLogSourceLabel = path.basename(stats.filePath); currentLogBuffers = []; currentLogBufferMode = 'file';
      logStore.file = entries; logStoreBytes.file = stats.keptBytes;
      const limited = entries.slice(-50000);
      sendRawToLogWindow('log:reset', { source: 'file', requestId: stats.requestId, captureId: '', deviceId: '', reason: 'import-completed',
        sourceIdentity: getSourceIdentity(),
        buffers: [], bufferMode: 'file',
        sourceLabel: path.basename(stats.filePath), fileName: path.basename(stats.filePath), entries: limited,
        truncated: fileLogTruncated || entries.length > limited.length, import: stats });
      const generation = analysisSourceGeneration.file;
      setTimeout(() => {
        if (currentLogSource !== 'file' || analysisSourceGeneration.file !== generation) return;
        require('./auto-diagnose.cjs').autoDiagnoseScanFile(entries).catch(error => console.error('[AutoDiagnose]', error.message));
      }, 500);
    }
  });
  require('./log-sessions.cjs').register(ipcMain, {
    getDirectory: () => path.join(require('electron').app.getPath('userData'), 'log-analysis-sessions'),
    getSourceIdentity,
    getProtectedPaths: () => [...new Set([currentImportedPath, ...(fileImporter?.getProtectedPaths() || [])].filter(Boolean))],
    trashItem: file => require('electron').shell.trashItem(file),
    restore: (session) => {
      const aiModule = require('./ai-analyze.cjs');
      if (logcatProc || aiModule.hasActiveAiRequest()) throw new Error(tr("请先停止日志抓取和 AI 分析后再恢复会话"));
      cancelPendingImport('session-restored');
      clearLogBatchState();
      aiModule.clearAiConversation();
      currentLogSource = session.source;
      currentLogDeviceId = session.deviceId;
      currentLogSourceLabel = session.sourceLabel || (session.source === 'file' ? tr('日志文件') : tr('设备 {0}', { 0: session.deviceId }));
      currentLogBuffers = [...(session.buffers || [])]; currentLogBufferMode = session.source === 'file' ? 'file' : currentLogBuffers.length ? 'explicit' : 'device-default';
      if (session.source === 'realtime') realtimeLogDeviceId = session.deviceId;
      logStore[session.source] = session.entries;
      if (session.source === 'realtime') realtimeSourceTruncated = session.truncated === true;
      if (session.source === 'file') fileLogTruncated = session.truncated === true;
      if (session.source !== 'realtime') logStoreBytes[session.source] = session.entries.reduce((sum, entry) => sum + entryBytes(entry), 0);
      return { sourceIdentity: getSourceIdentity() };
    }
  });
  // ADB 设备列表（Log Analyzer 专用）
  ipcMain.handle('adb:listDevices', async () => {
    return (await require('./device-discovery.cjs').listDevices()).filter(device => device.status === 'device');
  });

  // 开始抓取日志
  const startCapture = async (_event, args) => {
    if (require('./log-window-close.cjs').isQuitting?.()) return { ok: false, error: tr('应用正在退出，请稍后重试。') };
    if (captureStarting) return { ok: false, error: tr('日志采集正在准备，请稍候。') };
    captureStarting = true;
    let resolvePreparing, operation = captureEpoch;
    capturePreparing = new Promise(resolve => { resolvePreparing = resolve; });
    try {
      // 延迟 require 以打破与 auto-diagnose 的循环依赖
      const autoDiagnose = require('./auto-diagnose.cjs');
      const captureDeviceId = args?.deviceId || '';
      const archiveOptions = normalizeArchiveOptions(args?.archive);
      const harmony = isHarmonyDevice(captureDeviceId);
      const wantedBuffers = Array.isArray(args?.buffers) ? args.buffers.filter(value => ['main', 'system', 'radio', 'events', 'crash', 'kernel'].includes(value)) : [];
      if (harmony) {
        require('./device-registry.cjs').resolveDeviceRef(captureDeviceId);
        if (args?.buffers?.length || args?.extraArgs?.length) throw new Error(tr('鸿蒙日志使用 HiLog 类型，不接受 Logcat 参数。'));
        buildHiLogArgs({ types: args?.types || [] });
      }
      operation = ++captureEpoch;
      cancelPendingImport('capture-started');

      if (logcatProc) {
        finishCaptureLine?.();
        const previous = logcatProc;
        logcatProc = null;
        try { previous.kill(); } catch {}
      }
      await archiveSession?.stop(); archiveSession = null;
      if (require('./log-window-close.cjs').isQuitting?.()) return { ok: false, error: tr('应用正在退出，请稍后重试。') };
      if (operation !== captureEpoch) return { ok: false, cancelled: true };
      const captureId = String(captureSerial + 1);
      let preparedArchive = null;
      if (archiveOptions.enabled) {
        preparedArchive = await createLogArchive({ directory: path.join(require('electron').app.getPath('userData'), 'log-archives'), captureId, options: archiveOptions,
          onState(state) { if (String(captureSerial) === captureId) { archiveState = state; ctx.broadcastToAllWindows('log:archive-state', state); } },
          onPressure(paused) { if (String(captureSerial) === captureId && logcatProc) { if (paused) logcatProc.stdout.pause(); else logcatProc.stdout.resume(); } } });
      }
      if (operation !== captureEpoch || require('./log-window-close.cjs').isQuitting?.()) { await preparedArchive?.stop(); return { ok: false, cancelled: true }; }
      archiveSession = preparedArchive; captureSerial++;
      currentLogSource = 'realtime'; currentLogDeviceId = captureDeviceId; realtimeLogDeviceId = captureDeviceId; captureError = '';
      currentLogSourceLabel = tr('设备 {0}', { 0: captureDeviceId }); currentLogBuffers = harmony ? [...(args?.types || [])] : [...wantedBuffers];
      currentLogBufferMode = currentLogBuffers.length ? 'explicit' : 'device-default';
      captureOmitted = { omittedLines: 0, omittedBytes: 0 };
      archiveState = preparedArchive?.info() || emptyArchiveState(captureId, archiveOptions.maxBytes);
      ctx.broadcastToAllWindows('log:archive-state', archiveState);
      clearLogBatchState();
      resetLogStoreSource('realtime');
      autoDiagnose.resetAutoDiagnoseLastFire?.();
      sendRawToLogWindow('log:reset', { source: 'realtime', captureId, deviceId: captureDeviceId,
        sourceIdentity: getSourceIdentity(),
        buffers: [...currentLogBuffers], bufferMode: currentLogBufferMode,
        sourceLabel: tr('设备 {0}', { 0: captureDeviceId }), reason: 'capture-started', entries: [], truncated: false });

      startPidPackageResolver(args?.deviceId);

      const adbArgs = [];
      if (args?.deviceId) adbArgs.push('-s', args.deviceId);
      adbArgs.push('logcat', '-v', 'threadtime');
      // 支持多缓冲区抓取：根据用户选择拼接 -b <buffer> 参数
      // 默认不传 -b（adb 默认 main/system/crash）
      // 用户显式选择时，按选择拼接
      if (wantedBuffers.length > 0) {
        wantedBuffers.forEach(b => adbArgs.push('-b', b));
      }
      // 兼容旧 extraArgs 参数（追加在 -b 之后）
      if (args?.extraArgs?.length) adbArgs.push(...args.extraArgs);

      const p = harmony ? spawnHiLog(captureDeviceId, { types: args?.types || [] }) : spawnAdb(adbArgs);
      logcatProc = p;
      let diagnostic = '', receivedHiLog = false;

      const ownedArchive = archiveSession;
      let chunkReceivedAt = Date.now();
      const parser = createBoundedLines(line => {
        if (logcatProc !== p) return;
        const entry = parseLogLine('realtime', line, { now: chunkReceivedAt, receivedAt: chunkReceivedAt });
        if (harmony && !receivedHiLog && /^\s*\[Fail\]/i.test(line)) { diagnostic = line.slice(0, 2000); p.kill(); return; }
        receivedHiLog ||= entry.logFormat === 'hilog';
        entry.deviceId = captureDeviceId;
        if (harmony) entry.platform = 'harmony';
        const pkg = resolvePkg(entry.pid);
        if (pkg) entry.pkg = pkg;
        const lineIndex = appendRealtimeEntry(entry);
        // 固定间隔合并发送，避免初次抓取积压日志造成 IPC 洪峰。
        pushLogToBatch(entry);
        // AI 自动诊断：检测崩溃/ANR/OOM 等关键问题
        if (lineIndex >= 0) autoDiagnose.autoDiagnoseOnLine(line, lineIndex, 'realtime', null, entry);
      });
      finishCaptureLine = () => { if (logcatProc === p) parser.end(); };
      p.stdout.on('data', data => {
        if (logcatProc !== p) return;
        chunkReceivedAt = Date.now();
        ownedArchive?.appendChunk(data); parser.push(data);
        const stats = parser.stats();
        if (stats.omittedLines !== captureOmitted.omittedLines) {
          captureOmitted = { omittedLines: stats.omittedLines, omittedBytes: stats.omittedBytes };
          ctx.broadcastToAllWindows('log:capture-state', { source: 'realtime', captureId, deviceId: captureDeviceId, running: true,
            sourceIdentity: getSourceIdentity(),
            ...captureOmitted, error: tr('部分超长日志未载入显示窗口，请查看归档状态。') });
        }
      });

      // 消费 stderr 防止缓冲区满导致进程挂起
      p.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });

      const stopped = error => {
        if (logcatProc !== p) return;
        parser.end();
        logcatProc = null;
        finishCaptureLine = null;
        void ownedArchive?.stop();
        captureError = error || diagnostic;
        stopPidPackageResolver();
        // 进程退出时 flush 剩余批次，避免日志丢失
        if (logBatchFlushTimer) {
          clearTimeout(logBatchFlushTimer);
          logBatchFlushTimer = null;
        }
        flushLogBatch();
        ctx.broadcastToAllWindows('log:capture-state', { source: 'realtime', captureId, deviceId: captureDeviceId, sourceIdentity: getSourceIdentity(), platform: devicePlatform(captureDeviceId), running: false, error: captureError });
      };
      p.on('error', error => stopped(error.message));
      p.on('exit', code => stopped(code ? diagnostic || tr('日志采集已退出（{0}）', { 0: code }) : ''));

      return { ok: true, captureId, platform: devicePlatform(captureDeviceId), archive: { ...archiveState }, buffers: [...currentLogBuffers], bufferMode: currentLogBufferMode, sourceIdentity: getSourceIdentity() };
    } catch (error) {
      if (operation === captureEpoch && !logcatProc) { stopPidPackageResolver(); await archiveSession?.stop(); }
      console.error('Failed to start logcat:', error);
      return { ok: false, error: error.message };
    } finally { captureStarting = false; capturePreparing = null; resolvePreparing(); }
  };
  captureOperations.start = args => startCapture(null, args);
  ipcMain.handle('adb:startLog', startCapture);

  // 停止抓取日志
  const stopCapture = async (_event, args) => {
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['captureId', 'deviceId', 'sourceIdentity'].includes(key))
      || Object.hasOwn(args, 'captureId') && args.captureId !== String(captureSerial)
      || Object.hasOwn(args, 'deviceId') && args.deviceId !== realtimeLogDeviceId
      || Object.hasOwn(args, 'sourceIdentity') && args.sourceIdentity !== getSourceIdentity())) {
      return { ok: false, error: tr('日志目标已变化，未停止其他采集。') };
    }
    captureEpoch++;
    const preparing = capturePreparing;
    finishCaptureLine?.();
    stopPidPackageResolver();
    // 停止抓取时 flush 剩余批次，避免日志丢失
    if (logBatchFlushTimer) {
      clearTimeout(logBatchFlushTimer);
      logBatchFlushTimer = null;
    }
    flushLogBatch();
    if (logcatProc) {
      const previous = logcatProc;
      logcatProc = null;
      finishCaptureLine = null;
      try { previous.kill(); } catch {}
    }
    await archiveSession?.stop();
    if (preparing) await preparing;
    return { ok: true };
  };
  captureOperations.stop = args => stopCapture(null, args);
  ipcMain.handle('adb:stopLog', stopCapture);

  // 清空日志
  const clearCapture = async (_event, args) => {
    try {
    const autoDiagnose = require('./auto-diagnose.cjs');
    const s = args?.source ?? currentLogSource;
    if (!['realtime', 'file'].includes(s)) throw new Error(tr('日志来源无效。'));
    if (!s || s === 'realtime') {
      const target = realtimeLogDeviceId || currentLogDeviceId;
      if (args?.deviceId && target && args.deviceId !== target) throw new Error(tr('日志目标已变化，未清理其他设备。'));
      clearLogBatchState();
    }
    cancelPendingImport('source-cleared');
    if (!s || s === 'realtime') resetLogStoreSource('realtime');
    if (!s || s === 'file') { resetLogStoreSource('file'); fileLogTruncated = false; }
    // 同步重置自动诊断去抖时间戳，避免下次抓取/加载时旧时间戳抑制告警
    autoDiagnose.resetAutoDiagnoseLastFire();
    sendRawToLogWindow('log:reset', { source: s, captureId: s === 'realtime' ? String(captureSerial) : '', deviceId: s === 'realtime' ? realtimeLogDeviceId : '',
      sourceIdentity: getSourceIdentity(),
      buffers: [...currentLogBuffers], bufferMode: currentLogBufferMode,
      requestId: s === 'file' ? fileImporter.getState().requestId : '', reason: 'cleared', entries: [], truncated: false });
    return { ok: true, sourceIdentity: getSourceIdentity() };
    } catch (error) { return { ok: false, error: error.message }; }
  };
  captureOperations.clear = args => clearCapture(null, args);
  ipcMain.handle('log:clear', clearCapture);
  ipcMain.handle('log:clearDevice', async (event, args) => {
    try {
      logOwner(event);
      const target = realtimeLogDeviceId;
      if (!args || Object.keys(args).sort().join(',') !== 'confirmed,deviceId' || args.confirmed !== true
        || !target || args.deviceId !== target) throw new Error(tr('请确认清理当前设备缓冲区；目标变化时不会清理其他设备。'));
      const result = isHarmonyDevice(target) ? await clearHiLog(target) : await runAdb(['-s', target, 'logcat', '-c'], { timeoutMs: 5000 });
      if (!result?.ok) throw new Error(result?.error || tr('设备日志清理失败，本机证据已保留。'));
      return { ok: true, deviceId: target };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  // 打开日志文件
  ipcMain.handle('log:openFile', async event => {
    try {
    if (require('./log-window-close.cjs').isQuitting?.()) throw new Error(tr('应用正在退出，请稍后重试。'));
    const owner = logOwner(event);
    if (logcatProc) throw new Error(tr('请先停止日志抓取，再导入文件；当前日志已保留。'));
    const ticket = ++fileDialogTicket;
    fileImporter.cancelCurrent('superseded');
    // 优先绑定到 Log 分析窗口，避免对话框弹出时隐藏子窗口
    const parentWin = (ctx.getLogAnalyzerWindow() && !ctx.getLogAnalyzerWindow().isDestroyed()) ? ctx.getLogAnalyzerWindow() : ctx.getMainWindow();
    if (!parentWin) return { ok: false };
    let navigated = false;
    const navigating = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) navigated = true; };
    owner.on('did-start-navigation', navigating);
    let res;
    try { res = await dialog.showOpenDialog(parentWin, {
      title: tr("选择日志文件"),
      properties: ['openFile'],
      filters: [
        { name: 'Log', extensions: ['log', 'txt'] },
        { name: 'All', extensions: ['*'] }
      ]
    }); } finally { owner.removeListener('did-start-navigation', navigating); }
    if (res.canceled || !res.filePaths[0]) return { ok: false, cancelled: true };
    const filePath = res.filePaths[0];
    if (navigated || ticket !== fileDialogTicket || owner.isDestroyed() || event.senderFrame !== owner.mainFrame || require('./log-window-close.cjs').isQuitting?.()) return { ok: false, cancelled: true };
    if (logcatProc) throw new Error(tr('请先停止日志抓取，再导入文件；当前日志已保留。'));
    return { ok: true, ...fileImporter.start(filePath, owner) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('log:cancelImport', async (event, args) => {
    try {
      const owner = logOwner(event);
      if (!args || Object.keys(args).join() !== 'requestId' || typeof args.requestId !== 'string') throw Error(tr('日志导入请求无效。'));
      return { ok: true, cancelled: fileImporter.cancel(args.requestId, owner) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('log:openArchiveDirectory', async event => {
    try {
      logOwner(event);
      const directory = await ownedArchiveDirectory(path.join(require('electron').app.getPath('userData'), 'log-archives'));
      const error = await require('electron').shell.openPath(directory);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  // 获取日志状态
  ipcMain.handle('log:getState', async () => {
    const entries = logStore[currentLogSource] || [];
    const limited = entries.length > 50000 ? entries.slice(entries.length - 50000) : entries;
    return { source: currentLogSource, deviceId: currentLogDeviceId, platform: devicePlatform(currentLogDeviceId), captureId: String(captureSerial), captureError, running: !!logcatProc,
      sourceIdentity: getSourceIdentity(),
      sourceLabel: currentLogSourceLabel, buffers: [...currentLogBuffers], bufferMode: currentLogBufferMode,
      import: fileImporter?.getState() || idleImportState(), entries: limited,
      archive: archiveSession?.info() || { ...archiveState }, capture: { ...captureOmitted },
      truncated: entries.length !== limited.length || (currentLogSource === 'realtime' ? realtimeSourceTruncated || realtimeLogStore.truncated || captureOmitted.omittedLines > 0 : fileLogTruncated) };
  });

  // 导出日志到文件
  ipcMain.handle('log:exportToFile', async (event, args) => {
    // 优先绑定到 Log 分析窗口，避免对话框弹出时隐藏子窗口
    const parentWin = (ctx.getLogAnalyzerWindow() && !ctx.getLogAnalyzerWindow().isDestroyed()) ? ctx.getLogAnalyzerWindow() : ctx.getMainWindow();
    if (!parentWin) return { ok: false };
    const result = await dialog.showSaveDialog(parentWin, {
      defaultPath: args?.defaultName ?? 'log_export.txt',
      filters: [{ name: tr("文本文件"), extensions: ['txt', 'log'] }, { name: tr("所有文件"), extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, args?.content ?? '', 'utf-8');
    return { ok: true, path: result.filePath };
  });

  // 主进程过滤（保留接口兼容性）
  ipcMain.handle('log:filterInMain', async (event, args) => {
    const { queryLogEntries } = require('./log-filter-client.cjs');
    const source = args?.source ?? currentLogSource;
    if (!['realtime', 'file'].includes(source)) throw Error(tr('日志来源无效。'));
    const offset = args?.offset ?? 0;
    const limit = args?.limit ?? 1000;
    const sourceIdentity = getSourceIdentity();
    const result = await queryLogEntries(logStore[source] || [], args?.filter ?? {}, { offset, limit, owner: event?.sender });
    return { ...result, sourceIdentity };
  });

  ipcMain.handle('logAnalyzer:open', async (_event, context) => {
    if (context && typeof context.deviceId === 'string') {
      navigationContext = normalizeNavigationContext(context);
    }
    const window = createLogAnalyzerWindow();
    if (context && navigationContext && !window.webContents.isLoading()) {
      window.webContents.send('logAnalyzer:context', navigationContext);
    }
    return { ok: true };
  });
  ipcMain.handle('logAnalyzer:getContext', async () => navigationContext);
  ipcMain.handle('logAnalyzer:applyContext', async (event, context) => {
    const main = ctx.getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) return { ok: false, error: tr('只允许在应用窗口管理工作集。') };
    try {
      navigationContext = normalizeNavigationContext(context);
      const window = ctx.getLogAnalyzerWindow();
      if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send('logAnalyzer:context', navigationContext);
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle('logAnalyzer:close', async () => {
    const logAnalyzerWindow = ctx.getLogAnalyzerWindow();
    if (logAnalyzerWindow && !logAnalyzerWindow.isDestroyed()) {
      logAnalyzerWindow.close();
    }
    return { ok: true };
  });

  ipcMain.handle('logAnalyzer:isAlive', async () => {
    const logAnalyzerWindow = ctx.getLogAnalyzerWindow();
    return !!(logAnalyzerWindow && !logAnalyzerWindow.isDestroyed());
  });
}

// ============ 供 MCP 读取日志状态的 getter ============

function getLogStore() { return logStore; }
function getCurrentLogSource() { return currentLogSource; }
function getLogcatProc() { return logcatProc; }
function setLogcatProc(proc) { logcatProc = proc; }
function setCurrentLogSource(source, deviceId = '') {
  currentLogSource = source;
  currentLogDeviceId = deviceId;
  currentLogSourceLabel = source === 'file' ? tr('日志文件') : deviceId ? tr('设备 {0}', { 0: deviceId }) : '';
  if (source === 'realtime') realtimeLogDeviceId = deviceId;
}
function resetLogStoreRealtime() {
  clearLogBatchState();
  resetLogStoreSource('realtime');
}
function getLogStoreBytes() { return logStoreBytes; }
function getLogStoreBytesLimit() { return LOG_STORE_BYTES_LIMIT; }

// MCP capture_start / capture_stop 也用到这些工具
function getPushLogToBatch() { return pushLogToBatch; }
function getFlushLogBatch() { return flushLogBatch; }
function getScheduleLogBatchFlush() { return scheduleLogBatchFlush; }
function getLogBatchFlushTimerRef() { return () => logBatchFlushTimer; }
function setLogBatchFlushTimer(val) { logBatchFlushTimer = val; }
function clearLogBatchFlushTimer() {
  if (logBatchFlushTimer) {
    clearTimeout(logBatchFlushTimer);
    logBatchFlushTimer = null;
  }
}

// 供 MCP 复用的解析/PID 工具
function getParseLogLine() { return parseLogLine; }
function getStartPidPackageResolver() { return startPidPackageResolver; }
function getStopPidPackageResolver() { return stopPidPackageResolver; }
function getResolvePkg() { return resolvePkg; }

// 给 MCP 直接修改 logStore.file（log_clear 工具）
function clearLogStoreBySource(source) {
  if (!source || source === 'realtime') {
    clearLogBatchState();
    resetLogStoreSource('realtime');
  }
  if (!source || source === 'file') {
    resetLogStoreSource('file');
  }
}
function setLogStoreFileEntries(entries) {
  logStore.file = entries;
  logStoreBytes.file = entries.reduce((sum, e) => sum + Buffer.byteLength(e.raw || '', 'utf8'), 0);
}

module.exports = {
  reviewFailedLogWindowForQuit: () => {
    const owner = ctx.getLogAnalyzerWindow(), controller = owner && require('./log-window-lifecycle.cjs').getLogWindowLifecycle(owner);
    return controller?.failed() ? controller.review() : Promise.resolve(true);
  },
  getSourceIdentity,
  hasCaptureActivity: () => Boolean(logcatProc || captureStarting || archiveSession?.info().status === 'recording' || archiveSession?.info().pendingBytes),
  getArchiveState: () => archiveSession?.info() || { ...archiveState },
  startLogCapture: args => captureOperations.start?.(args) || Promise.resolve({ ok: false, error: tr('日志服务尚未就绪。') }),
  stopLogCapture: args => captureOperations.stop?.(args) || Promise.resolve({ ok: false, error: tr('日志服务尚未就绪。') }),
  clearLogs: args => captureOperations.clear?.(args) || Promise.resolve({ ok: false, error: tr('日志服务尚未就绪。') }),
  // Local AI preview only: metadata stays bound to the retained source.
  getAnalysisSnapshots: () => ['realtime', 'file'].map(source => {
    const all = logStore[source] || [];
    const entries = all.slice(-2000);
    const deviceId = source === 'realtime' && entries[0]?.deviceId
      && entries.every(entry => entry.deviceId === entries[0].deviceId) ? entries[0].deviceId : '';
    return { source, deviceId, identity: String(analysisSourceGeneration[source]),
      entries, truncated: all.length > entries.length || (source === 'realtime' ? realtimeSourceTruncated || realtimeLogStore.truncated || captureOmitted.omittedLines > 0 : fileLogTruncated) };
  }),
  register,
  createLogAnalyzerWindow,
  // 状态 getter（供 MCP 使用）
  getLogStore,
  getCurrentLogSource,
  getLogcatProc,
  setLogcatProc,
  setCurrentLogSource,
  resetLogStoreRealtime,
  getLogStoreBytes,
  getLogStoreBytesLimit,
  appendRealtimeEntry,
  // 批处理工具（供 MCP 使用）
  getPushLogToBatch,
  getFlushLogBatch,
  getScheduleLogBatchFlush,
  getLogBatchFlushTimerRef,
  setLogBatchFlushTimer,
  clearLogBatchFlushTimer,
  // 解析/PID 工具（供 MCP 使用）
  getParseLogLine,
  getStartPidPackageResolver,
  getStopPidPackageResolver,
  getResolvePkg,
  // logStore 修改工具（供 MCP log_clear 使用）
  clearLogStoreBySource,
  setLogStoreFileEntries,
};
