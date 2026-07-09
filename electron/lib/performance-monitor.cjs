// 性能监控后端：采集设备 CPU/内存/磁盘/电池/温度/FPS/进程快照，并通过 IPC 推送给渲染进程。

const { app } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const ctx = require('./app-context.cjs');
const vip = require('./vip.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const { getAdbCommand, runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

// 默认 3 秒采样，减少性能面板数值延后感；1 秒高频仍由会员权限控制。
const DEFAULT_INTERVAL_MS = 3000;
const VIP_MIN_INTERVAL_MS = 1000;
const FREE_MIN_INTERVAL_MS = 5000;
const FREE_HISTORY_LIMIT = 60;
const VIP_HISTORY_LIMIT = 720;
const COMMAND_TIMEOUT_MS = 15000;
// FPS 采样依赖 dumpsys，单独缩短超时，避免帧率命令拖慢基础指标。
const FPS_COMMAND_TIMEOUT_MS = 8000;
const SURFACE_LAYER_CACHE_MS = 10000;
const EXPORT_DIR = 'performance-monitor';
const THRESHOLDS_FILE = 'performance-thresholds.json';

const monitors = new Map();
const historyByDevice = new Map();
const cpuTicksByDevice = new Map();
// 保存帧率上一次采样点，用差值计算当前窗口内 FPS。
const gfxFrameStatsByDevice = new Map();
const surfaceFrameStatsByDevice = new Map();
const surfaceLayerCacheByDevice = new Map();
const fpsDisplayByMetric = new Map();
const lastSnapshotByDevice = new Map();
let currentReportTask = null;
let lastReportTask = null;
let thresholdCache = null;
let performanceWorker = null;
let workerRequestSeq = 0;
const workerRequests = new Map();

const DEFAULT_THRESHOLDS = {
  cpu: 85,
  memory: 85,
  batteryTemp: 45,
  dataUsed: 90
};

function register(ipcMain) {
  ipcMain.handle('perf:start', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    const status = await vip.getStatusAsync();
    const isVip = status.activated === true;
    const requestedIntervalMs = Number(args?.intervalMs) || DEFAULT_INTERVAL_MS;
    if (!isVip && requestedIntervalMs < FREE_MIN_INTERVAL_MS) {
      return { ok: false, code: 'vip_required', error: '3 秒及更高频性能采样为会员专属功能，请先开通会员' };
    }
    const intervalMs = normalizeInterval(args?.intervalMs, isVip);
    await stopMonitor(deviceId);
    const monitor = {
      deviceId,
      intervalMs,
      includeProcesses: isVip && args?.includeProcesses !== false,
      vip: isVip,
      running: true,
      startedAt: new Date().toISOString(),
      inFlight: false
    };
    monitors.set(deviceId, monitor);
    const workerResult = await requestWorker('start', {
      deviceId,
      intervalMs,
      includeProcesses: monitor.includeProcesses,
      startedAt: monitor.startedAt,
      thresholds: readThresholds(),
      adbPath: getAdbCommand()
    }, 3000);
    if (!workerResult.ok) {
      monitors.delete(deviceId);
      return { ok: false, error: workerResult.error || '性能采样 Worker 启动失败' };
    }
    return { ok: true, deviceId, intervalMs, vip: isVip };
  });

  ipcMain.handle('perf:stop', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    const stopped = await stopMonitor(deviceId);
    return { ok: true, stopped };
  });

  ipcMain.handle('perf:snapshot', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    const status = await vip.getStatusAsync();
    try {
      const snapshot = await collectSnapshot(deviceId, status.activated === true, { timeoutMs: 12000 });
      appendHistory(deviceId, snapshot, status.activated === true);
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, error: error.message || 'snapshot_failed' };
    }
  });

  ipcMain.handle('perf:history', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    return { ok: true, history: historyByDevice.get(deviceId) || [] };
  });

  ipcMain.handle('perf:state', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const monitor = deviceId ? monitors.get(deviceId) : null;
    return {
      ok: true,
      monitor: publicMonitor(monitor),
      monitors: Array.from(monitors.values()).map(publicMonitor),
      history: deviceId ? historyByDevice.get(deviceId) || [] : []
    };
  });

  ipcMain.handle('perf:export', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    const history = historyByDevice.get(deviceId) || [];
    if (history.length === 0) return { ok: false, error: 'no_history' };
    const outputPath = await writeExport(deviceId, history, args?.outputPath, args?.outputBaseDir);
    return { ok: true, path: outputPath, count: history.length };
  }));

  ipcMain.handle('perf:report', async (event, args) => withVip(async () => {
    if (currentReportTask) {
      return { ok: false, error: '已有性能报告正在生成，请等待完成' };
    }
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    const history = [...(historyByDevice.get(deviceId) || [])];
    if (history.length === 0) return { ok: false, error: 'no_history' };
    const task = {
      id: `perf-report-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      deviceId,
      sender: event.sender,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { percent: 5, message: '准备性能报告' },
      result: null
    };
    currentReportTask = task;
    lastReportTask = publicReportTask(task);
    sendReportProgress(task);
    runReportTask(task, {
      deviceId,
      history,
      outputPath: args?.outputPath,
      outputBaseDir: args?.outputBaseDir,
      includeAiSummary: args?.includeAiSummary === true
    });
    return { ok: true, task: publicReportTask(task) };
  }));

  ipcMain.handle('perf:reportState', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const task = currentReportTask ? publicReportTask(currentReportTask) : lastReportTask;
    if (deviceId && task?.deviceId && task.deviceId !== deviceId) {
      return { ok: true, task: null };
    }
    return { ok: true, task: task || null };
  });

  ipcMain.handle('perf:getThresholds', async () => {
    return { ok: true, thresholds: readThresholds() };
  });

  ipcMain.handle('perf:setThresholds', async (event, args) => withVip(async () => {
    const next = {
      ...readThresholds(),
      ...sanitizeThresholds(args?.thresholds || {})
    };
    writeThresholds(next);
    postWorker('updateThresholds', { thresholds: next });
    return { ok: true, thresholds: next };
  }));
}

async function withVip(action) {
  const status = await vip.getStatusAsync();
  if (!status.activated) {
    return { ok: false, code: 'vip_required', error: 'VIP 会员专属功能，请先开通会员' };
  }
  try {
    return await action(status);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function runReportTask(task, options) {
  try {
    const result = await writeReport(
      options.deviceId,
      options.history,
      options.outputPath,
      options.outputBaseDir,
      options.includeAiSummary,
      (progress) => updateReportProgress(task, progress)
    );
    const payload = { ok: true, path: result.path, aiSummary: result.aiSummary, count: options.history.length };
    task.status = 'success';
    task.progress = { percent: 100, message: '性能报告已生成' };
    task.result = payload;
    lastReportTask = publicReportTask(task);
    sendReportDone(task, payload);
  } catch (error) {
    const payload = { ok: false, error: error.message || '性能报告生成失败' };
    task.status = 'failed';
    task.progress = { percent: 100, message: '性能报告生成失败' };
    task.result = payload;
    lastReportTask = publicReportTask(task);
    sendReportDone(task, payload);
  } finally {
    if (currentReportTask === task) currentReportTask = null;
  }
}

function updateReportProgress(task, progress) {
  task.progress = {
    percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
    message: String(progress?.message || '正在生成性能报告')
  };
  task.status = 'running';
  lastReportTask = publicReportTask(task);
  sendReportProgress(task);
}

async function collectSnapshot(deviceId, includeProcesses, options = {}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (!normalizedDeviceId) throw new Error('device_required');
  const result = await requestWorker('snapshot', {
    deviceId: normalizedDeviceId,
    includeProcesses: includeProcesses === true,
    forceHeavy: options.includeFps !== false,
    thresholds: readThresholds(),
    adbPath: getAdbCommand()
  }, options.timeoutMs || 12000);
  if (result.ok && result.snapshot) return result.snapshot;
  if (options.fallbackToLegacy === true) {
    return collectSnapshotLegacy(normalizedDeviceId, includeProcesses, options);
  }
  throw new Error(result.error || 'snapshot_failed');
}

async function collectSnapshotLegacy(deviceId, includeProcesses, options = {}) {
  const previousSnapshot = options.previousSnapshot || lastSnapshotByDevice.get(deviceId) || null;
  const includeFps = options.includeFps !== false;
  const [cpu, meminfo, df, battery, thermal, top, fps] = await Promise.all([
    runAdb(['-s', deviceId, 'shell', 'cat', '/proc/stat']),
    runAdb(['-s', deviceId, 'shell', 'cat', '/proc/meminfo']),
    runAdb(['-s', deviceId, 'shell', 'df', '-k']),
    runAdb(['-s', deviceId, 'shell', 'dumpsys', 'battery']),
    runAdb(['-s', deviceId, 'shell', 'dumpsys', 'thermalservice']),
    includeProcesses ? runTop(deviceId) : Promise.resolve({ ok: true, stdout: '' }),
    // FPS 采样失败不影响基础性能指标。
    includeFps ? collectFps(deviceId).catch(error => buildEmptyFps(error.message)) : Promise.resolve(previousSnapshot?.fps || buildEmptyFps(''))
  ]);
  const snapshot = {
    timestamp: Date.now(),
    deviceId,
    cpu: parseCpu(deviceId, cpu.stdout),
    memory: parseMeminfo(meminfo.stdout),
    disk: parseDisk(df.stdout),
    battery: parseBattery(battery.stdout),
    thermal: parseThermal(thermal.stdout),
    fps,
    processes: includeProcesses ? parseTop(top.stdout) : previousSnapshot?.processes || [],
    warnings: []
  };
  snapshot.warnings = buildWarnings(snapshot, readThresholds());
  return snapshot;
}

async function runTop(deviceId) {
  const preferred = await runAdb(['-s', deviceId, 'shell', 'top', '-b', '-n', '1', '-m', '12']);
  if (preferred.ok && preferred.stdout.trim()) return preferred;
  return runAdb(['-s', deviceId, 'shell', 'toybox', 'top', '-b', '-n', '1', '-m', '12']);
}

function parseCpu(deviceId, text) {
  const line = String(text || '').split(/\r?\n/).find(item => item.startsWith('cpu '));
  if (!line) return { usage: null };
  const parts = line.trim().split(/\s+/).slice(1).map(value => Number(value) || 0);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  const prev = cpuTicksByDevice.get(deviceId);
  cpuTicksByDevice.set(deviceId, { idle, total });
  if (!prev) return { usage: null };
  const totalDelta = total - prev.total;
  const idleDelta = idle - prev.idle;
  const usage = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null;
  return { usage: usage == null ? null : Number(usage.toFixed(1)) };
}

function parseMeminfo(text) {
  const values = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]);
  });
  const total = values.MemTotal || 0;
  const available = values.MemAvailable || values.MemFree || 0;
  const used = Math.max(0, total - available);
  return {
    totalKb: total,
    usedKb: used,
    availableKb: available,
    usage: total ? Number((used / total * 100).toFixed(1)) : null
  };
}

function parseDisk(text) {
  const rows = String(text || '').split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
  return rows.map(line => {
    const parts = line.split(/\s+/);
    const usedPct = firstPercent(parts);
    return {
      filesystem: parts[0] || '',
      sizeKb: Number(parts[1]) || 0,
      usedKb: Number(parts[2]) || 0,
      availableKb: Number(parts[3]) || 0,
      usage: usedPct,
      mount: parts[parts.length - 1] || ''
    };
  });
}

function parseBattery(text) {
  const level = firstNumber(text, /level:\s*(\d+)/i);
  const temperatureRaw = firstNumber(text, /temperature:\s*(\d+)/i);
  const present = /present:\s*true/i.test(String(text || ''));
  return {
    present,
    level: present ? level : null,
    status: firstText(text, /status:\s*(\d+)/i),
    plugged: firstText(text, /plugged:\s*(\d+)/i),
    health: firstText(text, /health:\s*(\d+)/i),
    temperature: present && temperatureRaw ? Number((temperatureRaw / 10).toFixed(1)) : null
  };
}

function parseThermal(text) {
  const sensors = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const status = firstNumber(line, /mStatus=(\d+)/);
    const value = firstNumber(line, /mValue=([0-9.]+)/);
    const name = firstText(line, /mName=([^,\]\s]+)/);
    if (value != null || name) sensors.push({ name: name || 'thermal', value, status });
  });
  const hottest = sensors.reduce((max, item) => item.value != null && item.value > max ? item.value : max, null);
  return { sensors: sensors.slice(0, 12), hottest };
}

function parseTop(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => /PID/i.test(line) && /CPU|%CPU/i.test(line));
  if (headerIndex < 0) return [];
  const header = lines[headerIndex].split(/\s+/);
  const cpuIndex = header.findIndex(item => /%?CPU/i.test(item));
  const memIndex = header.findIndex(item => /%?MEM/i.test(item));
  const pidIndex = header.findIndex(item => item === 'PID');
  return lines.slice(headerIndex + 1, headerIndex + 13).map(line => {
    const parts = line.split(/\s+/);
    return {
      pid: parts[pidIndex] || parts[0] || '',
      cpu: parseFloat(String(parts[cpuIndex] || '0').replace('%', '')) || 0,
      memory: parseFloat(String(parts[memIndex] || '0').replace('%', '')) || 0,
      name: parts.slice(Math.max(header.length - 1, 0)).join(' ') || parts[parts.length - 1] || ''
    };
  }).filter(item => item.pid);
}

// 采集前台应用 FPS 与 SurfaceFlinger 合成 FPS。
async function collectFps(deviceId) {
  const foreground = await getForegroundApp(deviceId);
  const [foregroundFps, surfaceFlingerFps] = await Promise.all([
    collectForegroundFps(deviceId, foreground),
    collectSurfaceFlingerFps(deviceId, foreground)
  ]);
  return {
    foreground: foregroundFps,
    surfaceFlinger: surfaceFlingerFps
  };
}

function buildEmptyFps(error) {
  return {
    foreground: { fps: null, packageName: '', activityName: '', error: error || '' },
    surfaceFlinger: { fps: null, layer: '', refreshRate: null, error: error || '' }
  };
}

async function getForegroundApp(deviceId) {
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'window'], FPS_COMMAND_TIMEOUT_MS);
  if (!res.ok) return { packageName: '', activityName: '', component: '', error: res.error || res.stderr || '' };
  return parseForegroundWindow(res.stdout);
}

function parseForegroundWindow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const preferred = [
    /mCurrentFocus=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\b/,
    /topResumedActivity=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\b/,
    /mFocusedApp=.*?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\b/
  ];
  for (const regex of preferred) {
    for (const line of lines) {
      const match = line.match(regex);
      if (match) {
        const packageName = match[1];
        const activityName = normalizeActivityName(packageName, match[2]);
        return { packageName, activityName, component: `${packageName}/${activityName}` };
      }
    }
  }
  return { packageName: '', activityName: '', component: '' };
}

async function collectForegroundFps(deviceId, foreground) {
  if (!foreground.packageName) return { fps: null, ...foreground, source: 'window' };
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', foreground.packageName, 'framestats'], FPS_COMMAND_TIMEOUT_MS);
  if (!res.ok) {
    return { fps: null, ...foreground, source: 'gfxinfo', error: res.error || res.stderr || '' };
  }
  return {
    ...parseGfxInfoFps(deviceId, foreground.packageName, res.stdout),
    ...foreground,
    source: 'gfxinfo'
  };
}

function parseGfxInfoFps(deviceId, packageName, text) {
  const totalFrames = firstNumber(text, /Total frames rendered:\s*(\d+)/i);
  const jankyFrames = firstNumber(text, /Janky frames:\s*(\d+)/i);
  const key = `${deviceId}:${packageName}`;
  const rows = parseGfxFrameRows(text);
  const targetFrameNs = getTargetFrameNs(rows);
  const targetFps = targetFrameNs ? framePeriodToFps(targetFrameNs) : null;
  const prev = gfxFrameStatsByDevice.get(key);
  const newestFrameNs = rows.reduce((max, row) => Math.max(max, row.completed || row.intended || 0), 0);
  let windowRows = [];
  let state = 'initial';
  let deltaFrames = 0;
  let deltaJankyFrames = 0;
  if (prev?.lastFrameNs && newestFrameNs) {
    windowRows = rows.filter(row => (row.completed || row.intended || 0) > prev.lastFrameNs);
    state = windowRows.length > 0 ? 'active' : 'idle';
  }
  if (prev && totalFrames != null && totalFrames >= prev.totalFrames) {
    deltaFrames = totalFrames - prev.totalFrames;
    deltaJankyFrames = Math.max(0, (jankyFrames || 0) - (prev.jankyFrames || 0));
    if (deltaFrames > 0 && state === 'idle') state = 'active';
  }
  if (newestFrameNs) {
    gfxFrameStatsByDevice.set(key, { lastFrameNs: newestFrameNs, targetFrameNs, totalFrames, jankyFrames });
  }
  // 前台 FPS 主值按累计帧/卡顿帧折算。framestats 单帧耗时会把轻微滑动误判成 30/40 FPS，
  // 但用户实际看到的是流畅动画；只有 janky frames 明确增加时才降低主显示。
  const rawFps = state === 'active' && deltaFrames > 0
    ? estimateEffectiveFpsFromFrameDelta(deltaFrames, deltaJankyFrames, targetFps)
    : targetFps;
  const fps = smoothFpsValue(`foreground:${key}`, rawFps, targetFps, state);
  return {
    fps: roundFps(fps ?? targetFps),
    rawFps: roundFps(rawFps ?? targetFps),
    targetFps,
    frames: state === 'active' ? (windowRows.length || deltaFrames) : 0,
    state,
    totalFrames,
    jankyFrames,
    jankPercent: totalFrames ? Number(((jankyFrames || 0) / totalFrames * 100).toFixed(1)) : null
  };
}

function parseGfxFrameRows(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => line.startsWith('Flags,') && line.includes('IntendedVsync'));
  if (headerIndex < 0) return [];
  const header = lines[headerIndex].split(',');
  const intendedIndex = header.indexOf('IntendedVsync');
  const completedIndex = header.indexOf('FrameCompleted');
  const intervalIndex = header.indexOf('FrameInterval');
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.startsWith('---PROFILEDATA---')) break;
    const parts = line.split(',');
    const flags = Number(parts[0]);
    if (flags !== 0) continue;
    const completed = Number(parts[completedIndex]);
    const intended = Number(parts[intendedIndex]);
    const frameInterval = Number(parts[intervalIndex]);
    if (Number.isFinite(intended) && intended > 0) {
      rows.push({
        intended,
        completed: Number.isFinite(completed) && completed > 0 ? completed : 0,
        frameInterval: Number.isFinite(frameInterval) && frameInterval > 0 ? frameInterval : null
      });
    }
  }
  return rows;
}

function estimateEffectiveFpsFromFrameDelta(frames, jankyFrames, targetFps) {
  if (!targetFps || frames <= 0) return targetFps;
  const goodFrames = Math.max(0, frames - Math.max(0, jankyFrames || 0));
  return targetFps * goodFrames / frames;
}

async function collectSurfaceFlingerFps(deviceId, foreground) {
  const layer = await getSurfaceLayer(deviceId, foreground);
  if (!layer) {
    const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'SurfaceFlinger', '--latency'], FPS_COMMAND_TIMEOUT_MS);
    const framePeriodNs = parseFramePeriod(res.stdout);
    const refreshRate = framePeriodToFps(framePeriodNs);
    return {
      fps: refreshRate,
      layer: '',
      refreshRate,
      framePeriodMs: framePeriodNs ? Number((framePeriodNs / 1e6).toFixed(2)) : null,
      state: 'refresh_rate',
      source: 'surfaceflinger'
    };
  }
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'SurfaceFlinger', '--latency', layer], FPS_COMMAND_TIMEOUT_MS);
  if (!res.ok) {
    return { fps: null, layer, refreshRate: null, source: 'surfaceflinger', error: res.error || res.stderr || '' };
  }
  return parseSurfaceLatency(deviceId, layer, res.stdout);
}

async function getSurfaceLayer(deviceId, foreground) {
  const packageName = foreground.packageName || '';
  const cached = surfaceLayerCacheByDevice.get(deviceId);
  if (cached && cached.packageName === packageName && Date.now() - cached.updatedAt < SURFACE_LAYER_CACHE_MS) {
    return cached.layer;
  }
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'SurfaceFlinger', '--list'], FPS_COMMAND_TIMEOUT_MS);
  if (!res.ok) return '';
  const layer = pickSurfaceLayer(parseSurfaceLayers(res.stdout), foreground);
  surfaceLayerCacheByDevice.set(deviceId, { packageName, layer, updatedAt: Date.now() });
  return layer;
}

function parseSurfaceLayers(text) {
  return String(text || '').split(/\r?\n/)
    .map(line => line.trim())
    .map(line => {
      const requested = line.match(/^RequestedLayerState\{(.+?#[0-9]+)/);
      return requested ? requested[1].trim() : line;
    })
    .filter(Boolean);
}

function pickSurfaceLayer(layers, foreground) {
  const packageName = String(foreground.packageName || '').toLowerCase();
  const activityName = String(foreground.activityName || '').toLowerCase();
  const activitySimple = activityName.split('.').filter(Boolean).pop() || '';
  let best = { layer: '', score: 0 };
  layers.forEach(layer => {
    const lower = layer.toLowerCase();
    let score = 0;
    if (packageName && lower.includes(packageName)) score += 60;
    if (activityName && lower.includes(activityName)) score += 30;
    if (activitySimple && lower.includes(activitySimple)) score += 10;
    if (!/\s/.test(layer)) score += 8;
    if (/inputsink|activityrecord|statusbar|navigationbar|taskbar|wallpaper|sprite/i.test(layer)) score -= 40;
    if (score > best.score) best = { layer, score };
  });
  return best.score > 0 ? best.layer : '';
}

function parseSurfaceLatency(deviceId, layer, text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const framePeriodNs = parseFramePeriod(text);
  const timestamps = lines.slice(1)
    .map(line => line.split(/\s+/).map(value => Number(value)))
    .filter(parts => parts.length >= 3)
    .map(parts => parts[1] || parts[0])
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const key = `${deviceId}:${layer}`;
  const prev = surfaceFrameStatsByDevice.get(key);
  let rawFps = null;
  let frames = 0;
  const refreshRate = framePeriodToFps(framePeriodNs);
  let state = 'estimate';
  if (prev && timestamps.length > 0) {
    const fresh = timestamps.filter(value => value > prev.lastPresentNs);
    frames = fresh.length;
    rawFps = fresh.length > 1 ? estimateEffectiveFpsFromPresentTimes(fresh, framePeriodNs) : refreshRate;
    state = fresh.length > 0 ? 'active' : 'idle';
  } else if (timestamps.length >= 2) {
    frames = 0;
    rawFps = refreshRate;
    state = 'initial';
  } else if (framePeriodNs) {
    rawFps = refreshRate;
    state = 'idle';
  }
  if (timestamps.length > 0) {
    surfaceFrameStatsByDevice.set(key, { lastPresentNs: timestamps[timestamps.length - 1] });
  }
  const fps = smoothFpsValue(`surface:${key}`, rawFps, refreshRate, state);
  return {
    fps: roundFps(fps ?? refreshRate),
    rawFps: roundFps(rawFps ?? refreshRate),
    frames,
    state,
    layer,
    refreshRate,
    framePeriodMs: framePeriodNs ? Number((framePeriodNs / 1e6).toFixed(2)) : null,
    source: 'surfaceflinger'
  };
}

function estimateEffectiveFpsFromPresentTimes(timestamps, framePeriodNs) {
  const refreshRate = framePeriodToFps(framePeriodNs);
  if (!framePeriodNs || timestamps.length < 2) return refreshRate;
  let intervals = 0;
  let slots = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (!Number.isFinite(delta) || delta <= 0) continue;
    intervals += 1;
    slots += Math.max(1, Math.round(delta / framePeriodNs));
  }
  return slots > 0 ? refreshRate * intervals / slots : refreshRate;
}

function getTargetFrameNs(rows) {
  const values = rows.map(row => row.frameInterval).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!values.length) return null;
  return values[Math.floor(values.length / 2)];
}

function parseFramePeriod(text) {
  const first = String(text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
  const value = Number(first);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function framePeriodToFps(framePeriodNs) {
  return framePeriodNs ? roundFps(1e9 / framePeriodNs) : null;
}

function roundFps(value) {
  if (!Number.isFinite(value)) return null;
  return Number(Math.max(0, Math.min(240, value)).toFixed(1));
}

function smoothFpsValue(key, rawFps, targetFps, state) {
  const target = Number.isFinite(targetFps) ? targetFps : null;
  const raw = Number.isFinite(rawFps) ? (target ? Math.min(rawFps, target) : rawFps) : target;
  if (!Number.isFinite(raw)) return null;
  if (state !== 'active') {
    fpsDisplayByMetric.set(key, { value: raw, lowCount: 0 });
    return raw;
  }
  const previous = fpsDisplayByMetric.get(key);
  const previousValue = typeof previous === 'object' ? previous.value : previous;
  const base = Number.isFinite(previousValue) ? previousValue : (target || raw);
  const alpha = raw < base ? 0.55 : 0.7;
  const next = base + (raw - base) * alpha;
  const maxStep = target ? Math.max(3, target * 0.18) : 20;
  const limited = Math.max(base - maxStep, Math.min(base + maxStep, next));
  const clamped = target ? Math.min(target, limited) : limited;
  fpsDisplayByMetric.set(key, { value: clamped, lowCount: 0 });
  return clamped;
}

function normalizeActivityName(packageName, activityName) {
  const value = String(activityName || '');
  return value.startsWith('.') ? `${packageName}${value}` : value;
}

function clearDeviceFpsState(deviceId) {
  const prefix = `${deviceId}:`;
  [gfxFrameStatsByDevice, surfaceFrameStatsByDevice, fpsDisplayByMetric].forEach(map => {
    Array.from(map.keys()).forEach(key => {
      if (key.startsWith(prefix)) map.delete(key);
    });
  });
  surfaceLayerCacheByDevice.delete(deviceId);
}

function buildWarnings(snapshot, thresholds) {
  const warnings = [];
  if (snapshot.cpu.usage != null && snapshot.cpu.usage >= thresholds.cpu) warnings.push({ type: 'cpu', label: `CPU ${snapshot.cpu.usage}%` });
  if (snapshot.memory.usage != null && snapshot.memory.usage >= thresholds.memory) warnings.push({ type: 'memory', label: `内存 ${snapshot.memory.usage}%` });
  const temperature = snapshot.battery.temperature ?? snapshot.thermal.hottest;
  if (temperature != null && temperature >= thresholds.batteryTemp) warnings.push({ type: 'batteryTemp', label: `温度 ${temperature}°C` });
  const highDisk = snapshot.disk.find(item => item.mount === '/data' && item.usage >= thresholds.dataUsed);
  if (highDisk) warnings.push({ type: 'disk', label: `存储空间 ${highDisk.usage}%` });
  return warnings;
}

function appendHistory(deviceId, snapshot, isVip) {
  const history = historyByDevice.get(deviceId) || [];
  history.push(snapshot);
  const limit = isVip ? VIP_HISTORY_LIMIT : FREE_HISTORY_LIMIT;
  while (history.length > limit) history.shift();
  historyByDevice.set(deviceId, history);
  lastSnapshotByDevice.set(deviceId, snapshot);
}

function broadcastUpdate(deviceId, payload) {
  ctx.broadcastToAllWindows('performance:update', { deviceId, ...payload });
}

function ensurePerformanceWorker() {
  if (performanceWorker) return performanceWorker;
  performanceWorker = new Worker(getPerformanceWorkerPath(), {
    workerData: {
      adbPath: getAdbCommand(),
      thresholds: readThresholds()
    }
  });
  performanceWorker.on('message', handleWorkerMessage);
  performanceWorker.on('error', handleWorkerFailure);
  performanceWorker.on('exit', (code) => {
    if (code !== 0) handleWorkerFailure(new Error(`性能采样 Worker 已退出：${code}`));
    performanceWorker = null;
  });
  return performanceWorker;
}

function getPerformanceWorkerPath() {
  const workerPath = path.join(__dirname, 'performance-worker.cjs');
  if (!app.isPackaged) return workerPath;
  const unpackedPath = workerPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : workerPath;
}

function handleWorkerMessage(message) {
  if (message?.type === 'response' && message.id) {
    const pending = workerRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    workerRequests.delete(message.id);
    pending.resolve(message);
    return;
  }
  if (message?.type === 'snapshot' && message.deviceId && message.snapshot) {
    appendHistory(message.deviceId, message.snapshot, monitors.get(message.deviceId)?.vip === true);
    broadcastUpdate(message.deviceId, { ok: true, snapshot: message.snapshot });
    return;
  }
  if (message?.type === 'monitorError' && message.deviceId) {
    broadcastUpdate(message.deviceId, { ok: false, error: message.error || '性能采样失败', timestamp: message.timestamp || Date.now() });
  }
}

function handleWorkerFailure(error) {
  workerRequests.forEach(pending => {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: error.message || '性能采样 Worker 异常' });
  });
  workerRequests.clear();
  monitors.forEach(monitor => {
    monitor.running = false;
    monitor.inFlight = false;
  });
}

function requestWorker(action, payload = {}, timeoutMs = 5000) {
  let worker;
  try {
    worker = ensurePerformanceWorker();
  } catch (error) {
    return Promise.resolve({ ok: false, error: error.message || 'worker_unavailable' });
  }
  const id = `perf-${++workerRequestSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      workerRequests.delete(id);
      resolve({ ok: false, error: 'worker_timeout' });
    }, timeoutMs);
    workerRequests.set(id, { resolve, timer });
    try {
      worker.postMessage({ id, action, ...payload });
    } catch (error) {
      clearTimeout(timer);
      workerRequests.delete(id);
      resolve({ ok: false, error: error.message || 'worker_post_failed' });
    }
  });
}

