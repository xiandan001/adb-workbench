// Device guard: lightweight live monitoring with a final local report.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ctx = require('./app-context.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const { getAppVersion } = require('./version.cjs');
const { runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

const SETTINGS_FILE = 'settings.json';
const QUALITY_CENTER_DIR = 'quality-center';
const GUARD_DIR = 'device-guard';
const DEFAULT_INTERVAL_MS = 15000;
const COMMAND_TIMEOUT_MS = 12000;
const MAX_SAMPLES = 500;
const MAX_EVENTS = 200;
const stoppedHistory = [];
const activeGuards = new Map();

function register(ipcMain) {
  ipcMain.handle('device-guard:start', async (event, args) => {
    try {
      const deviceId = normalizeDeviceId(args?.deviceId);
      if (!deviceId) return { ok: false, error: 'device_required' };
      const existing = findGuardByDevice(deviceId);
      if (existing) return { ok: true, guard: publicGuard(existing), activeGuards: listActiveGuards() };
      const online = await checkDeviceOnline(deviceId);
      if (!online.ok) return { ok: false, error: online.error || `device_offline:${deviceId}` };
      const guard = createGuard(deviceId, args || {});
      activeGuards.set(guard.id, guard);
      scheduleGuardTick(guard, 0);
      broadcastState(guard);
      return { ok: true, guard: publicGuard(guard), activeGuards: listActiveGuards() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('device-guard:stop', async (event, args) => {
    try {
      const guard = findGuard(args || {});
      if (!guard) return { ok: false, error: 'guard_not_found' };
      const result = await stopGuard(guard, 'manual');
      return { ok: true, guard: result, activeGuards: listActiveGuards(), history: stoppedHistory.slice() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('device-guard:state', async () => ({
    ok: true,
    activeGuards: listActiveGuards(),
    history: stoppedHistory.slice()
  }));
}

function createGuard(deviceId, args) {
  const now = new Date();
  return {
    id: `guard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: String(args?.name || '').trim() || `${deviceId} 设备守护`,
    deviceId,
    startedAt: now.toISOString(),
    endedAt: '',
    status: 'running',
    intervalMs: clampNumber(args?.intervalMs, 5000, 300000, DEFAULT_INTERVAL_MS),
    thresholds: normalizeThresholds(args?.thresholds || {}),
    timer: null,
    busy: false,
    tickCount: 0,
    samples: [],
    events: [],
    lastSnapshot: null,
    lastError: '',
    outputDir: '',
    reportPath: '',
    summaryPath: ''
  };
}

function scheduleGuardTick(guard, delayMs) {
  if (guard.status !== 'running') return;
  if (guard.timer) clearTimeout(guard.timer);
  guard.timer = setTimeout(() => {
    guard.timer = null;
    runGuardTick(guard).catch(error => {
      guard.lastError = error.message || 'guard_tick_failed';
      addGuardEvent(guard, 'high', '守护采样异常', guard.lastError);
      broadcastState(guard);
    }).finally(() => {
      if (guard.status === 'running') scheduleGuardTick(guard, guard.intervalMs);
    });
  }, Math.max(0, delayMs));
  guard.timer.unref?.();
}

async function runGuardTick(guard) {
  if (guard.busy || guard.status !== 'running') return;
  guard.busy = true;
  guard.tickCount += 1;
  const at = new Date().toISOString();
  try {
    const online = await checkDeviceOnline(guard.deviceId);
    if (!online.ok) {
      addGuardEvent(guard, 'high', '设备离线', online.error || `device_offline:${guard.deviceId}`);
      appendSample(guard, { at, online: false, error: online.error || 'device_offline' });
      broadcastState(guard);
      return;
    }

    const [snapshotResult, logResult] = await Promise.all([
      performanceMonitor.collectSnapshot(guard.deviceId, false, { timeoutMs: COMMAND_TIMEOUT_MS, includeFps: true, fallbackToLegacy: true })
        .then(snapshot => ({ ok: true, snapshot }))
        .catch(error => ({ ok: false, error: error.message })),
      runAdb(['-s', guard.deviceId, 'shell', 'logcat -d -v threadtime -t 300'], COMMAND_TIMEOUT_MS)
    ]);

    const sample = {
      at,
      online: true,
      snapshot: snapshotResult.ok ? summarizeSnapshot(snapshotResult.snapshot) : null,
      error: snapshotResult.ok ? '' : snapshotResult.error || 'performance_snapshot_failed'
    };
    appendSample(guard, sample);
    if (snapshotResult.ok) {
      guard.lastSnapshot = snapshotResult.snapshot;
      evaluateSnapshot(guard, snapshotResult.snapshot);
    } else {
      addGuardEvent(guard, 'medium', '性能采样失败', snapshotResult.error || 'performance_snapshot_failed');
    }
    scanLogs(guard, logResult.output || logResult.stdout || '');
    broadcastState(guard);
  } finally {
    guard.busy = false;
  }
}

async function stopGuard(guard, reason) {
  guard.status = reason === 'cleanup' ? 'stopped' : 'finished';
  guard.endedAt = new Date().toISOString();
  if (guard.timer) {
    clearTimeout(guard.timer);
    guard.timer = null;
  }
  activeGuards.delete(guard.id);
  await writeGuardArtifacts(guard);
  const record = publicGuard(guard);
  stoppedHistory.unshift(record);
  if (stoppedHistory.length > 30) stoppedHistory.splice(30);
  broadcastState(guard);
  return record;
}

async function writeGuardArtifacts(guard) {
  const outputDir = path.join(getQualityCenterBaseDir(), GUARD_DIR, `guard-${formatStamp(new Date(guard.startedAt))}-${sanitizeName(guard.deviceId)}`);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'device-guard-result.json');
  const reportPath = path.join(outputDir, 'device-guard-report.md');
  const result = {
    version: 1,
    appVersion: getAppVersion(),
    id: guard.id,
    name: guard.name,
    deviceId: guard.deviceId,
    status: guard.status,
    startedAt: guard.startedAt,
    endedAt: guard.endedAt,
    intervalMs: guard.intervalMs,
    thresholds: guard.thresholds,
    tickCount: guard.tickCount,
    samples: guard.samples,
    events: guard.events
  };
  await fs.promises.writeFile(summaryPath, JSON.stringify(result, null, 2), 'utf8');
  await fs.promises.writeFile(reportPath, buildGuardReport(result), 'utf8');
  guard.outputDir = outputDir;
  guard.reportPath = reportPath;
  guard.summaryPath = summaryPath;
}

function evaluateSnapshot(guard, snapshot) {
  const sample = summarizeSnapshot(snapshot);
  const thresholds = guard.thresholds;
  if (Number.isFinite(sample.cpuUsage) && sample.cpuUsage >= thresholds.cpuUsage) {
    addGuardEvent(guard, 'medium', 'CPU 使用率过高', `${sample.cpuUsage}% >= ${thresholds.cpuUsage}%`);
  }
  if (Number.isFinite(sample.memoryUsage) && sample.memoryUsage >= thresholds.memoryUsage) {
    addGuardEvent(guard, 'medium', '内存使用率过高', `${sample.memoryUsage}% >= ${thresholds.memoryUsage}%`);
  }
  if (Number.isFinite(sample.temperature) && sample.temperature >= thresholds.temperature) {
    addGuardEvent(guard, 'high', '设备温度过高', `${sample.temperature}°C >= ${thresholds.temperature}°C`);
  }
}

function scanLogs(guard, text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const checks = [
    { label: 'Java Crash', severity: 'high', regex: /FATAL EXCEPTION|AndroidRuntime.*FATAL|java\.lang\.\w+Exception|NullPointerException/i },
    { label: 'ANR', severity: 'high', regex: /ANR in |Application Not Responding|am_anr/i },
    { label: 'Native Crash', severity: 'high', regex: /Fatal signal|SIGSEGV|SIGABRT|tombstone|backtrace:/i },
    { label: 'OOM', severity: 'medium', regex: /OutOfMemoryError|Failed to allocate|lowmemorykiller/i },
    { label: 'Watchdog', severity: 'medium', regex: /Watchdog|watchdog.*killed|Blocked in handler/i }
  ];
  for (const check of checks) {
    const line = lines.find(item => check.regex.test(item));
    if (line) addGuardEvent(guard, check.severity, check.label, trim(line, 260));
  }
}

function addGuardEvent(guard, severity, label, detail) {
  const fingerprint = `${severity}:${label}:${detail}`;
  const last = guard.events[guard.events.length - 1];
  if (last?.fingerprint === fingerprint) return;
  guard.events.push({
    at: new Date().toISOString(),
    severity,
    label,
    detail: String(detail || ''),
    fingerprint
  });
  if (guard.events.length > MAX_EVENTS) guard.events.splice(0, guard.events.length - MAX_EVENTS);
}

function appendSample(guard, sample) {
  guard.samples.push(sample);
  if (guard.samples.length > MAX_SAMPLES) guard.samples.splice(0, guard.samples.length - MAX_SAMPLES);
}

function publicGuard(guard) {
  return {
    id: guard.id,
    name: guard.name,
    deviceId: guard.deviceId,
    status: guard.status,
    startedAt: guard.startedAt,
    endedAt: guard.endedAt,
    intervalMs: guard.intervalMs,
    tickCount: guard.tickCount,
    busy: guard.busy,
    lastSample: guard.samples[guard.samples.length - 1] || null,
    events: guard.events.slice(-20).map(({ fingerprint, ...event }) => event),
    eventCount: guard.events.length,
    outputDir: guard.outputDir || '',
    reportPath: guard.reportPath || '',
    summaryPath: guard.summaryPath || ''
  };
}

function listActiveGuards() {
  return Array.from(activeGuards.values()).map(publicGuard);
}

function findGuard(args) {
  const guardId = String(args?.guardId || '').trim();
  if (guardId && activeGuards.has(guardId)) return activeGuards.get(guardId);
  const deviceId = normalizeDeviceId(args?.deviceId);
  return deviceId ? findGuardByDevice(deviceId) : null;
}

function findGuardByDevice(deviceId) {
  return Array.from(activeGuards.values()).find(item => item.deviceId === deviceId) || null;
}

function broadcastState(guard) {
  ctx.broadcastToAllWindows('device-guard:update', {
    guard: guard ? publicGuard(guard) : null,
    activeGuards: listActiveGuards(),
    history: stoppedHistory.slice()
  });
}

async function checkDeviceOnline(deviceId) {
  const state = await runAdb(['-s', deviceId, 'get-state'], COMMAND_TIMEOUT_MS);
  const online = state.ok && String(state.stdout || state.output || '').trim() === 'device';
  return online ? { ok: true } : { ok: false, error: state.error || state.stderr || `device_offline:${deviceId}` };
}

function runAdb(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return runRuntimeAdb(args, { timeoutMs }).then(res => ({
    ...res,
    output: res.ok ? (res.stdout || res.stderr || '') : trim(`${res.stdout || ''}${res.stderr || ''}`, 6000)
  }));
}

function summarizeSnapshot(snapshot) {
  return {
    cpuUsage: numberOrNull(snapshot?.cpu?.usage),
    memoryUsage: numberOrNull(snapshot?.memory?.usage),
    temperature: getTemperature(snapshot),
    dataUsage: getDataUsage(snapshot),
    foregroundPackage: snapshot?.foreground?.packageName || snapshot?.fps?.foreground?.packageName || '',
    foregroundFps: numberOrNull(snapshot?.fps?.foreground?.fps)
  };
}

function getTemperature(snapshot) {
  const candidates = [
    snapshot?.battery?.temperature,
    snapshot?.temperature?.battery,
    snapshot?.temperature?.max,
    snapshot?.thermal?.hottest
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

function getDataUsage(snapshot) {
  const disks = Array.isArray(snapshot?.disks) ? snapshot.disks : Array.isArray(snapshot?.disk) ? snapshot.disk : [];
  const data = disks.find(item => item.mount === '/data' || item.filesystem === '/data') || disks.find(item => String(item.mount || '').includes('/data'));
  return numberOrNull(data?.usage);
}

function buildGuardReport(result) {
  const eventStats = countEvents(result.events || []);
  const lines = [
    '# 设备守护报告',
    '',
    '## 概要',
    '',
    `- 名称：${result.name}`,
    `- 设备：${result.deviceId}`,
    `- 状态：${result.status}`,
    `- 开始时间：${result.startedAt}`,
    `- 结束时间：${result.endedAt || '-'}`,
    `- 采样间隔：${result.intervalMs}ms`,
    `- 采样次数：${result.tickCount}`,
    `- 事件总数：${result.events.length}`,
    `- 高风险：${eventStats.high}`,
    `- 中风险：${eventStats.medium}`,
    `- 应用版本：${result.appVersion}`,
    '',
    '## 最近事件',
    ''
  ];
  const recentEvents = (result.events || []).slice(-60);
  if (recentEvents.length === 0) {
    lines.push('- 未发现 Crash/ANR/OOM/Watchdog 或阈值告警', '');
  } else {
    lines.push('| 时间 | 级别 | 类型 | 详情 |', '| --- | --- | --- | --- |');
    recentEvents.forEach(event => {
      lines.push(`| ${escapeTable(event.at)} | ${escapeTable(event.severity)} | ${escapeTable(event.label)} | ${escapeTable(event.detail)} |`);
    });
    lines.push('');
  }
  lines.push('## 最近采样', '');
  const recentSamples = (result.samples || []).slice(-20);
  if (recentSamples.length === 0) {
    lines.push('- 无采样记录', '');
  } else {
    lines.push('| 时间 | 在线 | CPU | 内存 | 温度 | 前台应用 | FPS |', '| --- | --- | ---: | ---: | ---: | --- | ---: |');
    recentSamples.forEach(sample => {
      const snap = sample.snapshot || {};
      lines.push(`| ${escapeTable(sample.at)} | ${sample.online ? '是' : '否'} | ${formatMetric(snap.cpuUsage, '%')} | ${formatMetric(snap.memoryUsage, '%')} | ${formatMetric(snap.temperature, '°C')} | ${escapeTable(snap.foregroundPackage || '-')} | ${formatMetric(snap.foregroundFps, '')} |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function countEvents(events) {
  return {
    high: events.filter(item => item.severity === 'high').length,
    medium: events.filter(item => item.severity === 'medium').length
  };
}

function normalizeThresholds(value) {
  return {
    cpuUsage: clampNumber(value.cpuUsage, 1, 100, 90),
    memoryUsage: clampNumber(value.memoryUsage, 1, 100, 90),
    temperature: clampNumber(value.temperature, 1, 120, 45)
  };
}

function cleanup() {
  for (const guard of activeGuards.values()) {
    guard.status = 'stopped';
    if (guard.timer) clearTimeout(guard.timer);
    guard.timer = null;
  }
  activeGuards.clear();
}

function getQualityCenterBaseDir() {
  return readQualityCenterPath() || path.join(app.getPath('userData'), QUALITY_CENTER_DIR);
}

function readQualityCenterPath() {
  try {
    const settingsFilePath = path.join(app.getPath('userData'), SETTINGS_FILE);
    if (!fs.existsSync(settingsFilePath)) return '';
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    return String(settings.qualityCenterPath || '').trim();
  } catch {
    return '';
  }
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeName(value) {
  return String(value || 'item').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').slice(0, 80) || 'item';
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMetric(value, suffix) {
  return Number.isFinite(Number(value)) ? `${value}${suffix}` : '-';
}

function trim(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

module.exports = { register, cleanup };
