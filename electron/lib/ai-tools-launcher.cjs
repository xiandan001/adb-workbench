const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const { fail } = require('./ai-tools-file-safety.cjs');
const { buildLaunchScript, buildTerminalScript, buildBootstrapScript, encode } = require('./ai-tools-launcher-script.cjs');
async function findExecutable(command) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(command)) return null;
  const folders = String(process.env.PATH || '').split(path.delimiter).filter(folder => path.isAbsolute(folder.replace(/^"|"$/g, ''))).slice(0, 256);
  for (const folder of folders) for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']) {
    const candidate = path.join(folder.replace(/^"|"$/g, ''), command + suffix);
    try { const stat = await fs.promises.stat(candidate); if (stat.isFile()) return candidate; } catch { /* Only inspect fixed executable names, never run discovery scripts. */ }
  }
  return null;
}
function createAiToolsLauncher({ platform = process.platform, environment = process.env, spawnProcess = spawn,
  createServer: pipeServer = createServer, randomId = randomUUID, timeoutMs = 15000, keepOpen = true, windowTitle } = {}) {
  async function launchTerminal({ executable, args, cwd, env: additions = {}, signal } = {}) {
    if (platform !== 'win32') throw fail('AI_TOOLS_PLATFORM', tr("当前外部终端启动适配仅支持 Windows"));
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', tr("终端启动已取消"));
    const text = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0');
    if (!text(executable) || !path.win32.isAbsolute(executable) || !text(cwd) || !path.win32.isAbsolute(cwd)
      || !Array.isArray(args) || args.length > 32 || !args.every(text) || !additions || typeof additions !== 'object' || Array.isArray(additions)
      || Object.entries(additions).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || !text(value))) throw fail('AI_TOOLS_LAUNCH_ARGUMENT', tr("终端启动参数无效，未执行命令"));
    const env = {};
    for (const [key, value] of Object.entries(environment)) if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|COMSPEC|USERNAME|COMPUTERNAME|LANG|LC_ALL)$/i.test(key)) env[key] = value;
    Object.assign(env, additions);
    const terminal = path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const host = path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
    const command = path.win32.basename(executable).replace(/\.(?:exe|cmd|bat)$/i, '');
    const title = windowTitle || ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }[command.toLowerCase()] || `${command} · CLI`);
    const nonce = randomId(); const pipeName = `awb-ai-launch-${randomId()}`;
    const script = buildBootstrapScript({ host, terminal, cwd, keepOpen, terminalScript: buildTerminalScript({ executable, args, cwd, pipeName, nonce, title }) });
    return new Promise((resolve, reject) => {
      let settled = false; let granting = false; let child; let terminalPid; let ready; let stdout = ''; const sockets = new Set();
      const failed = () => fail('AI_TOOLS_LAUNCH_FAILED', tr("外部终端未能就绪，请检查 PowerShell、CLI 安装与项目目录；未确认 CLI 启动成功"));
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        for (const socket of sockets) socket.destroy();
        try { server.close(); } catch { /* The pipe may not have begun listening. */ }
        if (error) { child?.kill(); reject(error); } else resolve(result);
      };
      const abort = () => finish(fail('AI_TOOLS_CANCELLED', tr("终端启动已取消，未授权运行 CLI")));
      const permit = () => {
        if (settled || !ready || !terminalPid) return;
        if (ready.socket.destroyed || ready.message.parentPid !== terminalPid || ready.message.state !== 'ready' || ready.message.inputTTY !== true || ready.message.outputTTY !== true) return finish(failed());
        if (signal?.aborted) return abort();
        // Permission is sent only to the console created by this exact bootstrap.
        const socket = ready.socket; granting = true; sockets.delete(socket);
        try { socket.end('launch\n'); } catch { finish(failed()); return; }
        finish(null, { terminalReady: true, terminalPid, launcherPid: ready.message.pid });
      };
      const server = pipeServer(socket => {
        if (settled || sockets.size >= 4) { socket.destroy(); return; }
        sockets.add(socket); let bytes = Buffer.alloc(0); let received = false;
        socket.on('error', () => { if (ready?.socket === socket) finish(failed()); });
        socket.on('close', () => { sockets.delete(socket); if (!granting && ready?.socket === socket) finish(failed()); });
        socket.on('data', chunk => {
          if (settled || received) return;
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 2048) { socket.destroy(); return; }
          const end = bytes.indexOf(10); if (end < 0) return; received = true;
          let message;
          try { message = JSON.parse(bytes.subarray(0, end).toString('utf8')); } catch { socket.destroy(); return; }
          if (!message || message.nonce !== nonce || !Number.isSafeInteger(message.pid) || message.pid < 1 || !['ready', 'failed'].includes(message.state)) { socket.destroy(); return; }
          if (ready) { socket.destroy(); return; }
          ready = { socket, message }; permit();
        });
      });
      const timer = setTimeout(() => finish(fail('AI_TOOLS_LAUNCH_TIMEOUT', tr("等待可见终端就绪超时，未授权运行 CLI；请检查系统终端后重试"))), timeoutMs);
      server.once('error', () => finish(failed())); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
        if (settled) { try { server.close(); } catch { /* Already closed. */ } return; }
        try {
          // Hidden bootstrap explicitly creates the visible independent console.
          child = spawnProcess(terminal, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          child.once('error', () => finish(failed()));
          child.once('exit', code => { if (!settled && (code !== 0 || !terminalPid)) finish(failed()); });
          child.stderr.on('data', () => {}); // Never echo native errors that may include private paths.
          child.stdout.on('data', chunk => {
            if (settled) return;
            stdout += chunk.toString('utf8'); if (stdout.length > 4096) return finish(failed());
            if (!stdout.includes('\n')) return;
            try {
              const message = JSON.parse(stdout.trim());
              if (!Number.isSafeInteger(message.pid) || message.pid < 1) return finish(failed());
              terminalPid = message.pid; permit();
            } catch { finish(failed()); }
          });
        } catch { finish(failed()); }
      });
    });
  }
  return { launchTerminal };
}
function launchTerminal(options) { return createAiToolsLauncher().launchTerminal(options); }
module.exports = { findExecutable, launchTerminal, buildLaunchScript, createAiToolsLauncher };