function postWorker(action, payload = {}) {
  try {
    ensurePerformanceWorker().postMessage({ action, ...payload, adbPath: getAdbCommand() });
  } catch {}
}

function sendReportProgress(task) {
  sendReportEvent(task, 'perf:reportProgress', publicReportTask(task));
}

function sendReportDone(task, payload) {
  sendReportEvent(task, 'perf:reportDone', { ...publicReportTask(task), result: payload });
}

function sendReportEvent(task, channel, payload) {
  if (task.sender && !task.sender.isDestroyed()) {
    task.sender.send(channel, payload);
    return;
  }
  ctx.broadcastToAllWindows(channel, payload);
}

function publicReportTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    taskId: task.id,
    deviceId: task.deviceId,
    status: task.status,
    startedAt: task.startedAt || null,
    progress: task.progress || null,
    result: task.result || null
  };
}

async function stopMonitor(deviceId) {
  const monitor = monitors.get(deviceId);
  if (!monitor) return false;
  monitor.running = false;
  monitors.delete(deviceId);
  await requestWorker('stop', { deviceId, adbPath: getAdbCommand() }, 3000).catch(() => {});
  // 停止监控时清理该设备的 FPS 差值状态，避免下次启动使用过期采样点。
  clearDeviceFpsState(deviceId);
  return true;
}

