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
const readline = require('readline');

const ctx = require('./app-context.cjs');
const { runAdb, spawnAdb } = require('./adb-runtime.cjs');
const { isDev } = ctx;

let logcatProc = null;
let logStore = { realtime: [], file: [] };
let currentLogSource = 'realtime';
let pkgResolverTimer = null;
let pidPackageMap = new Map();
// logStore 字节总量追踪：用于按字节限制内存占用（防止超大日志导致 OOM）
// - realtime: 实时日志字节总量上限 100MB
// - file: 文件日志字节总量追踪
const LOG_STORE_BYTES_LIMIT = 100 * 1024 * 1024; // 100MB
const LOG_STORE_REALTIME_MAX_ENTRIES = 200000;
const LOG_STORE_FILE_MAX_ENTRIES = 200000; // file 日志条数上限
let logStoreBytes = { realtime: 0, file: 0 };

// 实时日志批量发送：累积日志条目，每 100ms 或满 50 条时批量发送
// 减少 IPC 调用次数，提升主进程与渲染进程性能
const LOG_BATCH_SIZE = 50;
const LOG_BATCH_FLUSH_INTERVAL_MS = 100;
let pendingLogBatch = [];
let logBatchFlushTimer = null;

function entryBytes(entry) {
  return Buffer.byteLength(entry?.raw || '', 'utf8');
}

function clearLogBatchState() {
  if (logBatchFlushTimer) {
    clearTimeout(logBatchFlushTimer);
    logBatchFlushTimer = null;
  }
  pendingLogBatch = [];
}

function resetLogStoreSource(source) {
  logStore[source] = [];
  logStoreBytes[source] = 0;
}

function trimLogStore(source, maxEntries = LOG_STORE_REALTIME_MAX_ENTRIES) {
  const store = logStore[source];
  if (!store || store.length === 0) return;

  let removeCount = Math.max(0, store.length - maxEntries);
  let removeBytes = 0;
  for (let i = 0; i < removeCount; i++) {
    removeBytes += entryBytes(store[i]);
  }

  while (
    removeCount < store.length &&
    logStoreBytes[source] - removeBytes > LOG_STORE_BYTES_LIMIT
  ) {
    removeBytes += entryBytes(store[removeCount]);
    removeCount++;
  }

  if (removeCount > 0) {
    store.splice(0, removeCount);
    logStoreBytes[source] = Math.max(0, logStoreBytes[source] - removeBytes);
  }
}

function appendLogStoreEntry(source, entry, maxEntries) {
  if (!logStore[source]) {
    logStore[source] = [];
    logStoreBytes[source] = 0;
  }
  logStore[source].push(entry);
  logStoreBytes[source] += entryBytes(entry);
  trimLogStore(source, maxEntries);
}

function appendRealtimeEntry(entry) {
  appendLogStoreEntry('realtime', entry, LOG_STORE_REALTIME_MAX_ENTRIES);
}

function flushLogBatch() {
  if (pendingLogBatch.length === 0) return;
  const batch = pendingLogBatch;
  pendingLogBatch = [];
  ctx.broadcastToAllWindows('log:appendBatch', batch);
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
  if (pendingLogBatch.length >= LOG_BATCH_SIZE) {
    // 立即 flush（取消定时器）
    if (logBatchFlushTimer) {
      clearTimeout(logBatchFlushTimer);
      logBatchFlushTimer = null;
    }
    flushLogBatch();
  } else {
    scheduleLogBatchFlush();
  }
}

