const { tr } = require('./localization.cjs');
// Report and artifact center: read-only index over generated local outputs.

const { app, shell, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { exportArtifact } = require('./artifact-export.cjs');
const { artifactDetails, previewArtifact } = require('./artifact-preview.cjs');

const SETTINGS_FILE = 'settings.json';
const QUALITY_CENTER_DIR = 'quality-center';

function register(ipcMain) {
  ipcMain.handle('artifacts:list', async () => {
    try {
      const items = await listArtifacts({ measure: true });
      return { ok: true, items };
    } catch (error) {
      return { ok: false, error: error.message, items: [] };
    }
  });

  ipcMain.handle('artifacts:openPath', async (event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: tr("路径不能为空") };
    const error = await shell.openPath(targetPath);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('artifacts:preview', async (event, { id, name } = {}) => {
    try {
      const item = (await listArtifacts()).find(entry => entry.id === id);
      if (!item) throw new Error(tr("产物已不存在，请刷新列表后重试"));
      return { ok: true, ...await (name ? previewArtifact(item, name) : artifactDetails(item)) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('artifacts:delete', async (event, args) => {
    try {
      const result = await deleteArtifacts(args);
      return { ok: true, ...result, items: await listArtifacts({ measure: true }) };
    } catch (error) {
      return { ok: false, error: error.message, deleted: [], failed: [] };
    }
  });

  ipcMain.handle('artifacts:export', async (event, { id } = {}) => {
    try {
      const item = (await listArtifacts()).find(entry => entry.id === id);
      if (!item) return { ok: false, error: tr("产物已不存在，请刷新列表后重试") };
      const name = String(item.title || 'evidence').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 70);
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: tr("导出证据包"), defaultPath: path.join(app.getPath('downloads'), `${name}-evidence.zip`),
        filters: [{ name: tr("ZIP 证据包"), extensions: ['zip'] }]
      };
      const result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options));
      if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
      return { ok: true, ...await exportArtifact(item, result.filePath) };
    } catch (error) {
      return { ok: false, error: error.message || tr("证据包导出失败") };
    }
  });
}

async function listArtifacts({ measure = false } = {}) {
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
  buckets.push(...await scanReproduction());

  const items = buckets
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  // Bound concurrent filesystem work, but never hide older results from search/delete/export.
  if (!measure) return items;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try { item.sizeBytes = (await artifactDetails(item)).sizeBytes; }
      catch { item.sizeBytes = null; }
    }
  }));
  return items;
}

async function scanTroubleshooting(baseDir) {
  const dirs = await recentDirectories(baseDir);
  return Promise.all(dirs.map(async (dir) => {
    const summaryPath = path.join(dir, 'troubleshooting-summary.json');
    const reportPath = path.join(dir, 'troubleshooting-report.md');
    if (!exists(summaryPath) && !exists(reportPath)) return null;
    const summary = readJson(summaryPath) || {};
    const stat = await safeStat(dir);
    return {
      id: `troubleshooting:${dir}`,
      type: 'troubleshooting',
      typeLabel: tr("问题排查"),
      title: summary.title || tr("一键问题排查报告"),
      subtitle: summary.message || summary.status || path.basename(dir),
      status: summary.status || (summary.ok ? 'success' : 'attention'),
      deviceId: deviceFromSummary(summary),
      createdAt: summary.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: summary.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      deletePath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(summaryPath) ? summaryPath : '',
      artifactCount: Array.isArray(summary.artifacts) ? summary.artifacts.length : countFilesShallow(dir)
    };
  }));
}

async function scanReproduction() {
  const store = require('./reproduction-store.cjs').createReproductionStore(path.join(app.getPath('userData'), 'reproduction-sessions'));
  const result = await store.list();
  const items = [];
  for (const session of result.sessions) {
    if (['starting', 'recording', 'stopping'].includes(session.status)) continue;
    const directory = await store.checkedDirectory(session.id);
    const manifest = await store.filePath(session.id, 'manifest.json', true);
    items.push({ id: `reproduction:${session.id}`, sessionId: session.id, type: 'reproduction', typeLabel: tr('复现采证'),
      title: session.title, subtitle: tr('{0} 份证据 · {1} 个标记', { 0: session.files.length, 1: session.markers.length }),
      status: session.status, deviceId: session.deviceId, createdAt: new Date(session.startedAt).toISOString(),
      updatedAt: new Date(session.endedAt || session.startedAt).toISOString(), rootPath: directory, deletePath: directory,
      reportPath: manifest, summaryPath: manifest, artifactCount: session.files.length + 1 });
  }
  return items;
}