function publicMonitor(monitor) {
  if (!monitor) return null;
  return {
    deviceId: monitor.deviceId,
    intervalMs: monitor.intervalMs,
    includeProcesses: monitor.includeProcesses,
    running: monitor.running === true,
    startedAt: monitor.startedAt || null,
    inFlight: monitor.inFlight === true,
    worker: true
  };
}

function cleanup() {
  monitors.clear();
  workerRequests.forEach(pending => {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: 'cleanup' });
  });
  workerRequests.clear();
  if (performanceWorker) {
    try { performanceWorker.postMessage({ action: 'shutdown' }); } catch {}
    try { performanceWorker.terminate(); } catch {}
    performanceWorker = null;
  }
}

function runAdb(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return runRuntimeAdb(args, { timeoutMs });
}

function readThresholds() {
  if (thresholdCache) return thresholdCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(getThresholdPath(), 'utf8'));
    thresholdCache = { ...DEFAULT_THRESHOLDS, ...sanitizeThresholds(parsed) };
  } catch {
    thresholdCache = { ...DEFAULT_THRESHOLDS };
  }
  return thresholdCache;
}

function writeThresholds(thresholds) {
  thresholdCache = { ...DEFAULT_THRESHOLDS, ...sanitizeThresholds(thresholds) };
  fs.mkdirSync(path.dirname(getThresholdPath()), { recursive: true });
  fs.writeFileSync(getThresholdPath(), JSON.stringify(thresholdCache, null, 2), 'utf8');
}