function parseLogLine(source, line) {
  const threadtimeRe = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/;
  const timeRe = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEFA])\/([^(\s]+)\(\s*(\d+)\):\s?(.*)$/;

  function toEpoch(mmdd, hhmmss) {
    const year = new Date().getFullYear();
    const [mm, dd] = mmdd.split('-').map(Number);
    const [hms, ms] = hhmmss.split('.');
    const [hh, mi, ss] = hms.split(':').map(Number);
    return new Date(year, mm - 1, dd, hh, mi, ss, Number(ms)).getTime();
  }

  function cryptoRandomId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  const trimmed = line.replace(/\r?\n$/, '');
  const m1 = trimmed.match(threadtimeRe);
  if (m1) {
    const [, mmdd, hhmmss, pid, tid, level, tag, msg] = m1;
    const pkgMatch = msg.match(/\[pkg:([^\]]+)\]\s*$/);
    const pkg = pkgMatch ? pkgMatch[1] : undefined;
    const cleanMsg = pkgMatch ? msg.slice(0, msg.length - pkgMatch[0].length) : msg;
    return {
      id: cryptoRandomId(), source, ts: toEpoch(mmdd, hhmmss), raw: trimmed,
      pid: Number(pid), tid: Number(tid), level, tag: tag.trim(), pkg, message: cleanMsg
    };
  }
  const m2 = trimmed.match(timeRe);
  if (m2) {
    const [, mmdd, hhmmss, level, tag, pid, msg] = m2;
    const pkgMatch = msg.match(/\[pkg:([^\]]+)\]\s*$/);
    const pkg = pkgMatch ? pkgMatch[1] : undefined;
    const cleanMsg = pkgMatch ? msg.slice(0, msg.length - pkgMatch[0].length) : msg;
    return {
      id: cryptoRandomId(), source, ts: toEpoch(mmdd, hhmmss), raw: trimmed,
      pid: Number(pid), level, tag: tag.trim(), pkg, message: cleanMsg
    };
  }
  return { id: cryptoRandomId(), source, ts: Date.now(), raw: trimmed, message: trimmed };
}

