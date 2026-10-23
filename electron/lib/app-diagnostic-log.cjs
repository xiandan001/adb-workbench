const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');

const MODULES = new Set(['app', 'ipc', 'renderer', 'updater', 'startup', 'diagnostics']);
const OPERATIONS = new Set(['startup', 'ready', 'shutdown', 'failure', 'ipc', 'renderer-error', 'check', 'download', 'install', 'collect', 'snapshot']);
const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'started']);
const CODES = new Set(['IPC_THROW', 'IPC_REJECT', 'IPC_FAILURE', 'UNKNOWN', 'TIMEOUT', 'CANCELLED', 'ACCESS_DENIED', 'INVALID_INPUT', 'NOT_FOUND', 'BUSY', 'UNAVAILABLE', 'CONNECTION_LOST']);
const CHANNELS = new Set(['adb:getDevices', 'adb:listDevices', 'adb:shell', 'adb:connect', 'adb:disconnect',
  'serial:connect', 'serial:disconnect', 'serial:list', 'serial:snapshot', 'serial:send', 'serial:terminal-write', 'serial:terminal-read',
  'ssh:connect', 'ssh:disconnect', 'ssh:terminal-write', 'ssh:terminal-read', 'ssh:open-terminal', 'ssh:list', 'ssh:upload', 'ssh:download',
  'ai-tools:request', 'env-check:run', 'migration:bootstrap', 'startup-settings:get', 'startup-settings:set',
  'feedback:diagnostics', 'feedback:preview', 'feedback:submit', 'log:exportToFile', 'logSession:save']);
const safeChannel = value => CHANNELS.has(value) ? value : 'other';
const safeVersion = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,5})?)?$/.test(value) ? value : 'unknown';

function dataFields(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return key => descriptors[key] && Object.hasOwn(descriptors[key], 'value') ? descriptors[key].value : undefined;
}
function normalizeEvent(value, time, version) {
  const get = dataFields(value);
  if (!get || !MODULES.has(get('module')) || !OPERATIONS.has(get('operation')) || !OUTCOMES.has(get('outcome'))) return null;
  const level = get('level') ?? 'info';
  if (!['info', 'warn', 'error'].includes(level)) return null;
  const next = { time, version, level, module: get('module'), operation: get('operation'), outcome: get('outcome') };
  if (get('channel') !== undefined) next.channel = safeChannel(get('channel'));
  if (get('errorCode') !== undefined) next.errorCode = CODES.has(get('errorCode')) ? get('errorCode') : 'UNKNOWN';
  if (['thrown', 'rejected', 'structured', 'Error', 'TypeError', 'RangeError', 'AbortError'].includes(get('errorType'))) next.errorType = get('errorType');
  if (Number.isFinite(get('durationMs')) && get('durationMs') >= 0) next.durationMs = Math.min(Math.round(get('durationMs')), 3600000);
  return next;
}

