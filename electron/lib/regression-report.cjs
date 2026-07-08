// Regression difference reports: capture reusable baselines and compare current devices.

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const packageManager = require('./package-manager.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const { getAppVersion } = require('./version.cjs');

const BUNDLED_ADB_PATH = path.join(__dirname, '../../scrcpy-win64/adb.exe');
const SETTINGS_FILE = 'settings.json';
const QUALITY_CENTER_DIR = 'quality-center';
const BASELINE_DIR = 'regression-baselines';
const REPORT_DIR = 'regression-reports';
const COMMAND_TIMEOUT_MS = 20000;
const LOG_TIMEOUT_MS = 30000;
const MAX_BASELINES = 80;

const PROP_KEYS = [
  'ro.product.brand',
  'ro.product.manufacturer',
  'ro.product.model',
  'ro.product.device',
  'ro.product.name',
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.build.display.id',
  'ro.build.fingerprint',
  'ro.product.cpu.abi',
  'ro.serialno'
];

function register(ipcMain) {
  ipcMain.handle('regression:listBaselines', async () => {
    try {
      return { ok: true, baselines: await listBaselines() };
    } catch (error) {
      return { ok: false, error: error.message, baselines: [] };
    }
  });

  ipcMain.handle('regression:captureBaseline', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    try {
      const baseline = await captureBaseline(deviceId, {
        name: args?.name,
        includePerformance: args?.includePerformance !== false
      });
      return { ok: true, baseline };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('regression:deleteBaseline', async (event, args) => {
    const baselinePath = normalizeBaselinePath(args?.baselinePath);
    if (!baselinePath) return { ok: false, error: 'baseline_required' };
    try {
      await fs.promises.unlink(baselinePath);
      return { ok: true, baselines: await listBaselines() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('regression:run', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const baselinePath = normalizeBaselinePath(args?.baselinePath);
    if (!deviceId) return { ok: false, error: 'device_required' };
    if (!baselinePath) return { ok: false, error: 'baseline_required' };
    try {
      const result = await runRegression(deviceId, baselinePath, {
        name: args?.name,
        includePerformance: args?.includePerformance !== false
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

async function captureBaseline(deviceId, options = {}) {
  await ensureDeviceOnline(deviceId);
  const snapshot = await collectSnapshot(deviceId, options);
  const baseline = {
    version: 1,
    id: `baseline-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: String(options.name || '').trim() || `${snapshot.device.model || deviceId} 基线`,
    appVersion: getAppVersion(),
    deviceId,
    capturedAt: new Date().toISOString(),
    snapshot
  };
  const baselinePath = path.join(getBaselineBaseDir(), `${sanitizeName(baseline.name)}-${sanitizeName(deviceId)}-${formatStamp(new Date())}.json`);
  await fs.promises.mkdir(path.dirname(baselinePath), { recursive: true });
  await writeJson(baselinePath, baseline);
  return toPublicBaseline(baselinePath, baseline);
}

async function runRegression(deviceId, baselinePath, options = {}) {
  await ensureDeviceOnline(deviceId);
  const baseline = readJson(baselinePath);
  if (!baseline?.snapshot) throw new Error('baseline_invalid');
  const current = await collectSnapshot(deviceId, options);
  const comparedAt = new Date();
  const outputDir = path.join(getReportBaseDir(), `regression-${formatStamp(comparedAt)}-${sanitizeName(deviceId)}`);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const diff = compareSnapshots(baseline.snapshot, current);
  const status = diff.highCount > 0 ? 'failed' : diff.mediumCount > 0 ? 'attention' : 'passed';
  const result = {
    version: 1,
    id: `regression-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: String(options.name || '').trim() || `${current.device.model || deviceId} 回归差异报告`,
    appVersion: getAppVersion(),
    status,
    baseline: {
      name: baseline.name || path.basename(baselinePath),
      path: baselinePath,
      deviceId: baseline.deviceId || baseline.snapshot.deviceId || '',
      capturedAt: baseline.capturedAt || baseline.snapshot.capturedAt || ''
    },
    deviceId,
    comparedAt: comparedAt.toISOString(),
    outputDir,
    diff,
    current
  };
  const summaryPath = path.join(outputDir, 'regression-result.json');
  const reportPath = path.join(outputDir, 'regression-report.md');
  await writeJson(summaryPath, result);
  await fs.promises.writeFile(reportPath, buildRegressionReport(result), 'utf8');
  return { ...result, reportPath, summaryPath };
}

async function collectSnapshot(deviceId, options = {}) {
  const [propsResult, packagesResult, logResult, crashLogResult, performance] = await Promise.all([
    runAdb(['-s', deviceId, 'shell', 'getprop'], COMMAND_TIMEOUT_MS),
    packageManager.listPackages(deviceId).then(packages => ({ ok: true, packages })).catch(error => ({ ok: false, error: error.message, packages: [] })),
    runAdb(['-s', deviceId, 'logcat', '-d', '-v', 'threadtime', '-t', '600'], LOG_TIMEOUT_MS),
    runAdb(['-s', deviceId, 'logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', '200'], LOG_TIMEOUT_MS),
    options.includePerformance === false
      ? Promise.resolve({ ok: false, skipped: true, snapshot: null })
      : performanceMonitor.collectSnapshot(deviceId, false, { timeoutMs: 12000, includeFps: true, fallbackToLegacy: true })
        .then(snapshot => ({ ok: true, snapshot }))
        .catch(error => ({ ok: false, error: error.message, snapshot: null }))
  ]);
  const props = parseGetprop(propsResult.stdout || '');
  return {
    deviceId,
    capturedAt: new Date().toISOString(),
    device: buildDeviceInfo(props),
    props,
    packages: packagesResult.packages || [],
    packageError: packagesResult.ok ? '' : packagesResult.error || 'package_list_failed',
    performance: performance.snapshot,
    performanceError: performance.ok || performance.skipped ? '' : performance.error || 'performance_snapshot_failed',
    logs: analyzeLogs(`${logResult.stdout || ''}\n${crashLogResult.stdout || ''}`),
    logError: [logResult, crashLogResult].filter(item => !item.ok).map(item => item.error || item.stderr).filter(Boolean).join('\n')
  };
}

function compareSnapshots(baseline, current) {
  const propDiffs = compareProps(baseline.props || {}, current.props || {});
  const packageDiff = comparePackages(baseline.packages || [], current.packages || []);
  const performanceDiff = comparePerformance(baseline.performance, current.performance);
  const logIssues = current.logs?.issues || [];
  const findings = [];

  propDiffs.forEach(item => findings.push({ severity: isCriticalProp(item.key) ? 'high' : 'medium', label: `系统属性变化：${item.key}`, detail: `${item.before || '-'} -> ${item.after || '-'}` }));
  packageDiff.removed.slice(0, 30).forEach(item => findings.push({ severity: item.system ? 'high' : 'medium', label: `应用减少：${item.packageName}`, detail: item.versionCode ? `versionCode ${item.versionCode}` : item.path || '' }));
  packageDiff.added.slice(0, 30).forEach(item => findings.push({ severity: item.system ? 'medium' : 'low', label: `应用新增：${item.packageName}`, detail: item.versionCode ? `versionCode ${item.versionCode}` : item.path || '' }));
  packageDiff.changed.slice(0, 50).forEach(item => findings.push({ severity: item.system ? 'medium' : 'low', label: `应用变化：${item.packageName}`, detail: item.changes.map(change => `${change.key}: ${change.before || '-'} -> ${change.after || '-'}`).join('; ') }));
  performanceDiff.warnings.forEach(item => findings.push({ severity: item.severity, label: item.label, detail: item.detail }));
  logIssues.slice(0, 30).forEach(item => findings.push({ severity: item.severity, label: `日志异常：${item.label}`, detail: item.detail }));

  const highCount = findings.filter(item => item.severity === 'high').length;
  const mediumCount = findings.filter(item => item.severity === 'medium').length;
  return {
    summary: findings.length === 0 ? '未发现回归差异' : `发现 ${findings.length} 项差异或风险`,
    highCount,
    mediumCount,
    lowCount: findings.length - highCount - mediumCount,
    propDiffs,
    packageDiff,
    performanceDiff,
    logIssues,
    findings
  };
}

function compareProps(before, after) {
  return PROP_KEYS
    .map(key => ({ key, before: before[key] || '', after: after[key] || '' }))
    .filter(item => item.before !== item.after);
}

function comparePackages(before, after) {
  const beforeMap = new Map(before.map(item => [item.packageName, item]));
  const afterMap = new Map(after.map(item => [item.packageName, item]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const item of after) {
    if (!beforeMap.has(item.packageName)) added.push(item);
  }
  for (const item of before) {
    if (!afterMap.has(item.packageName)) removed.push(item);
  }
  for (const [packageName, oldItem] of beforeMap.entries()) {
    const nextItem = afterMap.get(packageName);
    if (!nextItem) continue;
    const changes = ['versionCode', 'path', 'system', 'enabled']
      .map(key => ({ key, before: oldItem[key], after: nextItem[key] }))
      .filter(change => String(change.before ?? '') !== String(change.after ?? ''));
    if (changes.length) changed.push({ packageName, system: nextItem.system === true || oldItem.system === true, changes });
  }
  return { added, removed, changed };
}

function comparePerformance(before, after) {
  const warnings = [];
  if (!after) return { warnings: [{ severity: 'low', label: '当前性能快照未生成', detail: '请检查设备状态或 ADB 连接' }], metrics: [] };
  const metrics = [
    metricDelta('CPU', before?.cpu?.usage, after?.cpu?.usage, '%', 30),
    metricDelta('内存', before?.memory?.usage, after?.memory?.usage, '%', 20),
    metricDelta('存储空间', getDataUsage(before), getDataUsage(after), '%', 10),
    metricDelta('温度', getTemperature(before), getTemperature(after), '°C', 8),
    metricDelta('前台 FPS', before?.fps?.foreground?.fps, after?.fps?.foreground?.fps, ' FPS', -15)
  ].filter(Boolean);
  metrics.forEach(item => {
    if (item.regressed) warnings.push({ severity: item.severity, label: `性能回退：${item.label}`, detail: `${item.beforeText} -> ${item.afterText}` });
  });
  (after.warnings || []).forEach(item => warnings.push({ severity: 'medium', label: `性能告警：${item.label}`, detail: item.type || '' }));
  return { warnings, metrics };
}

function metricDelta(label, before, after, suffix, threshold) {
  if (!Number.isFinite(Number(after))) return null;
  const beforeNum = Number.isFinite(Number(before)) ? Number(before) : null;
  const afterNum = Number(after);
  const delta = beforeNum == null ? null : Number((afterNum - beforeNum).toFixed(1));
  let regressed = false;
  if (delta != null && threshold >= 0) regressed = delta >= threshold;
  if (delta != null && threshold < 0) regressed = delta <= threshold;
  return {
    label,
    before: beforeNum,
    after: afterNum,
    delta,
    beforeText: beforeNum == null ? '-' : `${beforeNum}${suffix}`,
    afterText: `${afterNum}${suffix}`,
    regressed,
    severity: label === 'CPU' || label === '内存' || label === '温度' ? 'medium' : 'low'
  };
}

function analyzeLogs(text) {
  const source = String(text || '');
  const patterns = [
    { label: 'Java Crash', severity: 'high', regex: /FATAL EXCEPTION|AndroidRuntime.*FATAL|java\.lang\.\w+Exception|NullPointerException/i },
    { label: 'ANR', severity: 'high', regex: /ANR in |Application Not Responding|am_anr/i },
    { label: 'Native Crash', severity: 'high', regex: /Fatal signal|SIGSEGV|SIGABRT|tombstone|backtrace:/i },
    { label: 'OOM', severity: 'medium', regex: /OutOfMemoryError|Failed to allocate|lowmemorykiller/i },
    { label: 'Watchdog', severity: 'medium', regex: /Watchdog|watchdog.*killed|Blocked in handler/i }
  ];
  const lines = source.split(/\r?\n/).filter(Boolean);
  const issues = [];
  for (const pattern of patterns) {
    const line = lines.find(item => pattern.regex.test(item));
    if (line) issues.push({ label: pattern.label, severity: pattern.severity, detail: trim(line, 220) });
  }
  return { lineCount: lines.length, issueCount: issues.length, issues };
}

function buildRegressionReport(result) {
  const { diff, baseline, current } = result;
  const lines = [
    '# 回归差异报告',
    '',
    '## 概要',
    '',
    `- 状态：${statusText(result.status)}`,
    `- 结论：${diff.summary}`,
    `- 当前设备：${result.deviceId}`,
    `- 当前型号：${current.device.model || '-'}`,
    `- 基线：${baseline.name || '-'}`,
    `- 基线设备：${baseline.deviceId || '-'}`,
    `- 基线时间：${baseline.capturedAt || '-'}`,
    `- 对比时间：${result.comparedAt}`,
    `- 应用版本：${result.appVersion}`,
    '',
    '## 风险汇总',
    '',
    `- 高风险：${diff.highCount}`,
    `- 中风险：${diff.mediumCount}`,
    `- 低风险：${diff.lowCount}`,
    ''
  ];

  if (diff.findings.length === 0) {
    lines.push('- 未发现差异或风险', '');
  } else {
    diff.findings.forEach(item => lines.push(`- [${item.severity}] ${item.label}：${item.detail || '-'}`));
    lines.push('');
  }

  lines.push('## 系统属性变化', '');
  if (diff.propDiffs.length === 0) lines.push('- 无');
  else {
    lines.push('| 属性 | 基线 | 当前 |', '| --- | --- | --- |');
    diff.propDiffs.forEach(item => lines.push(`| ${escapeTable(item.key)} | ${escapeTable(item.before || '-')} | ${escapeTable(item.after || '-')} |`));
  }

  lines.push('', '## 应用包变化', '');
  lines.push(`- 新增：${diff.packageDiff.added.length}`);
  lines.push(`- 删除：${diff.packageDiff.removed.length}`);
  lines.push(`- 变化：${diff.packageDiff.changed.length}`, '');
  appendPackageRows(lines, '新增应用', diff.packageDiff.added);
  appendPackageRows(lines, '删除应用', diff.packageDiff.removed);
  appendChangedPackageRows(lines, diff.packageDiff.changed);

  lines.push('', '## 性能变化', '');
  if (diff.performanceDiff.metrics.length === 0) {
    lines.push('- 当前性能数据不足，未生成对比');
  } else {
    lines.push('| 指标 | 基线 | 当前 | 变化 |', '| --- | ---: | ---: | ---: |');
    diff.performanceDiff.metrics.forEach(item => {
      lines.push(`| ${item.label} | ${item.beforeText} | ${item.afterText} | ${item.delta == null ? '-' : item.delta} |`);
    });
  }
  if (diff.performanceDiff.warnings.length) {
    lines.push('', '### 性能告警', '');
    diff.performanceDiff.warnings.forEach(item => lines.push(`- [${item.severity}] ${item.label}：${item.detail || '-'}`));
  }

  lines.push('', '## 当前日志异常', '');
  if (diff.logIssues.length === 0) lines.push('- 未在当前日志尾部发现 Crash/ANR/OOM 等关键异常');
  else diff.logIssues.forEach(item => lines.push(`- [${item.severity}] ${item.label}：${item.detail}`));

  lines.push('', '## 当前设备信息', '');
  Object.entries(current.device).forEach(([key, value]) => lines.push(`- ${key}：${value || '-'}`));
  lines.push('');
  return lines.join('\n');
}

function appendPackageRows(lines, title, rows) {
  lines.push(`### ${title}`, '');
  if (!rows.length) {
    lines.push('- 无', '');
    return;
  }
  lines.push('| 包名 | versionCode | 类型 | 路径 |', '| --- | ---: | --- | --- |');
  rows.slice(0, 80).forEach(item => {
    lines.push(`| ${escapeTable(item.packageName)} | ${escapeTable(item.versionCode || '-')} | ${item.system ? '系统' : '用户'} | ${escapeTable(item.path || '-')} |`);
  });
  if (rows.length > 80) lines.push(`| ... | 还有 ${rows.length - 80} 项 | | |`);
  lines.push('');
}

function appendChangedPackageRows(lines, rows) {
  lines.push('### 变化应用', '');
  if (!rows.length) {
    lines.push('- 无', '');
    return;
  }
  lines.push('| 包名 | 变化 |', '| --- | --- |');
  rows.slice(0, 100).forEach(item => {
    lines.push(`| ${escapeTable(item.packageName)} | ${escapeTable(item.changes.map(change => `${change.key}: ${change.before || '-'} -> ${change.after || '-'}`).join('; '))} |`);
  });
  if (rows.length > 100) lines.push(`| ... | 还有 ${rows.length - 100} 项 |`);
  lines.push('');
}

async function listBaselines() {
  const rows = [];
  for (const dir of getBaselineBaseDirs()) {
    if (!fs.existsSync(dir)) continue;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dir, entry.name);
      const data = readJson(filePath);
      if (!data?.snapshot) continue;
      rows.push(toPublicBaseline(filePath, data));
    }
  }
  return rows
    .sort((a, b) => new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0))
    .slice(0, MAX_BASELINES);
}

function toPublicBaseline(filePath, data) {
  return {
    id: data.id || filePath,
    name: data.name || path.basename(filePath),
    path: filePath,
    deviceId: data.deviceId || data.snapshot?.deviceId || '',
    model: data.snapshot?.device?.model || '',
    android: data.snapshot?.device?.android || '',
    build: data.snapshot?.device?.build || '',
    packageCount: data.snapshot?.packages?.length || 0,
    capturedAt: data.capturedAt || data.snapshot?.capturedAt || ''
  };
}

async function ensureDeviceOnline(deviceId) {
  const state = await runAdb(['-s', deviceId, 'get-state'], COMMAND_TIMEOUT_MS);
  if (!state.ok || !String(state.stdout || '').trim().includes('device')) {
    throw new Error(`device_offline:${deviceId}`);
  }
}

function parseGetprop(text) {
  const props = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (match) props[match[1]] = match[2];
  });
  return props;
}

function buildDeviceInfo(props) {
  return {
    brand: props['ro.product.brand'] || '',
    manufacturer: props['ro.product.manufacturer'] || '',
    model: props['ro.product.model'] || '',
    device: props['ro.product.device'] || '',
    product: props['ro.product.name'] || '',
    android: props['ro.build.version.release'] || '',
    sdk: props['ro.build.version.sdk'] || '',
    build: props['ro.build.display.id'] || '',
    fingerprint: props['ro.build.fingerprint'] || '',
    abi: props['ro.product.cpu.abi'] || '',
    serial: props['ro.serialno'] || ''
  };
}

function isCriticalProp(key) {
  return ['ro.build.fingerprint', 'ro.build.display.id', 'ro.build.version.release', 'ro.build.version.sdk'].includes(key);
}

function getDataUsage(snapshot) {
  const disks = snapshot?.disk || [];
  return disks.find(item => item.mount === '/data')?.usage ?? null;
}

function getTemperature(snapshot) {
  return snapshot?.battery?.temperature ?? snapshot?.thermal?.hottest ?? null;
}

function normalizeBaselinePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const resolved = path.resolve(text);
  const allowed = getBaselineBaseDirs().map(item => path.resolve(item));
  return allowed.some(base => resolved === base || resolved.startsWith(`${base}${path.sep}`)) && fs.existsSync(resolved) ? resolved : '';
}

function runAdb(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = execFile(getAdbCommand(), Array.isArray(args) ? args : [], { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', error: stderr || error.message });
      else resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
    proc.stdin?.end?.();
  });
}

function getBaselineBaseDir() {
  return path.join(getQualityCenterBaseDir(), BASELINE_DIR);
}

function getReportBaseDir() {
  return path.join(getQualityCenterBaseDir(), REPORT_DIR);
}

function getBaselineBaseDirs() {
  return uniquePaths([
    getBaselineBaseDir(),
    path.join(app.getPath('userData'), BASELINE_DIR)
  ]);
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

function getAdbCommand() {
  const candidates = [
    BUNDLED_ADB_PATH,
    process.resourcesPath ? path.join(process.resourcesPath, '..', 'scrcpy-win64', 'adb.exe') : '',
    process.execPath ? path.join(path.dirname(process.execPath), 'scrcpy-win64', 'adb.exe') : ''
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || 'adb';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function sanitizeName(value) {
  return String(value || 'item').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').slice(0, 80) || 'item';
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniquePaths(values) {
  return Array.from(new Set(values.map(item => String(item || '').trim()).filter(Boolean).map(item => path.resolve(item))));
}

function trim(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function statusText(status) {
  return status === 'passed' ? '通过' : status === 'attention' ? '需关注' : '未通过';
}

module.exports = { register, captureBaseline, runRegression, listBaselines };
