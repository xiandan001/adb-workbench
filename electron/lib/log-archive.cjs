const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');

const MIB = 1024 * 1024, QUOTAS = [128, 256, 512, 1024].map(value => value * MIB);
function normalizeArchiveOptions(value) {
  if (value === undefined) return { enabled: false, maxBytes: 512 * MIB };
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(',') !== 'enabled,maxBytes' || typeof value.enabled !== 'boolean' || !QUOTAS.includes(value.maxBytes)) {
    throw new Error(tr('日志归档选项无效；请选择允许的本机总配额。'));
  }
  return { enabled: value.enabled, maxBytes: value.maxBytes };
}
const emptyArchiveState = (captureId = '', quotaBytes = 512 * MIB) => ({ enabled: false, captureId, archiveId: '', status: 'disabled',
  bytes: 0, usedBytes: 0, quotaBytes, segments: 0, pendingBytes: 0, partial: false, error: '', reason: '' });
async function ownedArchiveDirectory(directory, fsOps = fs.promises) {
  if (!path.isAbsolute(directory) || path.basename(directory) !== 'log-archives') throw Error('LOG_ARCHIVE_DIRECTORY');
  await fsOps.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsOps.lstat(directory), real = await fsOps.realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(real, path.resolve(directory))) throw Error('LOG_ARCHIVE_DIRECTORY');
  return real;
}
async function archiveUsage(directory, fsOps) {
  let bytes = 0, count = 0;
  async function visit(root) {
    for (const item of await fsOps.readdir(root, { withFileTypes: true })) {
      if (++count > 20000) throw Error('LOG_ARCHIVE_INVENTORY_LIMIT');
      const target = path.join(root, item.name), relative = path.relative(directory, target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || item.isSymbolicLink()) throw Error('LOG_ARCHIVE_LINK');
      if (item.isDirectory()) await visit(target);
      else if (item.isFile()) bytes += (await fsOps.lstat(target)).size;
      else throw Error('LOG_ARCHIVE_ENTRY');
    }
  }
  await visit(directory); return bytes;
}
async function createLogArchive({ directory, captureId, options, onState = () => {}, onPressure = () => {} },
  { fsOps = fs.promises, segmentBytes = 64 * MIB, maxPendingBytes = 2 * MIB } = {}) {
  const config = normalizeArchiveOptions(options);
  if (!config.enabled) throw Error('LOG_ARCHIVE_DISABLED');
  const state = { ...emptyArchiveState(captureId, config.maxBytes), enabled: true, archiveId: randomUUID(), status: 'recording' };
  let queue = [], accepting = true, pressured = false, draining = null, handle = null, segmentSize = 0, ownDirectory = '', lastNotice = 0;
  let allocatedBytes = 0, diskFailed = false, stopped = null;
  const manifestReserve = 16 * 1024;
  const info = () => ({ ...state });
  function pressure(value) { if (pressured !== value) { pressured = value; onPressure(value); } }
  function notify(force = false) { if (force || Date.now() - lastNotice >= 100) { lastNotice = Date.now(); onState(info()); } }
  function fail(reason, error, discard = true) {
    accepting = false; state.status = 'partial'; state.partial = true; state.reason ||= reason; state.error ||= error;
    if (discard) { diskFailed = true; state.pendingBytes -= queue.reduce((sum, value) => sum + value.length, 0); queue = []; }
    pressure(false); notify(true);
  }
  try {
    const root = await ownedArchiveDirectory(directory, fsOps); state.usedBytes = await archiveUsage(root, fsOps); allocatedBytes = state.usedBytes;
    if (allocatedBytes + manifestReserve >= config.maxBytes) fail('quota', tr('本机日志归档已达总配额，采集继续，未删除旧日志。'));
    else { ownDirectory = path.join(root, state.archiveId); await fsOps.mkdir(ownDirectory, { mode: 0o700 }); }
  } catch (error) { fail('disk', tr('日志归档未完成：{0}；日志采集可继续。', { 0: error.message })); }
  async function closeSegment() { if (handle) { const current = handle; handle = null; await current.close(); } }
  async function writePiece(piece) {
    if (handle && segmentSize + piece.length > segmentBytes && piece.length <= segmentBytes) await closeSegment();
    let offset = 0;
    while (offset < piece.length) {
      if (!handle) { state.segments++; segmentSize = 0; handle = await fsOps.open(path.join(ownDirectory, `part-${String(state.segments).padStart(5, '0')}.log`), 'wx', 0o600); }
      const length = Math.min(piece.length - offset, segmentBytes - segmentSize);
      const result = await handle.write(piece, offset, length, null);
      if (!result.bytesWritten) throw Error('LOG_ARCHIVE_ZERO_WRITE');
      offset += result.bytesWritten; segmentSize += result.bytesWritten; state.bytes += result.bytesWritten; state.usedBytes += result.bytesWritten;
      if (segmentSize === segmentBytes) await closeSegment();
    }
  }
  function drain() {
    if (draining) return draining;
    draining = Promise.resolve().then(async () => {
      while (queue.length && !diskFailed) {
        const piece = queue.shift();
        try { await writePiece(piece); }
        catch (error) { fail('disk', tr('日志归档未完成：{0}；日志采集可继续。', { 0: error.message })); }
        finally { state.pendingBytes -= piece.length; if (state.pendingBytes <= maxPendingBytes / 4) pressure(false); notify(); }
      }
    }).finally(() => { draining = null; if (queue.length && !diskFailed) void drain(); });
    return draining;
  }
  function appendChunk(input) {
    if (!accepting) return false;
    const size = Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input);
    if (allocatedBytes + size + manifestReserve > config.maxBytes) {
      fail('quota', tr('本机日志归档已达总配额，采集继续，未删除旧日志。'), false); return false;
    }
    if (state.pendingBytes + size > maxPendingBytes) {
      fail('backpressure', tr('日志归档写入跟不上采集，归档已停止且可能不完整；采集继续。'), false); return false;
    }
    const piece = Buffer.from(input);
    allocatedBytes += piece.length; queue.push(piece); state.pendingBytes += piece.length;
    if (state.pendingBytes >= maxPendingBytes / 2) pressure(true);
    notify(); void drain(); return true;
  }
  function stop() {
    if (stopped) return stopped;
    accepting = false;
    stopped = (async () => {
      while (draining) await draining;
      try { await closeSegment(); } catch (error) { fail('disk', error.message); }
      if (!state.partial) state.status = 'stopped';
      pressure(false);
      if (ownDirectory) {
        try {
          const manifest = JSON.stringify({ version: 1, ...info(), completedAt: new Date().toISOString() }) + '\n';
          if (Buffer.byteLength(manifest) > manifestReserve) throw Error('LOG_ARCHIVE_METADATA_LIMIT');
          await fsOps.writeFile(path.join(ownDirectory, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 }); state.usedBytes += Buffer.byteLength(manifest);
        } catch (error) { fail('disk', tr('日志归档未完成：{0}；日志采集可继续。', { 0: error.message })); }
      }
      notify(true); return info();
    })();
    return stopped;
  }
  notify(true);
  return { append: raw => appendChunk(Buffer.from(raw + '\n', 'utf8')), appendChunk, stop, info };
}
module.exports = { normalizeArchiveOptions, emptyArchiveState, ownedArchiveDirectory, createLogArchive };