function sanitizeThresholds(value) {
  const next = {};
  ['cpu', 'memory', 'batteryTemp', 'dataUsed'].forEach(key => {
    const n = Number(value[key]);
    if (Number.isFinite(n)) next[key] = Math.max(1, Math.min(100, n));
  });
  return next;
}

async function writeExport(deviceId, history, outputPath, outputBaseDir) {
  const filePath = await resolvePerformanceFile(deviceId, outputPath, outputBaseDir, 'performance', 'json');
  await fs.promises.writeFile(filePath, JSON.stringify({ deviceId, exportedAt: new Date().toISOString(), history }, null, 2), 'utf8');
  return filePath;
}

async function writeReport(deviceId, history, outputPath, outputBaseDir, includeAiSummary, onProgress) {
  onProgress?.({ percent: 15, message: '统计性能采样数据' });
  const filePath = await resolvePerformanceFile(deviceId, outputPath, outputBaseDir, 'performance-report', 'md');
  const summary = summarizeHistory(history);
  const warningRows = history
    .flatMap(item => (item.warnings || []).map(warning => ({ at: item.timestamp, ...warning })))
    .slice(-50);
  onProgress?.({ percent: includeAiSummary ? 45 : 75, message: includeAiSummary ? '生成 AI 分析' : '写入性能报告' });
  const aiSummary = includeAiSummary ? await buildPerformanceAiSummary(deviceId, history, summary, warningRows) : { ok: false, skipped: true, summary: '' };
  onProgress?.({ percent: 85, message: '写入性能报告' });
  await fs.promises.writeFile(filePath, buildPerformanceReport(deviceId, history, aiSummary), 'utf8');
  return { path: filePath, aiSummary };
}

