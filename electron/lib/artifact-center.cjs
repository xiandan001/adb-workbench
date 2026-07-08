// Report and artifact center: read-only index over generated local outputs.

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'settings.json';
const QUALITY_CENTER_DIR = 'quality-center';
const MAX_ITEMS = 160;

function register(ipcMain) {
  ipcMain.handle('artifacts:list', async () => {
    try {
      const items = await listArtifacts();
      return { ok: true, items };
    } catch (error) {
      return { ok: false, error: error.message, items: [] };
    }
  });

  ipcMain.handle('artifacts:openPath', async (event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: '路径不能为空' };
    const error = await shell.openPath(targetPath);
    return error ? { ok: false, error } : { ok: true };
  });
}

async function listArtifacts() {
  const settings = readSettings();
  const userData = app.getPath('userData');
  const buckets = [];

  buckets.push(...await scanTroubleshooting(path.join(userData, 'troubleshooting')));
  buckets.push(...await scanInspection(uniquePaths([settings.inspectionPath, path.join(userData, 'inspection')])));
  buckets.push(...await scanPerformance(uniquePaths([settings.performancePath, path.join(userData, 'performance-monitor')])));
  buckets.push(...await scanTaskCenter(uniquePaths([settings.taskCenterPath, path.join(userData, 'task-center-artifacts')])));
  buckets.push(...await scanRegression(uniquePaths([
    settings.qualityCenterPath ? path.join(settings.qualityCenterPath, 'regression-reports') : '',
    path.join(userData, QUALITY_CENTER_DIR, 'regression-reports'),
    path.join(userData, 'regression-reports')
  ])));
  buckets.push(...await scanDeviceGuard(uniquePaths([
    settings.qualityCenterPath ? path.join(settings.qualityCenterPath, 'device-guard') : '',
    path.join(userData, QUALITY_CENTER_DIR, 'device-guard'),
    path.join(userData, 'device-guard')
  ])));

  return buckets
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, MAX_ITEMS);
}

async function scanTroubleshooting(baseDir) {
  const dirs = await recentDirectories(baseDir, 60);
  return Promise.all(dirs.map(async (dir) => {
    const summaryPath = path.join(dir, 'troubleshooting-summary.json');
    const reportPath = path.join(dir, 'troubleshooting-report.md');
    if (!exists(summaryPath) && !exists(reportPath)) return null;
    const summary = readJson(summaryPath) || {};
    const stat = await safeStat(dir);
    return {
      id: `troubleshooting:${dir}`,
      type: 'troubleshooting',
      typeLabel: '问题排查',
      title: summary.title || '一键问题排查报告',
      subtitle: summary.message || summary.status || path.basename(dir),
      status: summary.status || (summary.ok ? 'success' : 'attention'),
      deviceId: deviceFromSummary(summary),
      createdAt: summary.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: summary.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(summaryPath) ? summaryPath : '',
      artifactCount: Array.isArray(summary.artifacts) ? summary.artifacts.length : countFilesShallow(dir)
    };
  }));
}

async function scanInspection(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir, 70));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'inspection-report.md');
    const summaryPath = path.join(dir, 'summary.json');
    const metadataPath = path.join(dir, 'metadata.json');
    if (!exists(reportPath) && !exists(summaryPath)) return null;
    const summary = readJson(summaryPath) || {};
    const metadata = readJson(metadataPath) || {};
    const stat = await safeStat(dir);
    const analysis = summary.analysis || metadata.analysis || {};
    return {
      id: `inspection:${dir}`,
      type: 'inspection',
      typeLabel: '设备巡检',
      title: analysis.summary || '设备巡检报告',
      subtitle: `${summary.successCount ?? metadata.successCount ?? 0} 成功 / ${summary.failedCount ?? metadata.failedCount ?? 0} 失败`,
      status: metadata.cancelled ? 'cancelled' : analysis.severity || 'normal',
      deviceId: summary.deviceId || metadata.deviceId || '',
      createdAt: summary.startedAt || metadata.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: summary.endedAt || metadata.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(summaryPath) ? summaryPath : '',
      artifactCount: Array.isArray(summary.artifacts) ? summary.artifacts.length : countFilesShallow(dir)
    };
  }));
}

