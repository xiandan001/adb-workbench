import { tr } from './i18n.js';
import { MAX_TERMINAL_INPUT_BYTES, TERMINAL_BATCH_BYTES, splitTerminalInput, terminalInputBytes } from './serialTerminalInput.js';

export function createSerialTerminalWriter({ sessionId, write, canWrite = () => true, onError = () => {}, onSent = () => {}, delayMs = 8 }) {
  let queue = [];
  let queuedBytes = 0;
  let inFlightBytes = 0;
  let running = null;
  let timer;
  let disposed = false;
  let paused = false;

  function clearPending() {
    clearTimeout(timer);
    timer = null;
    queue = [];
    queuedBytes = inFlightBytes;
  }
  function fail(message) {
    clearPending();
    paused = true;
    if (!disposed) onError(tr("{0}；已停止发送并清除未发送输入，不会自动重试", { 0: message }));
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (running) return running;
    if (disposed || paused || !queue.length) return Promise.resolve();
    running = (async () => {
      while (!disposed && !paused && queue.length) {
        if (!canWrite()) { clearPending(); break; }
        const next = queue.shift();
        inFlightBytes = next.bytes;
        try {
          const result = await write({ sessionId, content: next.content });
          if (disposed) break;
          if (!result?.success || result.bytes !== next.bytes) throw new Error(result?.error || tr("终端写入结果无法确认"));
          onSent(next.content);
        } catch (error) {
          if (!disposed) fail(error.message || tr("终端写入失败"));
        } finally {
          queuedBytes = Math.max(0, queuedBytes - inFlightBytes);
          inFlightBytes = 0;
        }
      }
    })().finally(() => {
      running = null;
      if (!disposed && !paused && queue.length && !timer) timer = setTimeout(() => { void flush(); }, delayMs);
    });
    return running;
  }
  function enqueue(content) {
    if (disposed || paused || !canWrite()) return false;
    let size;
    try { size = terminalInputBytes(content); } catch (error) { fail(error.message); return false; }
    if (!size) return true;
    if (queuedBytes + size > MAX_TERMINAL_INPUT_BYTES) { fail(tr("终端发送队列已达到 64 KiB 上限")); return false; }
    // Each input event has independent UTF-8 replacement semantics; joining two
    // isolated surrogates must not silently create a different character.
    for (const piece of splitTerminalInput(content.toWellFormed())) {
      const bytes = terminalInputBytes(piece);
      const tail = queue.at(-1);
      if (tail && tail.bytes + bytes <= TERMINAL_BATCH_BYTES) { tail.content += piece; tail.bytes += bytes; }
      else queue.push({ content: piece, bytes });
    }
    queuedBytes += size;
    if (!running && !timer) timer = setTimeout(() => { void flush(); }, delayMs);
    return true;
  }
  return {
    enqueue, flush, clearPending, pause: fail,
    interrupt() { clearPending(); return enqueue('\x03'); },
    resume() { if (disposed || inFlightBytes) return false; clearPending(); paused = false; return true; },
    state() { return { queuedBytes, inFlight: Boolean(inFlightBytes), paused }; },
    dispose() { disposed = true; clearPending(); },
  };
}

function decodeRead(result, sessionId, offset) {
  if (!result?.success) throw new Error(result?.error || tr("终端输出读取失败"));
  if (result.sessionId !== sessionId) throw new Error(tr("串口会话已变化，请重新打开终端"));
  const { startOffset, endOffset, nextOffset, hex } = result;
  if (![startOffset, endOffset, nextOffset].every(value => Number.isSafeInteger(value) && value >= 0)
    || startOffset > endOffset || nextOffset < Math.max(offset, startOffset) || nextOffset > endOffset
    || typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)
    || hex.length / 2 !== nextOffset - Math.max(offset, startOffset) || hex.length > 128 * 1024) {
    throw new Error(tr("终端输出游标或数据无效，已暂停读取"));
  }
  const bytes = new Uint8Array(hex.length / 2);
  const digit = code => code <= 57 ? code - 48 : (code | 32) - 87;
  for (let index = 0; index < bytes.length; index++) bytes[index] = digit(hex.charCodeAt(index * 2)) * 16 + digit(hex.charCodeAt(index * 2 + 1));
  return bytes;
}

export function createSerialTerminalReader({ sessionId, read, write, onTruncated = () => {}, onError = () => {}, onReplayChange = () => {}, intervalMs = 100, schedule = setTimeout, cancel = clearTimeout }) {
  let offset = 0;
  let replayEnd = null;
  let replaying = true;
  let generation = 0;
  let active = false;
  let disposed = false;
  let running = false;
  let timer;

  async function poll() {
    if (!active || disposed || running) return;
    running = true;
    const requestedGeneration = generation;
    let backlog = false;
    try {
      const result = await read({ sessionId, offset });
      if (!active || disposed || requestedGeneration !== generation) return;
      const data = decodeRead(result, sessionId, offset);
      if (replayEnd === null) replayEnd = result.endOffset;
      if (result.truncated) onTruncated({ skippedBytes: Math.max(0, result.startOffset - offset), startOffset: result.startOffset });
      if (data.length) await write(data, replaying);
      if (disposed) return;
      offset = result.nextOffset;
      backlog = data.length > 0 && offset < result.endOffset;
      if (requestedGeneration === generation && replaying && offset >= replayEnd) { replaying = false; onReplayChange(false); }
    } catch (error) {
      if (!disposed && requestedGeneration === generation) { active = false; onError(error.message || tr("终端输出读取失败")); }
    } finally {
      running = false;
      // Each chunk still waits for xterm's write acknowledgement and yields a
      // task. Only an empty/caught-up stream waits for the idle polling interval.
      if (active && !disposed) timer = schedule(() => { void poll(); }, backlog ? 0 : intervalMs);
    }
  }
  return {
    start() {
      if (disposed || active) return;
      generation++;
      active = true;
      replayEnd = null;
      replaying = true;
      onReplayChange(true);
      cancel(timer);
      void poll();
    },
    pause() { generation++; active = false; cancel(timer); },
    state() { return { offset, replaying, active, running }; },
    dispose() { disposed = true; active = false; cancel(timer); },
  };
}