async function resolvePerformanceFile(deviceId, outputPath, outputBaseDir, prefix, extension) {
  const baseDir = outputBaseDir && typeof outputBaseDir === 'string'
    ? path.resolve(outputBaseDir)
    : path.join(app.getPath('userData'), EXPORT_DIR);
  await fs.promises.mkdir(baseDir, { recursive: true });
  if (outputPath && typeof outputPath === 'string') {
    return path.resolve(outputPath);
  }
  return path.join(baseDir, `${prefix}-${sanitizeName(deviceId)}-${formatStamp(new Date())}.${extension}`);
}

function buildPerformanceReport(deviceId, history, aiSummary) {
  const summary = summarizeHistory(history);
  const latest = history[history.length - 1] || {};
  const warningRows = history
    .flatMap(item => (item.warnings || []).map(warning => ({ at: item.timestamp, ...warning })))
    .slice(-50);
  const lines = [
    '# 性能分析报告',
    '',
    '## 概要',
    '',
    `- 设备 ID：${deviceId}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 样本数量：${history.length}`,
    `- 时间范围：${formatIso(summary.startedAt)} ~ ${formatIso(summary.endedAt)}`,
    '',
    '## 指标统计',
    '',
    '| 指标 | 平均 | 峰值 | 最近一次 |',
    '| --- | ---: | ---: | ---: |',
    `| CPU | ${formatPercent(summary.cpu.avg)} | ${formatPercent(summary.cpu.max)} | ${formatPercent(latest.cpu?.usage)} |`,
    `| 内存 | ${formatPercent(summary.memory.avg)} | ${formatPercent(summary.memory.max)} | ${formatPercent(latest.memory?.usage)} |`,
    `| 存储空间 | ${formatPercent(summary.data.avg)} | ${formatPercent(summary.data.max)} | ${formatPercent(getDataDisk(latest)?.usage)} |`,
    `| 温度 | ${formatTemp(summary.temperature.avg)} | ${formatTemp(summary.temperature.max)} | ${formatTemp(getDeviceTemperature(latest))} |`,
    `| 前台 FPS | ${formatFps(summary.foregroundFps.avg)} | ${formatFps(summary.foregroundFps.max)} | ${formatFps(latest.fps?.foreground?.fps)} |`,
    `| 合成 FPS | ${formatFps(summary.surfaceFps.avg)} | ${formatFps(summary.surfaceFps.max)} | ${formatFps(latest.fps?.surfaceFlinger?.fps)} |`,
    '',
    '## 告警',
    ''
  ];

  if (warningRows.length === 0) {
    lines.push('- 采样窗口内未触发阈值告警');
  } else {
    warningRows.forEach(item => lines.push(`- ${formatIso(item.at)}：${item.label}`));
  }

  lines.push('', '## 最近进程占用', '');
  const processes = latest.processes || [];
  if (processes.length === 0) {
    lines.push('- 无进程明细数据');
  } else {
    lines.push('| PID | 进程 | CPU | 内存 |', '| --- | --- | ---: | ---: |');
    processes.slice(0, 12).forEach(proc => {
      lines.push(`| ${proc.pid || '-'} | ${escapeTable(proc.name || '-')} | ${formatPercent(proc.cpu)} | ${formatPercent(proc.memory)} |`);
    });
  }

  lines.push('', '## 结论', '', buildPerformanceConclusion(summary, warningRows), '', '## AI 分析', '', ...formatAiAnalysisLines(aiSummary), '');
  return lines.join('\n');
}

