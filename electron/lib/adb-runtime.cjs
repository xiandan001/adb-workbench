const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { findExecutable } = require('./android-tool-cleanup.cjs');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_DEVICE_CONCURRENCY = 1;
const GLOBAL_QUEUE_KEY = '__global__';

const commandCache = new Map();
const queues = new Map();

function getAdbCommand() {
  const cached = commandCache.get('adb');
  if (cached && commandExists(cached)) return cached;
  const command = findExecutable('adb.exe') || 'adb';
  commandCache.set('adb', command);
  return command;
}

function runAdb(args, options = {}) {
  const normalizedArgs = normalizeArgs(args);
  const action = () => {
    if (isCancelled(options)) return Promise.resolve(cancelledResult(options));
    return execAdb(normalizedArgs, options);
  };
  if (options.queue === false) return action();

  const deviceId = options.deviceId || getDeviceIdFromArgs(normalizedArgs);
  if (!deviceId && options.queueGlobal !== true) return action();

  return enqueue(deviceId || GLOBAL_QUEUE_KEY, action, options.concurrency || DEFAULT_DEVICE_CONCURRENCY);
}

function spawnAdb(args, options = {}) {
  return spawn(getAdbCommand(), normalizeArgs(args), {
    windowsHide: true,
    ...options
  });
}

function execAdb(args, options) {
  return new Promise((resolve) => {
    if (isCancelled(options)) {
      resolve(cancelledResult(options));
      return;
    }
    const timeout = options.timeoutMs || options.timeout || DEFAULT_TIMEOUT_MS;
    const execOptions = {
      windowsHide: true,
      timeout,
      maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER
    };
    if (options.encoding === 'buffer') execOptions.encoding = 'buffer';
    const child = execFile(getAdbCommand(), args, execOptions, (error, stdout, stderr) => {
      const output = stdout || (options.encoding === 'buffer' ? Buffer.alloc(0) : '');
      const errorOutput = stderr || (options.encoding === 'buffer' ? Buffer.alloc(0) : '');
      if (error) {
        resolve({
          ok: false,
          stdout: output,
          stderr: errorOutput,
          error: normalizeError(error, errorOutput),
          timedOut: Boolean(error.killed && error.signal),
          code: error.code
        });
        return;
      }
      resolve({ ok: true, stdout: output, stderr: errorOutput, code: 0 });
    });
    child.stdin?.end?.();
    if (typeof options.onProcess === 'function') options.onProcess(child);
  });
}

function enqueue(key, action, concurrency) {
  const queueKey = String(key || GLOBAL_QUEUE_KEY);
  let queue = queues.get(queueKey);
  if (!queue) {
    queue = { active: 0, pending: [], concurrency };
    queues.set(queueKey, queue);
  }
  queue.concurrency = Math.max(1, Number(concurrency) || DEFAULT_DEVICE_CONCURRENCY);

  return new Promise((resolve) => {
    queue.pending.push({ action, resolve });
    drainQueue(queueKey);
  });
}

function drainQueue(queueKey) {
  const queue = queues.get(queueKey);
  if (!queue) return;
  while (queue.active < queue.concurrency && queue.pending.length > 0) {
    const item = queue.pending.shift();
    queue.active += 1;
    Promise.resolve()
      .then(item.action)
      .then(item.resolve, error => item.resolve({ ok: false, stdout: '', stderr: '', error: error.message || String(error) }))
      .finally(() => {
        queue.active -= 1;
        if (queue.pending.length === 0 && queue.active === 0) {
          queues.delete(queueKey);
          return;
        }
        drainQueue(queueKey);
      });
  }
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map(item => String(item)) : [];
}

function getDeviceIdFromArgs(args) {
  const index = args.indexOf('-s');
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return '';
}

function normalizeError(error, stderr) {
  const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  return stderrText || error.message || 'adb_failed';
}

function isCancelled(options) {
  return typeof options.isCancelled === 'function' && options.isCancelled();
}

function cancelledResult(options) {
  const empty = options.encoding === 'buffer' ? Buffer.alloc(0) : '';
  return { ok: false, stdout: empty, stderr: empty, error: 'cancelled', cancelled: true, code: null };
}

function commandExists(command) {
  if (!command || command === 'adb') return true;
  try {
    return fs.statSync(path.resolve(command)).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  getAdbCommand,
  runAdb,
  spawnAdb
};
