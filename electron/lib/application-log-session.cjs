const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { normalizeApplicationLogEvent } = require('./application-log-policy.cjs');

function createApplicationLogSession({ directory, metadata = {}, io = fs.promises, now = Date.now,
  maxBytes = 20 * 1024 * 1024, maxDurationMs = 15 * 60 * 1000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root
    || directory.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 20 * 1024 * 1024) throw new TypeError('APP_LOG_CONFIGURATION');
  const root = path.resolve(directory), file = path.join(root, 'capture.log');
  const state = { recording: false, available: false, startedAt: null, stoppedAt: null, bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '' };
  let tail = Promise.resolve(), handle = null, timer = null, stopFlight = null, disposed = false, scheduled = false;
  let queue = [], pendingBytes = 0, inFlightBytes = 0, bucket = -1, bucketCount = 0;
  const enqueue = action => { const result = tail.then(action); tail = result.catch(() => {}); return result; };
  const snapshot = () => ({ ...state });
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && b.isFile() && b.nlink === 1;
  async function directoryReady(create = false) {
    const parsed = path.parse(root); let current = parsed.root;
    for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); let stat;
      try { stat = await io.lstat(current); }
      catch (error) { if (error.code !== 'ENOENT' || !create) throw error; await io.mkdir(current, { mode: 0o700 }); stat = await io.lstat(current); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe capture directory');
    }
  }
  async function fileStat() {
    try {
      const stat = await io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw Error('Unsafe capture file');
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function readCapture() {
    await directoryReady(); const before = await fileStat(); if (!before) return null;
    const reader = await io.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (!same(before, await reader.stat())) throw Error('Capture file changed');
      const buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder('utf8'), chunks = [], batch = [];
      let offset = 0, pending = '', skipFirstLine = false, records = 0, bytes = 0, first = null, last = null;
      const consume = async text => {
        const lines = (pending + text).split('\n'); pending = lines.pop();
        if (skipFirstLine) {
          if (!lines.length) { pending = ''; return; }
          lines.shift(); skipFirstLine = false;
        }
        if (pending.length > 2048) { pending = ''; skipFirstLine = true; }
        for (const line of lines) {
          if (!line || line.length > 2048) continue;
          try {
            const value = JSON.parse(line), event = normalizeApplicationLogEvent(value);
            if (!event || typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time) || !Number.isFinite(Date.parse(value.time))) continue;
            const row = { time: value.time, ...event }, normalized = JSON.stringify(row) + '\n';
            first ??= row; last = row; records++; bytes += Buffer.byteLength(normalized); batch.push(normalized);
          } catch { /* Invalid external rows cannot become diagnostic content. */ }
          if (batch.length >= 128) {
            chunks.push(batch.join('')); batch.length = 0;
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      };
      while (offset < before.size) {
        const result = await reader.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!result.bytesRead) throw Error('Capture file changed');
        offset += result.bytesRead; await consume(decoder.write(buffer.subarray(0, result.bytesRead)));
      }
      await consume(decoder.end() + '\n');
      if (batch.length) chunks.push(batch.join(''));
      const after = await fileStat(); await directoryReady();
      if (!after || !same(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Error('Capture file changed');
      return { text: chunks.join(''), records, bytes, first, last };
    } finally { await reader.close(); }
  }
  const initialized = enqueue(async () => {
    try {
      const capture = await readCapture();
      if (capture?.first?.source !== 'session' || capture.first.event !== 'start') return;
      state.available = true; state.records = capture.records; state.startedAt = Date.parse(capture.first.time);
      state.bytes = capture.bytes;
      const end = capture.last;
      state.reason = end.source === 'session' && end.event === 'stop' ? end.reason : 'interrupted';
      state.stoppedAt = end.source === 'session' && end.event === 'stop' ? Date.parse(end.time) : null;
      state.dropped = end.dropped || 0;
    } catch (error) { if (error.code !== 'ENOENT') { state.reason = 'io-error'; state.error = 'IO_ERROR'; } }
  });
  async function close() { const current = handle; handle = null; if (current) await current.close(); }
  function fail() {
    state.recording = false; state.reason = 'io-error'; state.error = 'IO_ERROR'; state.stoppedAt = now();
    clearTimer(timer); timer = null; queue = []; pendingBytes = 0;
  }
  async function write(bytes) {
    if (!handle) throw Error('Capture is closed');
    await directoryReady(); const current = await fileStat();
    if (!current || !same(current, await handle.stat())) throw Error('Capture file changed');
    await handle.writeFile(bytes); state.bytes += bytes.length;
    state.records += bytes.toString('utf8').split('\n').length - 1; state.available = true;
  }
  async function drain() {
    const batch = queue; queue = []; pendingBytes = 0;
    if (batch.length) {
      const bytes = Buffer.concat(batch); inFlightBytes = bytes.length;
      try { await write(bytes); } finally { inFlightBytes = 0; }
    }
  }
  function schedule() {
    if (scheduled) return; scheduled = true;
    void enqueue(async () => {
      try { await drain(); } catch { fail(); await close().catch(() => {}); }
      finally { scheduled = false; if (queue.length) schedule(); }
    });
  }
  function record(value) {
    if (!state.recording || disposed) return false;
    try {
      const event = normalizeApplicationLogEvent(value); if (!event || event.source === 'session') return false;
      const second = Math.floor(now() / 1000);
      if (bucket !== second) { bucket = second; bucketCount = 0; }
      const bytes = Buffer.from(JSON.stringify({ time: new Date(now()).toISOString(), ...event }) + '\n');
      if (queue.length >= 256 || bucketCount >= 100) { state.dropped++; return false; }
      if (state.bytes + pendingBytes + inFlightBytes + bytes.length > maxBytes - 1024) { state.dropped++; void stop('size-limit'); return false; }
      queue.push(bytes); pendingBytes += bytes.length; bucketCount++; schedule(); return true;
    } catch { state.dropped++; return false; }
  }
  function stop(reason = 'manual') {
    if (stopFlight) return stopFlight;
    if (!state.recording) return enqueue(snapshot);
    state.recording = false; clearTimer(timer); timer = null;
    stopFlight = enqueue(async () => {
      try {
        await drain(); state.reason = reason; state.stoppedAt = now();
        const footer = { time: new Date(now()).toISOString(), source: 'session', event: 'stop', reason,
          records: state.records, dropped: state.dropped, durationMs: Math.max(0, now() - state.startedAt) };
        await write(Buffer.from(JSON.stringify(footer) + '\n'));
        await handle.sync();
      } catch { fail(); }
      finally { await close().catch(() => { fail(); }); }
      return snapshot();
    }).finally(() => { stopFlight = null; });
    return stopFlight;
  }
  function start() {
    return enqueue(async () => {
      if (disposed) return snapshot();
      if (state.recording) return snapshot();
      try {
        await directoryReady(true); const before = await fileStat();
        handle = await io.open(file, before ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0) : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        const current = await fileStat(), opened = await handle.stat();
        if (!current || !same(current, opened) || before && !same(before, opened)) throw Error('Capture file changed');
        await handle.truncate(0);
        Object.assign(state, { recording: false, available: false, startedAt: now(), stoppedAt: null, bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '' });
        bucket = -1; bucketCount = 0;
        const header = normalizeApplicationLogEvent({ ...metadata, source: 'session', event: 'start' });
        await write(Buffer.from(JSON.stringify({ time: new Date(now()).toISOString(), ...header }) + '\n'));
        await handle.sync(); state.recording = true;
        timer = setTimer(() => { void stop('time-limit'); }, maxDurationMs); timer.unref?.();
      } catch { fail(); await close().catch(() => {}); }
      return snapshot();
    });
  }
  async function text() {
    await tail;
    if (state.recording) throw Error('Stop capture before exporting');
    const capture = await readCapture();
    if (!state.available || capture?.first?.source !== 'session' || capture.first.event !== 'start') throw Error('No capture available');
    const footer = capture.last?.event === 'stop' && capture.last.source === 'session' ? ''
      : JSON.stringify({ time: new Date(now()).toISOString(), source: 'session', event: 'stop', reason: 'interrupted', dropped: state.dropped }) + '\n';
    return capture.text + footer;
  }
  return { start, stop, record, text, async status() { await initialized; await tail; return snapshot(); },
    async dispose() { disposed = true; await tail; await stop(); await close().catch(() => {}); } };
}
module.exports = { createApplicationLogSession };
