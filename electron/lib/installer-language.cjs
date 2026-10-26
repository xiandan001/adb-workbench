const { execFile: systemExecFile } = require('node:child_process');
const { win32: path } = require('node:path');
const { supportedLocales } = require('../locales/locale-config.json');

const INSTALLER_KEY = 'HKEY_LOCAL_MACHINE\\Software\\Veylo\\adb-workbench Installer';
const MAX_OUTPUT_BYTES = 64 * 1024;

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]/.test(value) || !path.isAbsolute(value)) return null;
  return path.normalize(value).replace(/\\+$/, '').toLowerCase();
}

function parseInstallerReceipt(output, executablePath) {
  if (typeof output !== 'string' || typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) return null;
  const lines = output.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.some(line => line.trim().toLowerCase() === INSTALLER_KEY.toLowerCase())) return null;
  const values = Object.create(null);
  for (const line of lines) {
    const match = /^\s+(Language|InstallLocation)\s+(REG_\w+)\s+(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(values, key) || match[2] !== 'REG_SZ') return null;
    values[key] = match[3];
  }
  if (!supportedLocales.includes(values.language)) return null;
  const directory = canonicalDirectory(values.installlocation);
  return directory && directory === canonicalDirectory(path.dirname(executablePath)) ? values.language : null;
}

async function readInstallerLanguage({ platform = process.platform, isPackaged = false, executablePath,
  execFile = systemExecFile, systemRoot = process.env.SystemRoot } = {}) {
  if (platform !== 'win32' || !isPackaged || !canonicalDirectory(systemRoot)
    || typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) return null;
  const output = await new Promise(resolve => {
    try {
      execFile(path.join(systemRoot, 'System32', 'reg.exe'), ['query', INSTALLER_KEY, '/reg:64'],
        { encoding: 'buffer', windowsHide: true, timeout: 2000, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout) => resolve(!error && Buffer.isBuffer(stdout) && stdout.length <= MAX_OUTPUT_BYTES ? stdout : null));
    } catch { resolve(null); }
  });
  if (!output) return null;
  // reg.exe can use the active Windows code page when its output is redirected.
  // A decoding candidate is accepted only if both the locale and exact path match.
  for (const encoding of ['utf-8', 'utf-16le', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    try {
      const locale = parseInstallerReceipt(new TextDecoder(encoding, { fatal: true }).decode(output), executablePath);
      if (locale) return locale;
    } catch { /* An incompatible or unavailable decoder cannot adopt a receipt. */ }
  }
  return null;
}

module.exports = { readInstallerLanguage, parseInstallerReceipt };
