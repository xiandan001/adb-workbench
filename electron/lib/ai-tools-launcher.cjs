const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fail } = require('./ai-tools-file-safety.cjs');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function buildLaunchScript({ executable, args }) { return `$ErrorActionPreference = 'Stop'\n& ${[executable, ...args].map(quote).join(' ')}\n`; }
async function findExecutable(command) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(command)) return null;
  const folders = String(process.env.PATH || '').split(path.delimiter).filter(folder => path.isAbsolute(folder.replace(/^"|"$/g, ''))).slice(0, 256);
  for (const folder of folders) for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']) {
    const candidate = path.join(folder.replace(/^"|"$/g, ''), command + suffix);
    try { const stat = await fs.promises.stat(candidate); if (stat.isFile()) return candidate; } catch { /* Only inspect fixed executable names, never run discovery scripts. */ }
  }
  return null;
}
function launchTerminal({ executable, args, cwd, env: additions }) {
  if (process.platform !== 'win32') throw fail('AI_TOOLS_PLATFORM', '当前外部终端启动适配仅支持 Windows');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|COMSPEC|USERNAME|COMPUTERNAME|LANG|LC_ALL)$/i.test(key)) env[key] = value;
  Object.assign(env, additions);
  const terminal = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = Buffer.from(buildLaunchScript({ executable, args }), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    // Visible console is intentional: the user explicitly confirmed "open external terminal".
    const child = spawn(terminal, ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', script], { cwd, env, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', () => reject(fail('AI_TOOLS_LAUNCH_FAILED', '外部终端启动失败，请检查系统终端与 CLI 安装')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
module.exports = { findExecutable, launchTerminal, buildLaunchScript };
