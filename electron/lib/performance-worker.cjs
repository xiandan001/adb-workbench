const { tr, setLocale, withLocale } = require('./localization.cjs');
const { parentPort, workerData } = require('worker_threads');
setLocale(workerData?.locale === 'en-US' ? 'en-US' : 'zh-CN');
const { execFile } = require('child_process');

const DEFAULT_THRESHOLDS = {
  cpu: 85,
  memory: 85,
  batteryTemp: 45,
  dataUsed: 90
};

const CORE_TIMEOUT_MS = 2500;
const HEAVY_TIMEOUT_MS = 3000;
const MAX_BUFFER = 4 * 1024 * 1024;
const CORE_MARKERS = {
  stat: '__SCRCPY_GUI_STAT__',
  meminfo: '__SCRCPY_GUI_MEMINFO__',
  disk: '__SCRCPY_GUI_DISK__',
  battery: '__SCRCPY_GUI_BATTERY__',
  thermal: '__SCRCPY_GUI_THERMAL__'
};

let adbPath = workerData?.adbPath || 'adb';
let thresholds = { ...DEFAULT_THRESHOLDS, ...(workerData?.thresholds || {}) };

const monitors = new Map();
const cpuTicksByDevice = new Map();
const lastSnapshotByDevice = new Map();
const snapshotRequestsByDevice = new Map();
const looseProcs = new Set();

parentPort.on('message', (message) => {
  withLocale(message?.locale, () => handleMessage(message)).catch(error => {
    if (message?.id) {
      parentPort.postMessage({ type: 'response', id: message.id, ok: false, error: error.message });
    } else {
      parentPort.postMessage({ type: 'workerError', error: error.message });
    }
  });
});

async function handleMessage(message) {
  if (message?.adbPath) adbPath = message.adbPath;
  if (message?.thresholds) thresholds = { ...DEFAULT_THRESHOLDS, ...sanitizeThresholds(message.thresholds) };

  if (message.action === 'start') {
    startMonitor(message);
    respond(message.id, { ok: true, deviceId: message.deviceId });
    return;
  }
  if (message.action === 'stop') {
    const stopped = stopMonitor(message.deviceId);
    respond(message.id, { ok: true, stopped });
    return;
  }
  if (message.action === 'snapshot') {
    const snapshot = await collectSnapshotForRequest(message.deviceId, {
      includeProcesses: message.includeProcesses === true,
      forceHeavy: message.forceHeavy !== false,
      timeoutMs: CORE_TIMEOUT_MS
    });
    respond(message.id, { ok: true, snapshot });
    return;
  }
  if (message.action === 'updateThresholds') {
    thresholds = { ...DEFAULT_THRESHOLDS, ...sanitizeThresholds(message.thresholds || {}) };
    respond(message.id, { ok: true });
    return;
  }
  if (message.action === 'shutdown') {
    Array.from(monitors.keys()).forEach(stopMonitor);
    looseProcs.forEach(killProc);
    looseProcs.clear();
    respond(message.id, { ok: true });
  }
}

function startMonitor(message) {
  const deviceId = normalizeDeviceId(message.deviceId);
  if (!deviceId) throw new Error('device_required');
  stopMonitor(deviceId);
  const intervalMs = normalizeInterval(message.intervalMs);
  const monitor = {
    deviceId,
    intervalMs,
    includeProcesses: message.includeProcesses === true,
    running: true,
    startedAt: message.startedAt || new Date().toISOString(),
    sampleIndex: 0,
    coreInFlight: false,
    heavyInFlight: false,
    currentProc: null,
    heavyProc: null,
    heavyProcs: new Set(),
    lastHeavyAt: 0
  };
  monitors.set(deviceId, monitor);
  runMonitorTick(monitor);
  monitor.timer = setInterval(() => runMonitorTick(monitor), intervalMs);
}