async function scanInspection(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir));
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
      typeLabel: tr("设备巡检"),
      title: analysis.summary || tr("设备巡检报告"),
      subtitle: tr("{0} 成功 / {1} 失败", { 0: summary.successCount ?? metadata.successCount ?? 0, 1: summary.failedCount ?? metadata.failedCount ?? 0 }),
      status: metadata.cancelled ? 'cancelled' : analysis.severity || 'normal',
      deviceId: summary.deviceId || metadata.deviceId || '',
      createdAt: summary.startedAt || metadata.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: summary.endedAt || metadata.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      deletePath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(summaryPath) ? summaryPath : '',
      artifactCount: Array.isArray(summary.artifacts) ? summary.artifacts.length : countFilesShallow(dir)
    };
  }));
}

async function scanPerformance(baseDirs) {
  const items = [];
  for (const baseDir of baseDirs) {
    const files = await recentFiles(baseDir);
    for (const file of files) {
      const name = path.basename(file);
      if (!/^performance(?:-report)?-.*\.(md|json)$/i.test(name)) continue;
      const stat = await safeStat(file);
      const isReport = name.endsWith('.md');
      items.push({
        id: `performance:${file}`,
        type: 'performance',
        typeLabel: isReport ? tr("性能报告") : tr("性能数据"),
        title: isReport ? tr("性能分析报告") : tr("性能采样数据"),
        subtitle: name,
        status: isReport ? 'report' : 'data',
        deviceId: parseDeviceFromPerformanceName(name),
        createdAt: stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
        updatedAt: stat?.mtime?.toISOString(),
        rootPath: path.dirname(file),
        deletePath: file,
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
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'stress-report.md');
    const replayPath = path.join(dir, 'run-result.json');
    const resultPath = exists(replayPath) ? replayPath : path.join(dir, 'stress-result.json');
    if (!exists(reportPath) && !exists(resultPath)) return null;
    const result = readJson(resultPath) || {};
    const deviceRuns = Array.isArray(result.devices) ? result.devices : Array.isArray(result.deviceRuns) ? result.deviceRuns : [];
    const stat = await safeStat(dir);
    return {
      id: `task:${dir}`,
      type: 'task',
      typeLabel: result.mode === 'stress' ? tr("自动化压测") : tr("任务中心"),
      title: result.scriptName || path.basename(dir),
      subtitle: result.status ? tr("状态：{0}", { 0: result.status }) : tr("任务产物"),
      status: result.status || 'done',
      deviceId: deviceRuns.map(item => typeof item === 'string' ? item : item?.deviceId).filter(Boolean).join(', '),
      createdAt: result.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      deletePath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function scanRegression(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir));
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
      typeLabel: tr("回归差异"),
      title: result.name || tr("回归差异报告"),
      subtitle: diff.summary || (result.status ? tr("状态：{0}", { 0: result.status }) : path.basename(dir)),
      status: result.status || 'done',
      deviceId: result.deviceId || '',
      createdAt: result.comparedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.comparedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      deletePath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function scanDeviceGuard(baseDirs) {
  const allDirs = [];
  for (const baseDir of baseDirs) allDirs.push(...await recentDirectories(baseDir));
  return Promise.all(allDirs.map(async (dir) => {
    const reportPath = path.join(dir, 'device-guard-report.md');
    const resultPath = path.join(dir, 'device-guard-result.json');
    if (!exists(reportPath) && !exists(resultPath)) return null;
    const result = readJson(resultPath) || {};
    const stat = await safeStat(dir);
    return {
      id: `deviceGuard:${dir}`,
      type: 'deviceGuard',
      typeLabel: tr("设备守护"),
      title: result.name || tr("设备守护报告"),
      subtitle: tr("事件 {0} 项 / 采样 {1} 次", { 0: Array.isArray(result.events) ? result.events.length : 0, 1: result.tickCount || 0 }),
      status: result.status || 'done',
      deviceId: result.deviceId || '',
      createdAt: result.startedAt || stat?.birthtime?.toISOString() || stat?.mtime?.toISOString(),
      updatedAt: result.endedAt || stat?.mtime?.toISOString(),
      rootPath: dir,
      deletePath: dir,
      reportPath: exists(reportPath) ? reportPath : '',
      summaryPath: exists(resultPath) ? resultPath : '',
      artifactCount: countFilesShallow(dir)
    };
  }));
}

async function recentDirectories(baseDir) {
  if (!exists(baseDir)) return [];
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(baseDir, entry.name);
    const stat = await safeStat(fullPath);
    dirs.push({ path: fullPath, time: stat?.mtime?.getTime() || 0 });
  }
  return dirs.sort((a, b) => b.time - a.time).map(item => item.path);
}

async function deleteArtifacts(args) {
  const ids = normalizeIds(args?.ids || args?.id);
  if (ids.length === 0) throw new Error(tr("请选择要删除的产物"));

  const items = await listArtifacts();
  const itemById = new Map(items.map(item => [item.id, item]));
  const targetByPath = new Map();
  const failed = [];

  for (const id of ids) {
    const item = itemById.get(id);
    if (!item) {
      failed.push({ id, error: tr("产物不存在或已不在当前列表中") });
      continue;
    }
    const deletePath = String(item.deletePath || '').trim();
    if (!deletePath) {
      failed.push({ id, title: item.title, error: tr("产物缺少可删除路径") });
      continue;
    }
    const resolvedPath = path.resolve(deletePath);
    if (!exists(resolvedPath)) {
      failed.push({ id, title: item.title, path: resolvedPath, error: tr("文件或目录不存在") });
      continue;
    }
    if (!targetByPath.has(resolvedPath)) {
      targetByPath.set(resolvedPath, { ids: [id], title: item.title, path: resolvedPath });
    } else {
      targetByPath.get(resolvedPath).ids.push(id);
    }
  }

  const deleted = [];
  for (const target of targetByPath.values()) {
    try {
      await shell.trashItem(target.path);
      deleted.push(target);
    } catch (error) {
      failed.push({ ids: target.ids, title: target.title, path: target.path, error: error.message || tr("移入回收站失败") });
    }
  }

  return { deleted, failed };
}

async function recentFiles(baseDir) {
  if (!exists(baseDir)) return [];
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(baseDir, entry.name);
    const stat = await safeStat(fullPath);
    files.push({ path: fullPath, time: stat?.mtime?.getTime() || 0 });
  }
  return files.sort((a, b) => b.time - a.time).map(item => item.path);
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

function normalizeIds(value) {
  const list = Array.isArray(value) ? value : [value];
  return Array.from(new Set(list.map(item => String(item || '').trim()).filter(Boolean)));
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

async function readAnalysisArtifact(artifactId, name) {
  if (typeof artifactId !== 'string' || artifactId.length > 2048 || typeof name !== 'string' || name.length > 512
    || !/\.(?:md|json|txt|log|csv)$/i.test(name)) throw new Error(tr('请选择已知产物中的文本文件带入 AI。'));
  const item = (await listArtifacts()).find(entry => entry.id === artifactId);
  if (!item) throw new Error(tr('产物已不存在，请刷新列表后重试'));
  const preview = await previewArtifact(item, name);
  if (preview.kind !== 'text') throw new Error(tr('请选择已知产物中的文本文件带入 AI。'));
  const taskResult = /(?:^|[\\/])run-result\.json$/i.test(name);
  const text = taskResult ? await require('./ai-outbound-processor.cjs').sanitizeTaskArtifact({ text: preview.content, truncated: preview.truncated }) : preview.content;
  return { origin: 'artifact', title: String(item.title || name).slice(0, 240), deviceId: item.deviceId || '',
    question: tr('请基于这份已选择的产物分析问题与验证方向。'),
    text: taskResult ? `${tr('本机私有重跑脚本未包含在 AI 上下文中。')}\n${text}` : text, truncated: preview.truncated };
}

module.exports = { register, readAnalysisArtifact };
