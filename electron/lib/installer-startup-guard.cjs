const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

function probeActiveInstaller({ platform = process.platform, environment = process.env, io = fs, run = execFileSync } = {}) {
  if (platform !== 'win32') return { ok: true, active: false };
  const dataRoot = environment.ProgramData || 'C:\\ProgramData';
  if (!path.win32.isAbsolute(dataRoot)) return { ok: false, active: true };
  const marker = path.win32.join(dataRoot, 'Veylo/adb-workbench/install-active.json');
  try { if (!io.existsSync(marker)) return { ok: true, active: false }; }
  catch { return { ok: false, active: true }; }
  const script = path.join(__dirname, '../assets/installer-active.ps1').replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const windows = environment.SystemRoot || 'C:\\Windows';
  const native = path.win32.join(windows, 'Sysnative/WindowsPowerShell/v1.0/powershell.exe');
  const executable = io.existsSync(native) ? native : path.win32.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const response = JSON.parse(run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096 }));
    if (response?.ok === true && typeof response.active === 'boolean') return { ok: true, active: response.active };
  } catch { /* Do not let an unreadable active marker permit profile or device startup. */ }
  return { ok: false, active: true };
}

function readGuardLocale(app, io = fs) {
  const { supportedLocales } = require('../locales/locale-config.json');
  try {
    const file = path.join(app.getPath('appData'), 'adb-workbench/settings.json');
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return 'en-US';
    const value = JSON.parse(io.readFileSync(file, 'utf8')).locale;
    return supportedLocales.includes(value) ? value : 'en-US';
  } catch { return 'en-US'; }
}

function launchInstallerWaitHost({ app }, _state, { io = fs, startProcess = spawn, temporaryDirectory = os.tmpdir(),
  resourcesPath = process.resourcesPath, executablePath = process.execPath } = {}) {
  const candidates = [resourcesPath ? path.join(resourcesPath, 'installer-wait.exe') : '',
    path.join(__dirname, '../../build/generated/installer-ui/VeyloInstallWait.exe')];
  const source = candidates.find(file => file && io.existsSync(file));
  if (!source) throw Error('INSTALL_WAIT_HOST_MISSING');
  const sourceStat = io.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 2 || sourceStat.size > 4 * 1024 * 1024) throw Error('INSTALL_WAIT_HOST_INVALID');
  const bytes = io.readFileSync(source);
  if (bytes.subarray(0, 2).toString() !== 'MZ') throw Error('INSTALL_WAIT_HOST_INVALID');
  const parent = io.realpathSync.native(temporaryDirectory);
  const installDirectory = path.dirname(io.realpathSync.native(executablePath));
  const outside = path.relative(installDirectory, parent);
  if (!outside || (!outside.startsWith('..' + path.sep) && outside !== '..' && !path.isAbsolute(outside))) throw Error('INSTALL_WAIT_TEMP_INVALID');
  const temporary = io.mkdtempSync(path.join(parent, 'veylo-install-wait-'));
  const relative = path.relative(parent, io.realpathSync.native(temporary));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('INSTALL_WAIT_TEMP_INVALID');
  const copy = path.join(temporary, 'VeyloInstallWait.exe');
  io.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
  const copied = io.lstatSync(copy);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1
    || crypto.createHash('sha256').update(io.readFileSync(copy)).digest('hex') !== crypto.createHash('sha256').update(bytes).digest('hex')) throw Error('INSTALL_WAIT_HOST_INVALID');
  const args = [`--locale=${readGuardLocale(app, io)}`, `--target=${Buffer.from(executablePath, 'utf8').toString('base64')}`];
  return new Promise((resolve, reject) => {
    const child = startProcess(copy, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve({ started: true }); });
  });
}

function runUnlessInstalling(context, start, { probe = probeActiveInstaller, showWait = launchInstallerWaitHost } = {}) {
  const state = probe();
  if (state.ok && !state.active) { start(); return false; }
  // The notification runs from an independent image outside the install tree.
  // This process must exit so it cannot deadlock the installer's exact-image wait.
  try { void Promise.resolve(showWait(context, state)).then(() => context.app.quit(), () => context.app.quit()); }
  catch { context.app.quit(); }
  return true;
}

module.exports = { probeActiveInstaller, readGuardLocale, runUnlessInstalling, launchInstallerWaitHost };
