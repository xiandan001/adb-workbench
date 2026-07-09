// Device connection and local environment self-check.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getAdbCommand } = require('./adb-runtime.cjs');

const BUNDLED_DIR = path.join(__dirname, '../../scrcpy-win64');
const BUNDLED_SCRCPY_PATH = path.join(BUNDLED_DIR, 'scrcpy.exe');
const COMMAND_TIMEOUT_MS = 12000;

function register(ipcMain) {
  ipcMain.handle('env-check:run', async (event, args) => {
    try {
      const result = await runEnvironmentCheck(String(args?.deviceId || '').trim());
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message || '环境自检失败', checks: [] };
    }
  });

  ipcMain.handle('env-check:restartAdb', async () => {
    const adb = getAdbCommand();
    const kill = await runCommand(adb, ['kill-server'], 8000);
    const start = await runCommand(adb, ['start-server'], 8000);
    return {
      ok: kill.ok && start.ok,
      kill,
      start,
      message: kill.ok && start.ok ? 'ADB 服务已重启' : (start.error || kill.error || 'ADB 服务重启失败')
    };
  });
}

async function runEnvironmentCheck(selectedDeviceId) {
  const checks = [];
  const suggestions = [];

  const adbCommand = getAdbCommand();
  const adbVersion = await runCommand(adbCommand, ['version'], COMMAND_TIMEOUT_MS);
  checks.push({
    key: 'adb',
    label: 'ADB 可用性',
    ok: adbVersion.ok,
    level: adbVersion.ok ? 'pass' : 'error',
    detail: adbVersion.ok ? firstLine(adbVersion.stdout) : adbVersion.error || adbVersion.stderr || '未找到 ADB',
    action: adbVersion.ok ? adbCommand : '请安装 Android platform-tools 或确认内置 adb.exe 存在'
  });
  if (!adbVersion.ok) {
    suggestions.push('先安装 Android platform-tools，或确认 scrcpy-win64/adb.exe 未被删除。');
    return buildResult(checks, suggestions, [], null);
  }

  const devicesOutput = await runCommand(adbCommand, ['devices', '-l'], COMMAND_TIMEOUT_MS);
  const devices = parseDevices(devicesOutput.stdout);
  checks.push({
    key: 'devices',
    label: '设备连接',
    ok: devices.some(device => device.status === 'device'),
    level: devices.some(device => device.status === 'device') ? 'pass' : 'warning',
    detail: devices.length ? `${devices.length} 台设备已识别` : '未发现设备',
    action: devices.length ? '' : '连接 USB 设备并确认开发者选项中的 USB 调试已开启'
  });

  const unauthorized = devices.filter(device => device.status === 'unauthorized');
  const offline = devices.filter(device => device.status === 'offline');
  if (unauthorized.length) suggestions.push('设备显示 unauthorized：请查看设备屏幕，允许 USB 调试授权后重新自检。');
  if (offline.length) suggestions.push('设备显示 offline：建议重新插拔 USB、切换线缆或重启 ADB 服务。');
  if (!devices.length) suggestions.push('未发现设备：确认数据线支持传输，设备已开启 USB 调试，并安装了对应驱动。');

  const scrcpy = await checkScrcpy();
  checks.push({
    key: 'scrcpy',
    label: 'scrcpy 可用性',
    ok: scrcpy.ok,
    level: scrcpy.ok ? 'pass' : 'warning',
    detail: scrcpy.ok ? firstLine(scrcpy.stdout) : scrcpy.error || '未找到 scrcpy',
    action: scrcpy.path || '安装 scrcpy 或确认 scrcpy-win64/scrcpy.exe 存在'
  });
  if (!scrcpy.ok) suggestions.push('scrcpy 不可用会影响投屏功能，请安装 scrcpy 或恢复内置 scrcpy-win64 目录。');

  const targetDevice = pickTargetDevice(devices, selectedDeviceId);
  let deviceInfo = null;
  if (targetDevice?.status === 'device') {
    const props = await runCommand(adbCommand, ['-s', targetDevice.id, 'shell', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.display.id'], COMMAND_TIMEOUT_MS);
    const state = await runCommand(adbCommand, ['-s', targetDevice.id, 'get-state'], COMMAND_TIMEOUT_MS);
    deviceInfo = { ...targetDevice, ...parseProps(props.stdout) };
    checks.push({
      key: 'target-device',
      label: '选中设备命令通路',
      ok: state.ok && String(state.stdout || '').trim() === 'device',
      level: state.ok ? 'pass' : 'error',
      detail: deviceInfo.model ? `${deviceInfo.model} / Android ${deviceInfo.android || '-'}` : targetDevice.id,
      action: state.ok ? '' : state.error || state.stderr || 'ADB 命令无法执行'
    });
  } else if (targetDevice) {
    checks.push({
      key: 'target-device',
      label: '选中设备状态',
      ok: false,
      level: targetDevice.status === 'unauthorized' ? 'warning' : 'error',
      detail: `${targetDevice.id}：${targetDevice.status}`,
      action: targetDevice.status === 'unauthorized' ? '在设备上允许 USB 调试授权' : '重新连接设备或重启 ADB'
    });
  }

  if (!suggestions.length) suggestions.push('环境检查通过，可以继续投屏、日志分析或任务中心操作。');
  return buildResult(checks, suggestions, devices, deviceInfo);
}

function buildResult(checks, suggestions, devices, deviceInfo) {
  const hasError = checks.some(check => check.level === 'error');
  const hasWarning = checks.some(check => check.level === 'warning');
  return {
    status: hasError ? 'error' : hasWarning ? 'warning' : 'pass',
    title: hasError ? '存在阻断项' : hasWarning ? '存在需关注项' : '环境检查通过',
    checks,
    suggestions,
    devices,
    deviceInfo,
    checkedAt: new Date().toISOString()
  };
}

async function checkScrcpy() {
  const candidates = [
    fs.existsSync(BUNDLED_SCRCPY_PATH) ? BUNDLED_SCRCPY_PATH : '',
    'scrcpy'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = await runCommand(candidate, ['--version'], COMMAND_TIMEOUT_MS);
    if (result.ok) return { ...result, path: candidate };
  }
  return { ok: false, error: 'scrcpy 不可用', path: '' };
}

function pickTargetDevice(devices, selectedDeviceId) {
  if (selectedDeviceId) return devices.find(device => device.id === selectedDeviceId) || { id: selectedDeviceId, status: 'missing' };
  return devices.find(device => device.status === 'device') || devices[0] || null;
}

function parseDevices(text) {
  return String(text || '')
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [id, status, ...rest] = line.split(/\s+/);
      return {
        id,
        status,
        detail: rest.join(' ')
      };
    })
    .filter(device => device.id && device.status);
}

function parseProps(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return {
    model: lines[0] || '',
    android: lines[1] || '',
    build: lines[2] || ''
  };
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).find(Boolean) || '';
}

function runCommand(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeout || COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: error.message, stdout: stdout || '', stderr: stderr || '' });
        return;
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = { register };
