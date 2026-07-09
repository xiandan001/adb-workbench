// App package management backend: package list/detail plus VIP-gated mutating actions.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const vip = require('./vip.cjs');
const { runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

const DEFAULT_TIMEOUT_MS = 20000;
const LONG_TIMEOUT_MS = 60000;
const SNAPSHOT_DIR = 'package-manager';

function register(ipcMain) {
  ipcMain.handle('package:list', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    try {
      const packages = await listPackages(deviceId);
      return { ok: true, packages };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('package:detail', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    try {
      const detail = await getPackageDetail(deviceId, packageName);
      return { ok: true, detail };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('package:permissions', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    const detail = await getPackageDetail(deviceId, packageName);
    return { ok: true, permissions: detail.permissions || [] };
  }));

  ipcMain.handle('package:exportApk', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    const localPath = String(args?.localPath || '').trim();
    if (!deviceId || !packageName || !localPath) return { ok: false, error: 'device_package_or_path_required' };
    const detail = await getPackageDetail(deviceId, packageName);
    const sourcePath = detail.apkPath || detail.path;
    if (!sourcePath) return { ok: false, error: 'apk_path_not_found' };
    const pull = await runAdb(['-s', deviceId, 'pull', sourcePath, localPath], LONG_TIMEOUT_MS);
    if (!pull.ok) return { ok: false, error: pull.error || pull.stderr || 'export_failed' };
    return { ok: true, localPath, sourcePath };
  }));

  ipcMain.handle('package:snapshot', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: 'device_required' };
    try {
      const packages = await listPackages(deviceId);
      const output = await writePackageSnapshot(deviceId, packages, args?.outputPath);
      return { ok: true, path: output.jsonPath, csvPath: output.csvPath, count: packages.length };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('package:launch', async (event, args) => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    const res = await runAdb(['-s', deviceId, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], DEFAULT_TIMEOUT_MS);
    return adbMutationResult(res);
  });

  ipcMain.handle('package:batch', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const action = String(args?.action || '').trim();
    const packageNames = normalizePackageNames(args?.packageNames).slice(0, 100);
    if (!deviceId || !action || packageNames.length === 0) return { ok: false, error: 'device_action_or_packages_required' };
    const results = [];
    for (const packageName of packageNames) {
      const res = await runPackageAction(deviceId, packageName, action, args || {});
      results.push({ packageName, ...res });
    }
    const failed = results.filter(item => !item.ok);
    return { ok: failed.length === 0, results, successCount: results.length - failed.length, failedCount: failed.length };
  }));

  ipcMain.handle('package:uninstall', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    return runPackageAction(deviceId, packageName, 'uninstall', args || {});
  }));

  ipcMain.handle('package:clearData', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    return runPackageAction(deviceId, packageName, 'clearData', args || {});
  }));

  ipcMain.handle('package:forceStop', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    return runPackageAction(deviceId, packageName, 'forceStop', args || {});
  }));

  ipcMain.handle('package:setEnabled', async (event, args) => withVip(async () => {
    const deviceId = normalizeDeviceId(args?.deviceId);
    const packageName = normalizePackageName(args?.packageName);
    const enabled = args?.enabled === true;
    if (!deviceId || !packageName) return { ok: false, error: 'device_or_package_required' };
    return runPackageAction(deviceId, packageName, enabled ? 'enable' : 'disable', args || {});
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

async function listPackages(deviceId) {
  let res = await runAdb(['-s', deviceId, 'shell', 'cmd', 'package', 'list', 'packages', '-f', '-U', '--show-versioncode'], LONG_TIMEOUT_MS);
  if (!res.ok || !res.stdout.trim()) {
    res = await runAdb(['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-f'], LONG_TIMEOUT_MS);
  }
  if (!res.ok) throw new Error(res.error || res.stderr || 'package_list_failed');
  return res.stdout
    .split(/\r?\n/)
    .map(line => parsePackageLine(line))
    .filter(Boolean)
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

async function getPackageDetail(deviceId, packageName) {
  const list = await listPackages(deviceId);
  const basic = list.find(item => item.packageName === packageName) || { packageName };
  const res = await runAdb(['-s', deviceId, 'shell', 'dumpsys', 'package', packageName], LONG_TIMEOUT_MS);
  if (!res.ok) throw new Error(res.error || res.stderr || 'package_detail_failed');
  const text = res.stdout || '';
  const detail = {
    ...basic,
    versionName: firstMatch(text, /versionName=([^\s]+)/),
    versionCode: firstMatch(text, /versionCode=(\d+)/) || basic.versionCode,
    userId: firstMatch(text, /userId=(\d+)/) || basic.uid,
    firstInstallTime: firstMatch(text, /firstInstallTime=([^\n]+)/),
    lastUpdateTime: firstMatch(text, /lastUpdateTime=([^\n]+)/),
    installer: firstMatch(text, /installerPackageName=([^\s]+)/),
    enabled: parsePackageEnabled(text),
    enabledState: parsePackageEnabledState(text),
    system: basic.system || /pkgFlags=\[[^\]]*\bSYSTEM\b/i.test(text) || String(basic.path || '').startsWith('/system'),
    apkPath: firstMatch(text, /codePath=([^\n]+)/) || basic.path,
    permissions: parsePermissions(text),
    raw: text
  };
  return detail;
}

function parsePackageLine(line) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('package:')) return null;
  const match = raw.match(/^package:(.*?)=([^\s]+)(.*)$/);
  if (!match) return null;
  const [, apkPath, packageName, rest] = match;
  const uid = firstMatch(rest, /uid:(\d+)/);
  const versionCode = firstMatch(rest, /versionCode:(\d+)/);
  return {
    packageName,
    path: apkPath,
    apkName: path.basename(apkPath || ''),
    uid: uid || '',
    versionCode: versionCode || '',
    system: String(apkPath || '').startsWith('/system') || String(apkPath || '').startsWith('/product') || String(apkPath || '').startsWith('/vendor'),
    enabled: true
  };
}

function parsePackageEnabled(text) {
  const state = normalizeEnabledState(parsePackageEnabledState(text));
  if (!state) return true;
  return !new Set(['2', '3', '4', 'false', 'disabled', 'disabled-user', 'disabled_until_used', 'disabled-until-used']).has(state);
}

function parsePackageEnabledState(text) {
  const lines = String(text || '').split(/\r?\n/);
  const userStateLine = lines.find(line => /^User\s+\d+:/i.test(line.trim()) && /\benabled=/i.test(line));
  const state = firstMatch(userStateLine || '', /\benabled=([^\s]+)/i);
  if (state) return state;
  return firstMatch(text, /\benabled=([^\s]+)/i);
}

function normalizeEnabledState(value) {
  return String(value || '').trim().replace(/[,\]]+$/, '').toLowerCase();
}

function parsePermissions(text) {
  const permissions = [];
  const lines = String(text || '').split(/\r?\n/);
  let inRequested = false;
  let inInstall = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'requested permissions:') {
      inRequested = true;
      inInstall = false;
      continue;
    }
    if (trimmed === 'install permissions:' || trimmed === 'runtime permissions:') {
      inRequested = false;
      inInstall = true;
      continue;
    }
    if (!trimmed || /^[a-zA-Z].*:$/.test(trimmed)) {
      if (!trimmed.startsWith('android.permission.')) {
        inRequested = false;
        inInstall = false;
      }
      continue;
    }
    if (inRequested && /^[\w.]+$/.test(trimmed)) {
      permissions.push({ name: trimmed, granted: null, source: 'requested' });
    } else if (inInstall) {
      const perm = firstMatch(trimmed, /^([\w.]+):/);
      if (perm) permissions.push({ name: perm, granted: /granted=true/.test(trimmed), source: 'install' });
    }
  }
  return permissions;
}