function stopMonitor(deviceId) {
  const key = normalizeDeviceId(deviceId);
  const monitor = monitors.get(key);
  if (!monitor) return false;
  monitor.running = false;
  if (monitor.timer) clearInterval(monitor.timer);
  killProc(monitor.currentProc);
  killProc(monitor.heavyProc);
  monitor.heavyProcs?.forEach(killProc);
  monitor.heavyProcs?.clear?.();
  monitors.delete(key);
  cpuTicksByDevice.delete(key);
  lastSnapshotByDevice.delete(key);
  snapshotRequestsByDevice.delete(key);
  return true;
}

async function runMonitorTick(monitor) {
  if (!monitor.running || monitor.coreInFlight) return;
  monitor.coreInFlight = true;
  monitor.sampleIndex += 1;
  try {
    const snapshot = await collectCoreSnapshot(monitor.deviceId, {
      monitor,
      includeProcesses: false,
      timeoutMs: Math.max(800, Math.min(CORE_TIMEOUT_MS, monitor.intervalMs - 200 || CORE_TIMEOUT_MS))
    });
    if (!monitor.running || monitors.get(monitor.deviceId) !== monitor) return;
    lastSnapshotByDevice.set(monitor.deviceId, snapshot);
    parentPort.postMessage({ type: 'snapshot', deviceId: monitor.deviceId, snapshot });
    maybeStartHeavySample(monitor);
  } catch (error) {
    if (monitor.running && monitors.get(monitor.deviceId) === monitor) {
      parentPort.postMessage({ type: 'monitorError', deviceId: monitor.deviceId, error: error.message, timestamp: Date.now() });
    }
  } finally {
    monitor.coreInFlight = false;
  }
}

async function collectCoreSnapshot(deviceId, options = {}) {
  const monitor = options.monitor || null;
  const previous = lastSnapshotByDevice.get(deviceId) || null;
  const timeoutMs = options.timeoutMs || CORE_TIMEOUT_MS;
  const core = await runAdb(['-s', deviceId, 'shell', buildCoreCommand()], timeoutMs, monitor, 'currentProc');
  const sections = splitCoreSections(core.stdout || '');
  const snapshot = {
    timestamp: Date.now(),
    deviceId,
    cpu: core.ok ? parseCpu(deviceId, sections.stat) : previous?.cpu || { usage: null },
    memory: core.ok ? parseMeminfo(sections.meminfo) : previous?.memory || parseMeminfo(''),
    disk: core.ok ? parseDisk(sections.disk) : previous?.disk || [],
    battery: core.ok ? parseBattery(sections.battery) : previous?.battery || parseBattery(''),
    thermal: core.ok ? parseThermal(sections.thermal) : previous?.thermal || parseThermal(''),
    fps: previous?.fps || buildEmptyFps(''),
    processes: previous?.processes || [],
    warnings: [],
    sampleError: core.ok ? '' : core.error || core.stderr || tr("采样超时")
  };
  if (options.forceHeavy) {
    const heavy = await collectHeavySnapshot(deviceId, options.includeProcesses === true, monitor);
    snapshot.fps = heavy.fps || snapshot.fps;
    snapshot.processes = heavy.processes || snapshot.processes;
  }
  snapshot.warnings = buildWarnings(snapshot, thresholds);
  lastSnapshotByDevice.set(deviceId, snapshot);
  return snapshot;
}

async function collectSnapshotForRequest(deviceId, options = {}) {
  const key = normalizeDeviceId(deviceId);
  if (!key) throw new Error('device_required');

  const monitor = monitors.get(key);
  const previous = lastSnapshotByDevice.get(key);
  const maxSnapshotAge = monitor ? Math.max(5000, monitor.intervalMs * 2) : 0;
  if (monitor?.running && previous && Date.now() - previous.timestamp <= maxSnapshotAge) {
    return previous;
  }

  const existing = snapshotRequestsByDevice.get(key);
  if (existing) return existing;

  const request = collectCoreSnapshot(key, options)
    .finally(() => {
      if (snapshotRequestsByDevice.get(key) === request) snapshotRequestsByDevice.delete(key);
    });
  snapshotRequestsByDevice.set(key, request);
  return request;
}

