const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { isDeepStrictEqual } = require('node:util');
const { normalizeApplicationLogEvent } = require('./application-log-policy.cjs');
const { ROW_BYTES } = require('./application-log-text.cjs');

function createApplicationLogSession({ directory, metadata = {}, io = fs.promises, now = Date.now,
  maxBytes = 20 * 1024 * 1024, maxDurationMs = 15 * 60 * 1000, setTimer = setTimeout, clearTimer = clearTimeout,
  onBeforeStop = () => {}, onRecordingChanged = () => {} } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root
    || directory.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 20 * 1024 * 1024) throw new TypeError('APP_LOG_CONFIGURATION');
  const root = path.resolve(directory), file = path.join(root, 'capture.log');
  const emptyLosses = () => ({ rateLimited: 0, queueLimited: 0, sizeLimited: 0, invalid: 0, textTruncated: 0, sensitiveOutput: 0, lineLimited: 0, recovery: 0, io: 0 });
  const state = { recording: false, available: false, startedAt: null, stoppedAt: null, bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '', losses: emptyLosses(), captureVersion: '' };
  let tail = Promise.resolve(), handle = null, timer = null, stopFlight = null, disposed = false, closing = false, scheduled = false, stopping = false;
  const notify = () => { try { onRecordingChanged(state.recording); } catch { /* Optional observers cannot change capture. */ } };
  let queue = [], pendingBytes = 0, inFlightBytes = 0, inFlightRecords = 0, bucket = -1, bucketCount = 0, captureIdentity = null;
  const enqueue = action => { const result = tail.then(action); tail = result.catch(() => {}); return result; };
  const snapshot = () => ({ ...state, losses: { ...state.losses } });
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
      let offset = 0, pending = '', skipFirstLine = false, records = 0, bytes = 0, first = null, last = null, invalidRows = 0, adjustedRows = 0;
      const consume = async text => {
        const lines = (pending + text).split('\n'); pending = lines.pop();
        if (skipFirstLine) {
          if (!lines.length) { pending = ''; return; }
          lines.shift(); skipFirstLine = false;
        }
        if (pending.length > ROW_BYTES) { pending = ''; skipFirstLine = true; invalidRows++; }
        for (const line of lines) {
          if (!line) continue;
          if (line.length > ROW_BYTES || Buffer.byteLength(line) > ROW_BYTES) { invalidRows++; continue; }
          try {
            const value = JSON.parse(line), event = normalizeApplicationLogEvent(value);
            if (!event || typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time) || !Number.isFinite(Date.parse(value.time))) { invalidRows++; continue; }
            const row = { time: value.time, ...event }, normalized = JSON.stringify(row) + '\n';
            if (!isDeepStrictEqual(value, row)) adjustedRows++;
            first ??= row; last = row; records++; bytes += Buffer.byteLength(normalized); batch.push(normalized);
          } catch { invalidRows++; }
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
      return { text: chunks.join(''), records, bytes, first, last, invalidRows, adjustedRows };
    } finally { await reader.close(); }
  }
  const initialized = enqueue(async () => {
    try {
      const capture = await readCapture();
      if (capture?.first?.source !== 'session' || capture.first.event !== 'start') return;
      state.available = true; state.records = capture.records; state.startedAt = Date.parse(capture.first.time);
      state.captureVersion = capture.first.version || '';
      state.bytes = capture.bytes;
      const end = capture.last;
      state.reason = end.source === 'session' && end.event === 'stop' ? end.reason : 'interrupted';
      state.stoppedAt = end.source === 'session' && end.event === 'stop' ? Date.parse(end.time) : null;
      state.dropped = (end.dropped || 0) + capture.invalidRows;
      state.losses = { ...emptyLosses(), ...end.losses, recovery: (end.losses?.recovery || 0) + capture.invalidRows + capture.adjustedRows };
    } catch (error) { if (error.code !== 'ENOENT') { state.reason = 'io-error'; state.error = 'IO_ERROR'; } }
  });
  async function close() { const current = handle; handle = null; if (current) await current.close(); }
  function fail() {
    state.recording = false; notify(); state.reason = 'io-error'; state.error = 'IO_ERROR'; state.stoppedAt = now();
    state.losses.io++; state.dropped += queue.length;
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
      const bytes = Buffer.concat(batch); inFlightBytes = bytes.length; inFlightRecords = batch.length;
      try { await write(bytes); } catch (error) { state.dropped += batch.length; throw error; } finally { inFlightBytes = 0; inFlightRecords = 0; }
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
    if (!state.recording || disposed || closing && !stopping) return false;
    try {
      const event = normalizeApplicationLogEvent(value); if (!event || event.source === 'session') { state.losses.invalid++; state.dropped++; return false; }
      const second = Math.floor(now() / 1000);
      if (bucket !== second) { bucket = second; bucketCount = 0; }
      const bytes = Buffer.from(JSON.stringify({ time: new Date(now()).toISOString(), ...event }) + '\n');
      if (bytes.length > ROW_BYTES) { state.losses.textTruncated++; state.dropped++; return false; }
      if (queue.length >= 256 || pendingBytes + bytes.length > 1024 * 1024) { state.losses.queueLimited++; state.dropped++; return false; }
      if (bucketCount >= 100) { state.losses.rateLimited++; state.dropped++; return false; }
      if (state.bytes + pendingBytes + inFlightBytes + bytes.length > maxBytes - 1024) { state.losses.sizeLimited++; state.dropped++; void stop('size-limit'); return false; }
      if (event.truncatedBytes || event.omittedCharacters) state.losses.textTruncated++;
      if (event.excludedValues) state.losses.sensitiveOutput += event.excludedValues;
      queue.push(bytes); pendingBytes += bytes.length; bucketCount++; schedule(); return true;
    } catch { state.losses.invalid++; state.dropped++; return false; }
  }
  function stop(reason = 'manual') {
    if (stopFlight) return stopFlight;
    if (stopping) return enqueue(snapshot);
    if (!state.recording) return enqueue(snapshot);
    stopping = true;
    try { onBeforeStop(); } catch { state.losses.invalid++; }
    state.recording = false; notify(); clearTimer(timer); timer = null;
    stopFlight = enqueue(async () => {
      try {
        await drain(); state.reason = reason; state.stoppedAt = now();
        const footer = { time: new Date(now()).toISOString(), source: 'session', event: 'stop', reason,
          records: state.records, dropped: state.dropped, durationMs: Math.max(0, now() - state.startedAt), losses: { ...state.losses } };
        await write(Buffer.from(JSON.stringify(footer) + '\n'));
        await handle.sync();
      } catch { fail(); }
      finally { await close().catch(() => { fail(); }); }
      return snapshot();
    }).finally(() => { stopFlight = null; stopping = false; });
    return stopFlight;
  }
  function start() {
    return enqueue(async () => {
      if (disposed || closing) return snapshot();
      if (state.recording) return snapshot();
      try {
        await directoryReady(true); const before = await fileStat();
        handle = await io.open(file, before ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0) : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        const current = await fileStat(), opened = await handle.stat();
        if (!current || !same(current, opened) || before && !same(before, opened)) throw Error('Capture file changed');
        captureIdentity = opened;
        await handle.truncate(0);
        Object.assign(state, { recording: false, available: false, startedAt: now(), stoppedAt: null, bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '', losses: emptyLosses() });
        bucket = -1; bucketCount = 0;
        const header = normalizeApplicationLogEvent({ ...metadata, source: 'session', event: 'start' });
        state.captureVersion = header.version || '';
        await write(Buffer.from(JSON.stringify({ time: new Date(now()).toISOString(), ...header }) + '\n'));
        await handle.sync();
        await close(); handle = await io.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
        await directoryReady();
        const appendIdentity = await handle.stat(), appendPath = await fileStat();
        if (!appendPath || !same(captureIdentity, appendIdentity) || !same(appendIdentity, appendPath)) throw Error('Capture file changed');
        state.recording = true; notify();
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
    const completeFooter = capture.last?.event === 'stop' && capture.last.source === 'session';
    if (completeFooter && !capture.invalidRows && !capture.adjustedRows) return capture.text;
    const footer = { ...(completeFooter ? capture.last : { time: new Date(now()).toISOString(), source: 'session', event: 'stop', reason: state.reason === 'io-error' ? 'io-error' : 'interrupted' }),
      dropped: (completeFooter ? capture.last.dropped || 0 : state.dropped) + capture.invalidRows,
      losses: { ...state.losses, recovery: (capture.last?.losses?.recovery || 0) + capture.invalidRows + capture.adjustedRows } };
    const prefix = completeFooter ? capture.text.slice(0, capture.text.lastIndexOf('\n', capture.text.length - 2) + 1) : capture.text;
    return prefix + JSON.stringify(footer) + '\n';
  }
  function noteLoss(reason, count = 1) {
    if (!state.recording || disposed || !Number.isSafeInteger(count) || count < 1) return;
    const key = { 'sensitive-output': 'sensitiveOutput', 'text-size': 'textTruncated', 'line-limit': 'lineLimited' }[reason];
    if (key) state.losses[key] = Math.min(1e12, state.losses[key] + count);
  }
  function recordFatal(value) {
    if (!state.recording || disposed || !Number.isInteger(handle?.fd) || !captureIdentity) return false;
    try {
      const opened = fs.fstatSync(handle.fd), current = fs.lstatSync(file);
      if (!same(captureIdentity, opened) || !same(opened, current) || current.isSymbolicLink()) return false;
      const remaining = maxBytes - Math.max(current.size, state.bytes + pendingBytes + inFlightBytes) - 512;
      const event = normalizeApplicationLogEvent(value);
      if (!event || event.source !== 'code') return false;
      const pendingRecords = queue.length + inFlightRecords;
      let row = { time: new Date(now()).toISOString(), ...event, fatal: true, pendingRecords, dropped: state.dropped + pendingRecords };
      let bytes = Buffer.from('\n' + JSON.stringify(row) + '\n');
      if (bytes.length > Math.min(16384, remaining)) {
        const { bounded } = require('./application-log-text.cjs');
        row.message = bounded(row.message || '', 512).text; row.stack = bounded(row.stack || '', 2048).text;
        row.truncatedBytes = (row.truncatedBytes || 0) + bytes.length; row.excludedValues = (row.excludedValues || 0) + 1;
        bytes = Buffer.from('\n' + JSON.stringify(row) + '\n');
      }
      if (bytes.length > Math.min(16384, remaining)) return false;
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(handle.fd, bytes, written, bytes.length - written);
        if (!count) return false;
        written += count; state.bytes += count;
      }
      state.records++; state.available = true;
      if (row.truncatedBytes) state.losses.textTruncated++;
      return true;
    } catch { return false; }
  }
  return { start, stop, record, recordFatal, text, noteLoss, isRecording: () => state.recording && !disposed && (!closing || stopping), async status() { await initialized; await tail; return snapshot(); },
    async dispose() { closing = true; const ending = state.recording ? stop() : null; await tail; if (ending) await ending; else await stop(); disposed = true; await close().catch(() => {}); } };
}
module.exports = { createApplicationLogSession };