function formatAiAnalysisLines(aiSummary) {
  if (!aiSummary || aiSummary.skipped) return ['- 未勾选 AI 分析'];
  if (!aiSummary.ok) return [`- AI 分析未生成：${aiSummary.error || '未知错误'}`];
  const lines = String(aiSummary.summary || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  return lines.some(Boolean) ? lines : ['- AI 分析为空'];
}

async function buildPerformanceAiSummary(deviceId, history, summary, warnings) {
  const latest = history[history.length - 1] || {};
  const processes = (latest.processes || [])
    .slice(0, 8)
    .map(item => `- ${item.name || '-'} pid=${item.pid || '-'} cpu=${formatPercent(item.cpu)} mem=${formatPercent(item.memory)}`)
    .join('\n') || '- 无';
  const warningText = warnings
    .slice(-20)
    .map(item => `- ${formatIso(item.at)} ${item.label}`)
    .join('\n') || '- 无';
  const prompt = [
    `设备 ID: ${deviceId}`,
    `样本数: ${history.length}`,
    `时间范围: ${formatIso(summary.startedAt)} ~ ${formatIso(summary.endedAt)}`,
    '',
    '指标统计:',
    `- CPU 平均 ${formatPercent(summary.cpu.avg)} 峰值 ${formatPercent(summary.cpu.max)}`,
    `- 内存 平均 ${formatPercent(summary.memory.avg)} 峰值 ${formatPercent(summary.memory.max)}`,
    `- 存储空间 平均 ${formatPercent(summary.data.avg)} 峰值 ${formatPercent(summary.data.max)}`,
    `- 温度 平均 ${formatTemp(summary.temperature.avg)} 峰值 ${formatTemp(summary.temperature.max)}`,
    `- 前台 FPS 平均 ${formatFps(summary.foregroundFps.avg)} 峰值 ${formatFps(summary.foregroundFps.max)}`,
    `- 合成 FPS 平均 ${formatFps(summary.surfaceFps.avg)} 峰值 ${formatFps(summary.surfaceFps.max)}`,
    '',
    '告警:',
    warningText,
    '',
    '最近进程占用:',
    processes,
    '',
    '请输出一段面向 Android 性能排查的中文 AI 总结，包含：总体判断、风险点、建议验证动作。不要编造未提供的数据。'
  ].join('\n');
  return aiAnalyze.generateAiSummary({
    systemPrompt: '你是 Android 性能分析报告助手，只根据给定性能指标输出简洁、可执行的中文结论。',
    userContent: prompt,
    timeoutMs: 60000,
    temperature: 0.2
  });
}

function summarizeHistory(history) {
  const values = {
    cpu: history.map(item => item.cpu?.usage),
    memory: history.map(item => item.memory?.usage),
    data: history.map(item => getDataDisk(item)?.usage),
    temperature: history.map(getDeviceTemperature),
    foregroundFps: history.map(item => item.fps?.foreground?.fps),
    surfaceFps: history.map(item => item.fps?.surfaceFlinger?.fps)
  };
  return {
    startedAt: history[0]?.timestamp,
    endedAt: history[history.length - 1]?.timestamp,
    cpu: summarizeNumbers(values.cpu),
    memory: summarizeNumbers(values.memory),
    data: summarizeNumbers(values.data),
    temperature: summarizeNumbers(values.temperature),
    foregroundFps: summarizeNumbers(values.foregroundFps),
    surfaceFps: summarizeNumbers(values.surfaceFps)
  };
}

function summarizeNumbers(values) {
  const nums = values.filter(Number.isFinite);
  if (nums.length === 0) return { avg: null, max: null };
  return {
    avg: Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(1)),
    max: Number(Math.max(...nums).toFixed(1))
  };
}