function adbMutationResult(res) {
  if (res.ok) return { ok: true, output: res.stdout || res.stderr || '' };
  return { ok: false, error: res.error || res.stderr || res.stdout || 'adb_failed' };
}

async function runPackageAction(deviceId, packageName, action) {
  if (action === 'forceStop') {
    return adbMutationResult(await runAdb(['-s', deviceId, 'shell', 'am', 'force-stop', packageName], DEFAULT_TIMEOUT_MS));
  }
  if (action === 'clearData') {
    return adbMutationResult(await runAdb(['-s', deviceId, 'shell', 'pm', 'clear', packageName], LONG_TIMEOUT_MS));
  }
  if (action === 'disable') {
    return adbMutationResult(await runAdb(['-s', deviceId, 'shell', 'pm', 'disable-user', packageName], DEFAULT_TIMEOUT_MS));
  }
  if (action === 'enable') {
    return adbMutationResult(await runAdb(['-s', deviceId, 'shell', 'pm', 'enable', packageName], DEFAULT_TIMEOUT_MS));
  }
  if (action === 'uninstall') {
    return adbMutationResult(await runAdb(['-s', deviceId, 'shell', 'pm', 'uninstall', '--user', '0', packageName], LONG_TIMEOUT_MS));
  }
  return { ok: false, error: `unsupported_action:${action}` };
}

async function writePackageSnapshot(deviceId, packages, outputPath) {
  const baseDir = path.join(app.getPath('userData'), SNAPSHOT_DIR);
  await fs.promises.mkdir(baseDir, { recursive: true });
  const filePath = outputPath && typeof outputPath === 'string'
    ? path.resolve(outputPath)
    : path.join(baseDir, `packages-${sanitizeName(deviceId)}-${formatStamp(new Date())}.json`);
  const payload = { deviceId, exportedAt: new Date().toISOString(), count: packages.length, packages };
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  const csvPath = filePath.replace(/\.json$/i, '.csv');
  await fs.promises.writeFile(csvPath, toPackageCsv(packages), 'utf8');
  return { jsonPath: filePath, csvPath };
}

function toPackageCsv(packages) {
  const rows = [['packageName', 'apkName', 'path', 'uid', 'versionCode', 'system', 'enabled']];
  packages.forEach(item => {
    rows.push([item.packageName, item.apkName, item.path, item.uid, item.versionCode, item.system, item.enabled].map(csvCell));
  });
  return rows.map(row => row.join(',')).join('\n');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function runAdb(args, timeoutMs) {
  return runRuntimeAdb(args, { timeoutMs });
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function normalizePackageName(value) {
  const name = String(value || '').trim();
  return /^[A-Za-z0-9_.]+$/.test(name) ? name : '';
}

function normalizePackageNames(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizePackageName).filter(Boolean)));
}

function sanitizeName(value) {
  return String(value || 'device').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').slice(0, 80) || 'device';
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function firstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match ? String(match[1] || '').trim() : '';
}

module.exports = { register, listPackages, getPackageDetail };