function maybeStartHeavySample(monitor) {
  const now = Date.now();
  const heavyInterval = Math.max(15000, monitor.intervalMs * 5);
  if (monitor.heavyInFlight || now - monitor.lastHeavyAt < heavyInterval) return;
  monitor.heavyInFlight = true;
  monitor.lastHeavyAt = now;
  collectHeavySnapshot(monitor.deviceId, monitor.includeProcesses, monitor)
    .then(heavy => {
      const previous = lastSnapshotByDevice.get(monitor.deviceId);
      if (!previous || !monitor.running) return;
      const snapshot = {
        ...previous,
        timestamp: Date.now(),
        fps: heavy.fps || previous.fps,
        processes: heavy.processes || previous.processes || []
      };
      snapshot.warnings = buildWarnings(snapshot, thresholds);
      lastSnapshotByDevice.set(monitor.deviceId, snapshot);
      parentPort.postMessage({ type: 'snapshot', deviceId: monitor.deviceId, snapshot });
    })
    .catch(() => {})
    .finally(() => {
      monitor.heavyInFlight = false;
    });
}

async function collectHeavySnapshot(deviceId, includeProcesses, monitor) {
  const fps = await collectFps(deviceId, monitor).catch(error => buildEmptyFps(error.message));
  const top = includeProcesses ? await runTop(deviceId, monitor) : { ok: true, stdout: '' };
  return {
    processes: includeProcesses ? parseTop(top.stdout) : lastSnapshotByDevice.get(deviceId)?.processes || [],
    fps
  };
}

function buildCoreCommand() {
  return [
    `echo ${CORE_MARKERS.stat}`,
    'cat /proc/stat',
    `echo ${CORE_MARKERS.meminfo}`,
    'cat /proc/meminfo',
    `echo ${CORE_MARKERS.disk}`,
    'df -k',
    `echo ${CORE_MARKERS.battery}`,
    'dumpsys battery',
    `echo ${CORE_MARKERS.thermal}`,
    'dumpsys thermalservice'
  ].join('; ');
}

function splitCoreSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = { stat: '', meminfo: '', disk: '', battery: '', thermal: '' };
  let current = '';
  const markerToKey = Object.fromEntries(Object.entries(CORE_MARKERS).map(([key, marker]) => [marker, key]));
  lines.forEach(line => {
    const key = markerToKey[line.trim()];
    if (key) {
      current = key;
      return;
    }
    if (current) sections[current] += `${line}\n`;
  });
  return sections;
}

async function runTop(deviceId, monitor) {
  const preferred = await runAdb(['-s', deviceId, 'shell', 'top', '-b', '-n', '1', '-m', '12'], HEAVY_TIMEOUT_MS, monitor, 'heavyProc');
  if (preferred.ok && preferred.stdout.trim()) return preferred;
  return runAdb(['-s', deviceId, 'shell', 'toybox', 'top', '-b', '-n', '1', '-m', '12'], HEAVY_TIMEOUT_MS, monitor, 'heavyProc');
}

async function collectFps(deviceId, monitor) {
  const foreground = await getForegroundApp(deviceId, monitor);
  const foregroundFps = await collectForegroundFps(deviceId, foreground, monitor);
  const surfaceFlingerFps = await collectSurfaceFlingerFps(deviceId, monitor);
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

async function getForegroundApp(deviceId, monitor) {
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'window'], HEAVY_TIMEOUT_MS, monitor, 'heavyProc');
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

