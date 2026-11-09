const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { shellQuote } = require('./device-platform.cjs');

function hdcCandidates() {
  const file = process.platform === 'win32' ? 'hdc.exe' : 'hdc';
  return [process.resourcesPath && path.join(process.resourcesPath, '..', 'hdc', file),
    process.execPath && path.join(path.dirname(process.execPath), 'hdc', file), path.resolve(__dirname, '../../hdc', file)].filter(Boolean);
}
function getHdcCommand({ command } = {}) {
  const candidates = command ? [command] : hdcCandidates();
  const found = candidates.find(file => {
    try { return path.isAbsolute(file) && fs.statSync(file).isFile()
      && (process.platform !== 'win32' || fs.statSync(path.join(path.dirname(file), 'libusb_shared.dll')).isFile()); } catch { return false; }
  });
  if (!found) throw Object.assign(new Error(tr('未找到内置 HDC 或 USB 依赖，请修复安装。')), { code: 'HDC_NOT_FOUND', safe: true });
  return found;
}
function hdcFailure(stdout, stderr = '') {
  const text = [stdout, stderr].map(value => {
    const size = Buffer.isBuffer(value) ? value.length : String(value || '').length;
    const head = Buffer.isBuffer(value) ? value.toString('utf8', 0, 4096) : String(value || '').slice(0, 4096);
    return head + (size > 4096 ? '\n' + (Buffer.isBuffer(value) ? value.toString('utf8', size - 4096) : value.slice(-4096)) : '');
  }).join('\n');
  return text.split(/\r?\n/).find(line => /^\s*(?:\[Fail\]|Connect server failed|Unknown operation command|ExecuteCommand need connect-key|The sdk hdc\.exe version is too low)/i.test(line)) || '';
}
function normalizeHdcResult(error, stdout, stderr, marker, cancelled) {
  const buffer = Buffer.isBuffer(stdout), text = buffer ? stdout.toString('utf8') : String(stdout || '');
  const match = marker && new RegExp(`\\r?\\n${marker}:(\\d+)(?:\\r?\\n|$)`).exec(text);
  const output = match ? text.slice(0, match.index) : text;
  const failure = hdcFailure(text, stderr);
  const code = match ? Number(match[1]) : error ? (error.code ?? 1) : marker ? 1 : 0;
  return { ok: !cancelled && !error && code === 0 && !failure, stdout: buffer ? Buffer.from(output) : output,
    stderr: stderr || (buffer ? Buffer.alloc(0) : ''), code, cancelled: Boolean(cancelled),
    ...(error || failure || code !== 0 || cancelled ? { error: cancelled ? tr('用户取消') : failure || String(stderr || '') || error?.message || tr('鸿蒙命令未成功完成。'),
      timedOut: Boolean(error?.killed && !cancelled) } : {}) };
}
function createHdcRuntime({ execFile = cp.execFile, spawn = cp.spawn, resolve = resolveDeviceRef, commandPath = getHdcCommand } = {}) {
  const queues = new Map();
  const deviceCommands = new Set(['shell', 'file', 'install', 'uninstall', 'hilog', 'target', 'smode', 'jpid', 'track-jpid', 'tmode', 'bugreport', 'fport', 'rport']);
  function validateDeviceArgs(args) {
    if (!Array.isArray(args) || !deviceCommands.has(args[0]) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw Object.assign(new Error(tr('HDC 设备命令无效。')), { code: 'INVALID_HDC_COMMAND', safe: true });
    }
  }
  function invoke(args, options = {}) {
    return new Promise(resolveResult => {
      const buffer = options.encoding === 'buffer', empty = buffer ? Buffer.alloc(0) : '';
      if (options.signal?.aborted || options.isCancelled?.()) { resolveResult(normalizeHdcResult(null, empty, empty, null, true)); return; }
      let file, marker, native = args;
      try {
        file = commandPath(options);
        if (args.includes('\0') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error(tr('命令参数无效。'));
        const shellIndex = args[0] === '-t' && args[2] === 'shell' ? 2 : -1;
        if (shellIndex >= 0 && options.remoteExit !== false) {
          marker = '__AWB_HDC_' + randomUUID().replaceAll('-', '');
          const words = args.slice(shellIndex + 1);
          const command = words.length === 1 ? words[0] : words.map(shellQuote).join(' ');
          if (!command) throw new Error(tr('请提供要执行的命令。'));
          native = [...args.slice(0, shellIndex + 1), `sh -c ${shellQuote(command)}; __awb_status=$?; printf '\\n${marker}:%s\\n' "$__awb_status"`];
        }
      } catch (error) { resolveResult(normalizeHdcResult(error, empty, empty)); return; }
      let child, aborted = false;
      const cancel = () => { aborted = true; if (child && !child.killed) child.kill(); };
      child = execFile(file, native, { windowsHide: true, cwd: path.dirname(file), timeout: options.timeoutMs || options.timeout || 30000,
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024, ...(buffer ? { encoding: 'buffer' } : {}) }, (error, stdout, stderr) => {
        options.signal?.removeEventListener('abort', cancel);
        resolveResult(normalizeHdcResult(error, stdout, stderr, marker, aborted || options.isCancelled?.()));
      });
      child.stdin?.end?.(); options.onProcess?.(child);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
  }
  function runHdc(deviceId, args, options = {}) {
    let ref;
    try { validateDeviceArgs(args); ref = resolve(deviceId, options); if (ref.transport !== 'hdc') throw new Error(tr('所选设备不是 HDC 设备。')); }
    catch (error) { return Promise.resolve(normalizeHdcResult(error, '', '')); }
    const action = async () => {
      try {
        if (!options.deviceRef && resolve(deviceId, options).generation !== ref.generation) throw new Error(tr('设备连接已变化，请重试操作。'));
        options.assertCurrent?.();
        return await invoke(['-t', ref.targetKey, ...args], options);
      } catch (error) { return normalizeHdcResult(error, '', ''); }
    };
    if (options.queue === false) return action();
    const key = ref.id, previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action); queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }
  function runHdcHost(args, options = {}) {
    const valid = args?.length === 1 && ['-v', 'version', '-h'].includes(args[0])
      || args?.[0] === 'list' && args[1] === 'targets' && (args.length === 2 || args.length === 3 && args[2] === '-v')
      || args?.[0] === 'tconn' && typeof args[1] === 'string' && args[1] && !/^[-\s]/.test(args[1]) && !/[\u0000-\u001f\u007f]/u.test(args[1])
        && (args.length === 2 || args.length === 3 && args[2] === '-remove');
    if (!valid) return Promise.resolve(normalizeHdcResult(new Error(tr('HDC 主机命令无效。')), '', ''));
    return invoke(args, options).catch(error => normalizeHdcResult(error, '', ''));
  }
  function spawnHdc(deviceId, args, options = {}) {
    validateDeviceArgs(args);
    const ref = resolve(deviceId, options);
    if (ref.transport !== 'hdc') throw new Error(tr('所选设备不是 HDC 设备。'));
    const file = commandPath(options);
    return spawn(file, ['-t', ref.targetKey, ...args], { windowsHide: true, cwd: path.dirname(file), ...options });
  }
  return { runHdc, runHdcHost, spawnHdc };
}
module.exports = { ...createHdcRuntime(), createHdcRuntime, getHdcCommand, hdcCandidates, hdcFailure, normalizeHdcResult };