function startPidPackageResolver(adbPathOrDeviceId, maybeDeviceId) {
  const deviceId = maybeDeviceId !== undefined
    ? maybeDeviceId
    : (adbPathOrDeviceId && adbPathOrDeviceId !== 'adb' ? adbPathOrDeviceId : '');
  stopPidPackageResolver();
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
  const { BrowserWindow } = require('electron');
  let logAnalyzerWindow = ctx.getLogAnalyzerWindow();
  if (logAnalyzerWindow && !logAnalyzerWindow.isDestroyed()) {
    logAnalyzerWindow.focus();
    return logAnalyzerWindow;
  }

  logAnalyzerWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    icon: path.join(__dirname, '../../icon.png'),
    title: 'AI 日志助手',
    webPreferences: {
      preload: path.join(__dirname, '../preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  logAnalyzerWindow.setMenu(null);

  if (isDev) {
    logAnalyzerWindow.loadURL('http://localhost:5173/log-analyzer.html');
  } else {
    logAnalyzerWindow.loadFile(path.join(__dirname, '../../dist/log-analyzer.html'));
  }

  logAnalyzerWindow.on('closed', () => {
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

  ctx.setLogAnalyzerWindow(logAnalyzerWindow);
  return logAnalyzerWindow;
}

// ============ IPC handlers ============

function register(ipcMain) {
  // ADB 设备列表（Log Analyzer 专用）
  ipcMain.handle('adb:listDevices', async () => {
    return new Promise((resolve) => {
      runAdb(['devices', '-l'], { timeoutMs: 10000, queueGlobal: true }).then((res) => {
        if (!res.ok) return resolve([]);
        const lines = String(res.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const out = [];
        for (const line of lines.slice(1)) {
          const match = line.match(/^(\S+)\s+device\b(.*)$/);
          if (!match) continue;
          const id = match[1];
          const info = match[2] ?? '';
          const model = info.match(/model:([^\s]+)/)?.[1];
          const device = info.match(/device:([^\s]+)/)?.[1];
          const transportId = info.match(/transport_id:([^\s]+)/)?.[1];
          out.push({ id, model, device, transportId });
        }
        resolve(out);
      });
    });
  });

  // 开始抓取日志
  ipcMain.handle('adb:startLog', async (event, args) => {
    try {
      // 延迟 require 以打破与 auto-diagnose 的循环依赖
      const autoDiagnose = require('./auto-diagnose.cjs');

      if (logcatProc) {
        try { logcatProc.kill(); } catch {}
        logcatProc = null;
      }

      currentLogSource = 'realtime';
      clearLogBatchState();
      resetLogStoreSource('realtime');
      runAdb(['logcat', '-c'], { timeoutMs: 5000, queueGlobal: true }).catch(() => {});
      ctx.broadcastToAllWindows('log:reset', { source: 'realtime', entries: [] });

      startPidPackageResolver(args?.deviceId);

      const adbArgs = [];
      if (args?.deviceId) adbArgs.push('-s', args.deviceId);
      adbArgs.push('logcat', '-v', 'threadtime');
      // 支持多缓冲区抓取：根据用户选择拼接 -b <buffer> 参数
      // 默认不传 -b（adb 默认 main/system/crash）
      // 用户显式选择时，按选择拼接
      const SUPPORTED_BUFFERS = ['main', 'system', 'radio', 'events', 'crash', 'kernel'];
      const wantedBuffers = Array.isArray(args?.buffers)
        ? args.buffers.filter(b => SUPPORTED_BUFFERS.includes(b))
        : [];
      if (wantedBuffers.length > 0) {
        wantedBuffers.forEach(b => adbArgs.push('-b', b));
      }
      // 兼容旧 extraArgs 参数（追加在 -b 之后）
      if (args?.extraArgs?.length) adbArgs.push(...args.extraArgs);

      const p = spawnAdb(adbArgs);
      logcatProc = p;

      const rl = readline.createInterface({ input: p.stdout });
      rl.on('line', (line) => {
        if (logcatProc !== p) return;
        const entry = parseLogLine('realtime', line);
        const pkg = resolvePkg(entry.pid);
        if (pkg) entry.pkg = pkg;
        appendRealtimeEntry(entry);
        // 批量发送：累积日志条目，每 100ms 或满 50 条时批量发送（减少 IPC 调用）
        pushLogToBatch(entry);
        // AI 自动诊断：检测崩溃/ANR/OOM 等关键问题
        autoDiagnose.autoDiagnoseOnLine(line, logStore.realtime.length - 1);
      });

      // 消费 stderr 防止缓冲区满导致进程挂起
      p.stderr.on('data', () => {});

      p.on('exit', () => {
        rl.close();
        if (logcatProc === p) logcatProc = null;
        // 进程退出时 flush 剩余批次，避免日志丢失
        if (logBatchFlushTimer) {
          clearTimeout(logBatchFlushTimer);
          logBatchFlushTimer = null;
        }
        flushLogBatch();
      });

      return { ok: true };
    } catch (error) {
      console.error('Failed to start logcat:', error);
      return { ok: false, error: error.message };
    }
  });

  // 停止抓取日志
  ipcMain.handle('adb:stopLog', async () => {
    stopPidPackageResolver();
    // 停止抓取时 flush 剩余批次，避免日志丢失
    if (logBatchFlushTimer) {
      clearTimeout(logBatchFlushTimer);
      logBatchFlushTimer = null;
    }
    flushLogBatch();
    if (logcatProc) {
      try { logcatProc.kill(); } catch {}
      logcatProc = null;
    }
    return { ok: true };
  });

  // 清空日志
  ipcMain.handle('log:clear', async (event, args) => {
    const autoDiagnose = require('./auto-diagnose.cjs');
    const s = args?.source ?? currentLogSource;
    if (!s || s === 'realtime') {
      runAdb(['logcat', '-c'], { timeoutMs: 5000, queueGlobal: true }).catch(() => {});
      clearLogBatchState();
    }
    if (!s || s === 'realtime') resetLogStoreSource('realtime');
    if (!s || s === 'file') resetLogStoreSource('file');
    // 同步重置自动诊断去抖时间戳，避免下次抓取/加载时旧时间戳抑制告警
    autoDiagnose.resetAutoDiagnoseLastFire();
    ctx.broadcastToAllWindows('log:reset', { source: s ?? currentLogSource, entries: [] });
    return { ok: true };
  });

  // 打开日志文件
  ipcMain.handle('log:openFile', async () => {
    const autoDiagnose = require('./auto-diagnose.cjs');
    // 优先绑定到 Log 分析窗口，避免对话框弹出时隐藏子窗口
    const parentWin = (ctx.getLogAnalyzerWindow() && !ctx.getLogAnalyzerWindow().isDestroyed()) ? ctx.getLogAnalyzerWindow() : ctx.getMainWindow();
    if (!parentWin) return { ok: false };
    const res = await dialog.showOpenDialog(parentWin, {
      title: '选择日志文件',
      properties: ['openFile'],
      filters: [
        { name: 'Log', extensions: ['log', 'txt'] },
        { name: 'All', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const filePath = res.filePaths[0];

    currentLogSource = 'file';
    const entries = [];

    // 文件日志加载：限制最大条数 200000，并在 stream error 时显式清理资源
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl2 = readline.createInterface({ input: stream });
      rl2.on('line', (line) => {
        entries.push(parseLogLine('file', line));
      });
      rl2.on('close', () => resolve());
      stream.on('error', (e) => {
        try { rl2.close(); } catch {}
        try { stream.destroy(); } catch {}
        reject(e);
      });
    });

    // 限制 logStore.file 最大 200000 条，超过时只保留最后 200000 条
    let fileEntries = entries;
    if (entries.length > LOG_STORE_FILE_MAX_ENTRIES) {
      fileEntries = entries.slice(entries.length - LOG_STORE_FILE_MAX_ENTRIES);
    }
    logStore.file = fileEntries;
    // 重新计算 file 字节总量
    logStoreBytes.file = fileEntries.reduce((sum, e) => sum + Buffer.byteLength(e.raw || '', 'utf8'), 0);
    const limited = entries.length > 50000 ? entries.slice(entries.length - 50000) : entries;
    ctx.broadcastToAllWindows('log:reset', { source: 'file', entries: limited, truncated: entries.length !== limited.length });

    // 文件加载完成后扫描关键问题（崩溃/ANR/OOM 等）
    // autoDiagnoseScanFile 现在是 async 函数，使用 .catch 防止 unhandled rejection
    setTimeout(() => {
      autoDiagnose.autoDiagnoseScanFile(entries).catch(e => {
        console.error('[AutoDiagnose] 文件扫描失败:', e.message);
      });
    }, 500);

    return { ok: true, filePath, total: entries.length, shown: limited.length };
  });

  // 获取日志状态
  ipcMain.handle('log:getState', async () => {
    const entries = logStore[currentLogSource] || [];
    const limited = entries.length > 50000 ? entries.slice(entries.length - 50000) : entries;
    return { source: currentLogSource, entries: limited, truncated: entries.length !== limited.length };
  });

  // 导出日志到文件
  ipcMain.handle('log:exportToFile', async (event, args) => {
    // 优先绑定到 Log 分析窗口，避免对话框弹出时隐藏子窗口
    const parentWin = (ctx.getLogAnalyzerWindow() && !ctx.getLogAnalyzerWindow().isDestroyed()) ? ctx.getLogAnalyzerWindow() : ctx.getMainWindow();
    if (!parentWin) return { ok: false };
    const result = await dialog.showSaveDialog(parentWin, {
      defaultPath: args?.defaultName ?? 'log_export.txt',
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, args?.content ?? '', 'utf-8');
    return { ok: true, path: result.filePath };
  });

  // 主进程过滤（保留接口兼容性）
  ipcMain.handle('log:filterInMain', async (event, args) => {
    const { filterEntries } = require('../../src/shared/filter');
    const source = args?.source ?? currentLogSource;
    const offset = args?.offset ?? 0;
    const limit = args?.limit ?? 1000;
    const all = filterEntries(logStore[source] || [], args?.filter ?? {});
    const page = all.slice(offset, offset + limit);
    return { total: all.length, offset, limit, entries: page };
  });

  ipcMain.handle('logAnalyzer:open', async () => {
    createLogAnalyzerWindow();
    return { ok: true };
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
function setCurrentLogSource(source) { currentLogSource = source; }
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