function createAppDiagnosticLog({ directory, version, filesystem = fs.promises, now = Date.now,
  maxFileBytes = 256 * 1024, maxSnapshotBytes = 16 * 1024 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root
    || directory.includes('\0') || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 512 || maxFileBytes > 256 * 1024
    || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 256 || maxSnapshotBytes > 16 * 1024) throw new TypeError('Invalid diagnostic log configuration');
  const io = filesystem.promises || filesystem; const root = path.resolve(directory); const logVersion = safeVersion(version);
  const files = [0, 1, 2].map(index => path.join(root, index ? `app.${index}.log` : 'app.log'));
  let disposed = false; let lossy = false; let scheduled = false; let sequence = 0; let processed = 0;
  let bucket = -1; let bucketCount = 0; const recent = new Map(); const queue = [];
  let tail = Promise.resolve();
  function serial(operation) { const task = tail.then(operation); tail = task.catch(() => {}); return task; }
  async function safeDirectory(create = false) {
    const parsed = path.parse(root); let current = parsed.root;
    const parts = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); let stat;
      try { stat = await io.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || index !== parts.length - 1) throw error;
        if (!create) return false;
        try { await io.mkdir(current, { mode: 0o700 }); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        stat = await io.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe diagnostic directory');
    }
    return true;
  }
  async function fileStat(file) {
    let stat; try { stat = await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxFileBytes) throw Error('Unsafe diagnostic file');
    return stat;
  }
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && b.nlink === 1 && b.isFile();
  async function rotate() {
    await safeDirectory();
    for (const file of files) await fileStat(file);
    if (await fileStat(files[2])) await io.unlink(files[2]);
    for (let i = 1; i >= 0; i--) if (await fileStat(files[i])) await io.rename(files[i], files[i + 1]);
    lossy = true;
  }
  async function append(line) {
    await safeDirectory(true); let before = await fileStat(files[0]);
    if (before && before.size + line.length > maxFileBytes) { await rotate(); before = null; }
    const flags = before ? fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0)
      : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const handle = await io.open(files[0], flags, 0o600);
    try {
      const opened = await handle.stat(); const current = await fileStat(files[0]); await safeDirectory();
      if (!current || !sameFile(current, opened) || before && !sameFile(before, opened)) throw Error('Diagnostic file changed');
      await handle.writeFile(line);
    } finally { await handle.close(); }
  }
  function schedule() {
    if (scheduled || !queue.length) return;
    scheduled = true;
    void serial(async () => {
      const batch = queue.splice(0);
      try { for (const item of batch) await append(item.bytes); }
      catch { lossy = true; }
      finally { processed = batch.at(-1)?.id || processed; scheduled = false; if (queue.length) schedule(); }
    }).catch(() => { lossy = true; scheduled = false; });
  }
  function record(event) {
    if (disposed) return false;
    try {
      const timestamp = now(); const row = normalizeEvent(event, new Date(timestamp).toISOString(), logVersion);
      if (!row) return false;
      const key = JSON.stringify({ ...row, time: undefined, durationMs: undefined });
      const currentBucket = Math.floor(timestamp / 1000);
      if (currentBucket !== bucket) { bucket = currentBucket; bucketCount = 0; }
      for (const [name, at] of recent) if (timestamp - at >= 1000) recent.delete(name);
      if (sequence - processed >= 128 || bucketCount >= 20 || recent.has(key)) { lossy = true; return false; }
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      if (bytes.length > 512 || bytes.length > maxFileBytes) { lossy = true; return false; }
      if (recent.size >= 128) recent.delete(recent.keys().next().value);
      recent.set(key, timestamp); bucketCount++; queue.push({ id: ++sequence, bytes }); schedule(); return true;
    } catch { lossy = true; return false; }
  }
  async function flush() {
    const target = sequence;
    while (processed < target) { schedule(); await tail; }
  }
  async function readFile(file) {
    const before = await fileStat(file); if (!before) return null;
    const handle = await io.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat(); if (!sameFile(before, stat)) throw Error('Diagnostic file changed');
      const buffer = Buffer.alloc(before.size); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      await safeDirectory(); const after = await fileStat(file);
      if (bytesRead !== before.size || !after || !sameFile(before, after)) throw Error('Diagnostic file changed');
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  }
  async function snapshot() {
    await flush();
    return serial(async () => {
      let truncated = lossy; const rows = []; let bytes = 0;
      try {
        if (!await safeDirectory()) return { text: '', bytes: 0, lines: 0, truncated };
        for (const file of [...files].reverse()) {
          const text = await readFile(file); if (text === null) continue;
          const lines = text.split('\n'); if (lines.pop()) truncated = true;
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time)
                || !Number.isFinite(Date.parse(value.time)) || safeVersion(value.version) !== value.version) throw Error('Invalid diagnostic row');
              const row = normalizeEvent(value, value.time, value.version); if (!row) throw Error('Invalid diagnostic row');
              const normalized = `${JSON.stringify(row)}\n`; const size = Buffer.byteLength(normalized);
              if (size > 512 || size > maxSnapshotBytes) { truncated = true; continue; }
              rows.push({ text: normalized, bytes: size }); bytes += size;
              while (bytes > maxSnapshotBytes) { bytes -= rows.shift().bytes; truncated = true; }
            } catch { truncated = true; }
          }
        }
        return { text: rows.map(row => row.text).join(''), bytes, lines: rows.length, truncated };
      } catch { return { text: '', bytes: 0, lines: 0, truncated: true }; }
    });
  }
  return { record, snapshot, flush, async dispose() { disposed = true; await flush(); recent.clear(); } };
}

module.exports = { createAppDiagnosticLog, safeDiagnosticChannel: safeChannel };