function buildPerformanceConclusion(summary, warnings) {
  const items = [];
  if (summary.cpu.max != null && summary.cpu.max >= readThresholds().cpu) items.push(`CPU 峰值达到 ${formatPercent(summary.cpu.max)}`);
  if (summary.memory.max != null && summary.memory.max >= readThresholds().memory) items.push(`内存峰值达到 ${formatPercent(summary.memory.max)}`);
  if (summary.temperature.max != null && summary.temperature.max >= readThresholds().batteryTemp) items.push(`温度峰值达到 ${formatTemp(summary.temperature.max)}`);
  if (summary.data.max != null && summary.data.max >= readThresholds().dataUsed) items.push(`存储空间使用率峰值达到 ${formatPercent(summary.data.max)}`);
  if (warnings.length > 0) items.push(`采样期间触发 ${warnings.length} 条阈值告警`);
  return items.length === 0 ? '- 采样窗口内未发现明确性能风险。' : items.map(item => `- ${item}`).join('\n');
}

function getDataDisk(snapshot) {
  const disks = snapshot?.disk || [];
  return disks.find(item => item.mount === '/data') || disks.find(item => item.mount === '/storage/emulated') || null;
}

function getDeviceTemperature(snapshot) {
  const batteryTemp = snapshot?.battery?.temperature;
  if (batteryTemp != null && batteryTemp > 0) return batteryTemp;
  return snapshot?.thermal?.hottest ?? null;
}

function formatIso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : '-';
}

function formatPercent(value) {
  return value == null ? '-' : `${Number(value).toFixed(1)}%`;
}

function formatTemp(value) {
  return value == null ? '-' : `${Number(value).toFixed(1)}°C`;
}

function formatFps(value) {
  return value == null ? '-' : `${Number(value).toFixed(1)} FPS`;
}

function escapeTable(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function getThresholdPath() {
  return path.join(app.getPath('userData'), THRESHOLDS_FILE);
}

function normalizeInterval(value, isVip) {
  const requested = Number(value) || DEFAULT_INTERVAL_MS;
  const min = isVip ? VIP_MIN_INTERVAL_MS : FREE_MIN_INTERVAL_MS;
  return Math.max(min, Math.min(60000, requested));
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function sanitizeName(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'device';
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function firstNumber(text, regex) {
  const match = String(text || '').match(regex);
  return match ? Number(match[1]) : null;
}

function firstText(text, regex) {
  const match = String(text || '').match(regex);
  return match ? String(match[1] || '').trim() : '';
}

function firstPercent(parts) {
  const value = parts.find(part => /%$/.test(part));
  return value ? Number(value.replace('%', '')) : null;
}

module.exports = { register, cleanup, collectSnapshot };