async function collectForegroundFps(deviceId, foreground, monitor) {
  if (!foreground.packageName) return { fps: null, ...foreground, source: 'window' };
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', foreground.packageName, 'framestats'], HEAVY_TIMEOUT_MS, monitor, 'heavyProc');
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
  const rows = parseGfxFrameRows(text);
  const targetFrameNs = getTargetFrameNs(rows);
  const targetFps = targetFrameNs ? framePeriodToFps(targetFrameNs) : null;
  return {
    fps: targetFps,
    rawFps: targetFps,
    targetFps,
    frames: 0,
    state: 'low_frequency',
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
  const intervalIndex = header.indexOf('FrameInterval');
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.startsWith('---PROFILEDATA---')) break;
    const parts = line.split(',');
    const flags = Number(parts[0]);
    if (flags !== 0) continue;
    const intended = Number(parts[intendedIndex]);
    const frameInterval = Number(parts[intervalIndex]);
    if (Number.isFinite(intended) && intended > 0) {
      rows.push({ intended, frameInterval: Number.isFinite(frameInterval) && frameInterval > 0 ? frameInterval : null });
    }
  }
  return rows;
}

async function collectSurfaceFlingerFps(deviceId, monitor) {
  const layer = '';
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'SurfaceFlinger', '--latency'], HEAVY_TIMEOUT_MS, monitor, 'heavyProc');
  const framePeriodNs = parseFramePeriod(res.stdout);
  const refreshRate = framePeriodToFps(framePeriodNs);
  return {
    fps: refreshRate,
    layer,
    refreshRate,
    framePeriodMs: framePeriodNs ? Number((framePeriodNs / 1e6).toFixed(2)) : null,
    state: 'refresh_rate',
    source: 'surfaceflinger',
    error: res.ok ? '' : res.error || res.stderr || ''
  };
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

function buildWarnings(snapshot, value) {
  const warnings = [];
  if (snapshot.cpu.usage != null && snapshot.cpu.usage >= value.cpu) warnings.push({ type: 'cpu', label: `CPU ${snapshot.cpu.usage}%` });
  if (snapshot.memory.usage != null && snapshot.memory.usage >= value.memory) warnings.push({ type: 'memory', label: tr("内存 {0}%", { 0: snapshot.memory.usage }) });
  const temperature = snapshot.battery.temperature ?? snapshot.thermal.hottest;
  if (temperature != null && temperature >= value.batteryTemp) warnings.push({ type: 'batteryTemp', label: tr("温度 {0}°C", { 0: temperature }) });
  const highDisk = snapshot.disk.find(item => item.mount === '/data' && item.usage >= value.dataUsed);
  if (highDisk) warnings.push({ type: 'disk', label: tr("存储空间 {0}%", { 0: highDisk.usage }) });
  return warnings;
}

function runAdb(args, timeoutMs, monitor, procKey) {
  return new Promise((resolve) => {
    const proc = execFile(adbPath, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (monitor && monitor[procKey] === proc) monitor[procKey] = null;
      if (monitor && procKey === 'heavyProc') monitor.heavyProcs?.delete?.(proc);
      if (!monitor) looseProcs.delete(proc);
      if (error) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', error: stderr || error.message });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    });
    if (monitor) {
      monitor[procKey] = proc;
      if (procKey === 'heavyProc') monitor.heavyProcs?.add?.(proc);
    } else {
      looseProcs.add(proc);
    }
    proc.stdin?.end?.();
  });
}

function respond(id, payload) {
  if (id) parentPort.postMessage({ type: 'response', id, ...payload });
}

function killProc(proc) {
  try { proc?.kill?.(); } catch {}
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function normalizeInterval(value) {
  const requested = Number(value) || 3000;
  return Math.max(1000, Math.min(60000, requested));
}

function sanitizeThresholds(value) {
  const next = {};
  ['cpu', 'memory', 'batteryTemp', 'dataUsed'].forEach(key => {
    const n = Number(value[key]);
    if (Number.isFinite(n)) next[key] = Math.max(1, Math.min(100, n));
  });
  return next;
}

function normalizeActivityName(packageName, activityName) {
  const value = String(activityName || '');
  return value.startsWith('.') ? `${packageName}${value}` : value;
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