async function scanPerformance(baseDirs) {
  const items = [];
  for (const baseDir of baseDirs) {
    const files = await recentFiles(baseDir, 80);
    for (const file of files) {
      const name = path.basename(file);
      if (!/^performance(?:-report)?-.*\.(md|json)$/i.test(name)) continue;
      const stat = await safeStat(file);
      const isReport = name.endsWith('.md');
      items.push({
        id: `performance:${file}`,
        type: 'performance',
        typeLabel: isReport ? '性能报告' : '性能数据',
        title: isReport ? '性能分析报告' : '性能采样数据',
        subtitle: name,
        status: isReport ? 'report' : 'data',
        deviceId: parseDeviceFromPerformanceName(name),
        createdAt: stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
        updatedAt: stat?.mtime?.toISOString(),
        rootPath: path.dirname(file),
        reportPath: isReport ? file : '',
        summaryPath: isReport ? '' : file,
        artifactCount: 1
      });
    }
  }
  return items;
}

async function scanTaskCenter(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir, 80));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'stress-report.md');
    const resultPath = path.join(dir, 'stress-result.json');
    if (!exists(reportPath) && !exists(resultPath)) return null;
    const result = readJson(resultPath) || {};
    const stat = await safeStat(dir);
    return {
      id: `task:${dir}`,
      type: 'task',
      typeLabel: result.mode === 'stress' ? '自动化压测' : '任务中心',
      title: result.scriptName || path.basename(dir),
      subtitle: result.status ? `状态：${result.status}` : '任务产物',
      status: result.status || 'done',
      deviceId: Array.isArray(result.devices) ? result.devices.map(item => item.deviceId).filter(Boolean).join(', ') : '',
      createdAt: result.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function scanRegression(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir, 80));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'regression-report.md');
    const resultPath = path.join(dir, 'regression-result.json');
    if (!exists(reportPath) && !exists(resultPath)) return null;
    const result = readJson(resultPath) || {};
    const diff = result.diff || {};
    const stat = await safeStat(dir);
    return {
      id: `regression:${dir}`,
      type: 'regression',
      typeLabel: '回归差异',
      title: result.name || '回归差异报告',
      subtitle: diff.summary || (result.status ? `状态：${result.status}` : path.basename(dir)),
      status: result.status || 'done',
      deviceId: result.deviceId || '',
      createdAt: result.comparedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.comparedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function scanDeviceGuard(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir, 80));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'device-guard-report.md');
    const resultPath = path.join(dir, 'device-guard-result.json');
    if (!exists(reportPath) && !exists(resultPath)) return null;
    const result = readJson(resultPath) || {};
    const stat = await safeStat(dir);
    return {
      id: `deviceGuard:${dir}`,
      type: 'deviceGuard',
      typeLabel: '设备守护',
      title: result.name || '设备守护报告',
      subtitle: `事件 ${Array.isArray(result.events) ? result.events.length : 0} 项 / 采样 ${result.tickCount || 0} 次`,
      status: result.status || 'done',
      deviceId: result.deviceId || '',
      createdAt: result.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function recentDirectories(baseDir, limit) {
  if (!exists(baseDir)) return [];
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(baseDir, entry.name);
    const stat = await safeStat(fullPath);
    dirs.push({ path: fullPath, time: stat?.mtime?.getTime() || 0 });
  }
  return dirs.sort((a, b) => b.time - a.time).slice(0, limit).map(item => item.path);
}

async function recentFiles(baseDir, limit) {
  if (!exists(baseDir)) return [];
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(baseDir, entry.name);
    const stat = await safeStat(fullPath);
    files.push({ path: fullPath, time: stat?.mtime?.getTime() || 0 });
  }
  return files.sort((a, b) => b.time - a.time).slice(0, limit).map(item => item.path);
}

function readSettings() {
  return readJson(path.join(app.getPath('userData'), SETTINGS_FILE)) || {};
}

function readJson(filePath) {
  try {
    if (!exists(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function countFilesShallow(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(item => item.isFile() || item.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function safeStat(targetPath) {
  try {
    return await fs.promises.stat(targetPath);
  } catch {
    return null;
  }
}

function exists(targetPath) {
  return !!targetPath && fs.existsSync(targetPath);
}

function uniquePaths(values) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean).map(value => path.resolve(value))));
}

function deviceFromSummary(summary) {
  if (summary.deviceId) return summary.deviceId;
  const check = Array.isArray(summary.checks) ? summary.checks.find(item => item.key === 'device') : null;
  return check?.detail || '';
}

function parseDeviceFromPerformanceName(name) {
  return name
    .replace(/^performance-report-/i, '')
    .replace(/^performance-/i, '')
    .replace(/\.(md|json)$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}T.*$/i, '');
}

module.exports = { register };
