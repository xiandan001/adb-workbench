const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const LOCALES = new Set(['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR']);
const FAILURE_CODES = new Set(['UAC_CANCELLED', 'START_FAILED', 'INSTALLER_EXITED', 'READY_TIMEOUT',
  'HELPER_TIMEOUT', 'INVALID_INPUT', 'INVALID_INSTALLER', 'CHECKSUM_MISMATCH', 'PROTOCOL_ERROR']);
const failure = code => ({ ok: false, code });

function validInput(value) {
  return value && typeof value === 'object' && typeof value.installerPath === 'string'
    && !value.installerPath.includes('\0') && path.isAbsolute(value.installerPath)
    && path.extname(value.installerPath).toLowerCase() === '.exe'
    && Number.isInteger(value.parentPid) && value.parentPid > 0 && value.parentPid <= 2147483647
    && LOCALES.has(value.locale) && typeof value.sha512 === 'string'
    && /^[A-Za-z0-9+/]{86}==$/.test(value.sha512)
    && Buffer.from(value.sha512, 'base64').length === 64;
}

async function verifyInstaller(installerPath, sha512) {
  let file;
  try {
    file = await fs.promises.open(installerPath, 'r');
    const before = await file.stat();
    if (!before.isFile() || before.size < 2) return failure('INVALID_INSTALLER');
    const header = Buffer.alloc(2);
    const read = await file.read(header, 0, 2, 0);
    if (read.bytesRead !== 2 || header.toString('ascii') !== 'MZ') return failure('INVALID_INSTALLER');
    const hash = crypto.createHash('sha512');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || !crypto.timingSafeEqual(hash.digest(), Buffer.from(sha512, 'base64'))) return failure('CHECKSUM_MISMATCH');
    return { ok: true };
  } catch {
    return failure('INVALID_INSTALLER');
  } finally {
    await file?.close().catch(() => {});
  }
}

function getScriptPath() {
  const local = path.join(__dirname, '../assets/update-launch.ps1').replace(/\.asar([\\/])/, '.asar.unpacked$1');
  return [local, process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked/electron/assets/update-launch.ps1') : '']
    .find(candidate => candidate && fs.existsSync(candidate));
}

function parseHelperResult(error, stdout) {
  if (error?.killed || error?.code === 'ETIMEDOUT') return failure('HELPER_TIMEOUT');
  const helperExitCode = Number.isInteger(error?.code) ? error.code : error ? undefined : 0;
  if (error && !stdout?.trim()) return { ...failure('START_FAILED'), ...(helperExitCode === undefined ? {} : { helperExitCode }) };
  let value;
  try { value = JSON.parse(stdout || ''); } catch { return failure('PROTOCOL_ERROR'); }
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') return failure('PROTOCOL_ERROR');
  const installerPid = Number.isInteger(value.installerPid) && value.installerPid > 0 && value.installerPid <= 2147483647
    ? value.installerPid : undefined;
  if (value.ok) {
    if (error || value.code !== 'READY' || installerPid === undefined) return failure('PROTOCOL_ERROR');
    return { ok: true, code: 'READY', installerPid, helperExitCode: 0 };
  }
  if (!FAILURE_CODES.has(value.code)) return failure('PROTOCOL_ERROR');
  return { ok: false, code: value.code, ...(installerPid === undefined ? {} : { installerPid }),
    ...(helperExitCode === undefined ? {} : { helperExitCode }) };
}

function invokeHelper(scriptPath, payload) {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const native = path.join(windowsRoot, 'Sysnative/WindowsPowerShell/v1.0/powershell.exe');
  const powershell = fs.existsSync(native) ? native : path.join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return new Promise(resolve => {
    try {
      const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-PayloadBase64', encoded],
      { windowsHide: true, timeout: 90000, maxBuffer: 16384 }, (error, stdout) => resolve(parseHelperResult(error, stdout)));
      child.stdin?.end?.();
    } catch {
      resolve(failure('START_FAILED'));
    }
  });
}

async function launchUpdateInstaller(options) {
  if (process.platform !== 'win32') return failure('UNSUPPORTED_PLATFORM');
  if (!validInput(options)) return failure('INVALID_INPUT');
  const verified = await verifyInstaller(options.installerPath, options.sha512);
  if (!verified.ok) return verified;
  const scriptPath = getScriptPath();
  if (!scriptPath) return failure('SCRIPT_UNAVAILABLE');
  return invokeHelper(scriptPath, { installerPath: options.installerPath, parentPid: options.parentPid,
    locale: options.locale, readyToken: crypto.randomBytes(16).toString('hex'), sha512: options.sha512 });
}

module.exports = { launchUpdateInstaller };
