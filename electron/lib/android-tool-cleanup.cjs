const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TOOL_NAMES = {
  adb: 'adb.exe',
  scrcpy: 'scrcpy.exe',
  fastboot: 'fastboot.exe',
  hdc: 'hdc.exe'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uniqueExistingDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    let resolved;
    try {
      resolved = path.resolve(dir);
    } catch {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key) || !fs.existsSync(resolved)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function getBundledDirs(directory) {
  return uniqueExistingDirs([
    path.join(__dirname, '../..', directory),
    process.resourcesPath ? path.join(process.resourcesPath, '..', directory) : '',
    process.execPath ? path.join(path.dirname(process.execPath), directory) : ''
  ]);
}

function getBundledToolDirs() {
  return getBundledDirs('scrcpy-win64');
}

function findExecutable(name, dirs = getBundledToolDirs()) {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch {
      // Ignore missing candidates.
    }
  }
  return null;
}

function runFile(command, args, timeoutMs) {
  return new Promise(resolve => {
    const child = execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error ? error.message : '',
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
    child.stdin?.end?.();
  });
}

function getCleanupScriptPath() {
  const local = path.join(__dirname, '../assets/update-processes.ps1')
    .replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const candidates = [local, process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked/electron/assets/update-processes.ps1') : ''];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

async function stopBundledProcesses(targets) {
  if (process.platform !== 'win32' || targets.length === 0) {
    return { ok: true, skipped: true };
  }
  const scriptPath = getCleanupScriptPath();
  if (!scriptPath) return { ok: false, error: 'Bundled process cleanup script is unavailable', stdout: '', stderr: '' };
  const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
  const nativePowerShell = path.join(windowsDirectory, 'Sysnative/WindowsPowerShell/v1.0/powershell.exe');
  const powershell = fs.existsSync(nativePowerShell) ? nativePowerShell
    : path.join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const payload = Buffer.from(JSON.stringify({ targets, timeoutMs: 5000 }), 'utf8').toString('base64');
  const result = await runFile(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-Mode', 'StopTools', '-PayloadBase64', payload
  ], 10000);
  let details;
  try { details = JSON.parse(result.stdout.trim()); }
  catch { return { ...result, ok: false, error: result.error || 'Process cleanup returned invalid status' }; }
  if (!details || typeof details !== 'object' || typeof details.ok !== 'boolean') {
    return { ...result, ok: false, error: result.error || 'Process cleanup returned invalid status' };
  }
  return {
    ...result,
    ok: result.ok && details.ok === true,
    error: details.error || result.error || (details.ok === true ? '' : 'Process cleanup failed'),
    details
  };
}

async function cleanupAndroidToolProcesses(options = {}) {
  const {
    includeScrcpy = false,
    includeFastboot = false,
    includeHdc = false,
    stopAdbServer = false,
    settleMs = 350
  } = options;

  const dirs = getBundledToolDirs();
  const names = [TOOL_NAMES.adb];
  if (includeScrcpy) names.push(TOOL_NAMES.scrcpy);
  if (includeFastboot) names.push(TOOL_NAMES.fastboot);
  const targets = dirs.flatMap(dir => names.map(name => path.join(dir, name)));
  if (includeHdc) {
    names.push(TOOL_NAMES.hdc);
    for (const dir of getBundledDirs('hdc')) targets.push(path.join(dir, TOOL_NAMES.hdc));
  }

  if (stopAdbServer) {
    const adbPath = findExecutable(TOOL_NAMES.adb, dirs);
    if (adbPath) {
      await runFile(adbPath, ['kill-server'], 2500);
    }
  }

  const result = await stopBundledProcesses(targets);
  if (settleMs > 0) await sleep(settleMs);
  return { ...result, dirs, names };
}

module.exports = {
  cleanupAndroidToolProcesses,
  getBundledToolDirs,
  findExecutable
};
