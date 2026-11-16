export const LOG_VIEW_LIMIT = 50000;
export const LOG_VIEW_BYTES = 100 * 1024 * 1024;
const encoder = new TextEncoder(), rowSizes = new WeakMap(), boundedWindows = new WeakMap();

export function logRowByteLength(row) {
  const raw = typeof row?.raw === 'string' ? row.raw : '';
  if (!raw) return 0;
  const cached = rowSizes.get(row);
  if (cached?.raw === raw) return cached.bytes;
  const bytes = encoder.encode(raw).byteLength;
  rowSizes.set(row, { raw, bytes }); return bytes;
}

// Inputs are immutable log windows. Cache whole-window results and each row's UTF-8 size,
// so repeated display bursts never re-encode the retained 100 MiB of original text.
export function boundLogWindow(rows, { limit = LOG_VIEW_LIMIT, maxBytes = LOG_VIEW_BYTES } = {}) {
  const cached = boundedWindows.get(rows);
  if (cached?.limit === limit && cached.maxBytes === maxBytes) return cached.result;
  let bytes = 0; const tail = [];
  for (let index = rows.length - 1; index >= 0 && tail.length < limit; index--) {
    const row = rows[index], size = logRowByteLength(row);
    if (size > maxBytes) continue;
    if (bytes + size > maxBytes) break;
    tail.push(row); bytes += size;
  }
  const entries = tail.length === rows.length ? rows : tail.reverse();
  const result = { entries, bytes, omittedRows: rows.length - entries.length };
  boundedWindows.set(rows, { limit, maxBytes, result });
  if (entries !== rows) boundedWindows.set(entries, { limit, maxBytes, result: { entries, bytes, omittedRows: 0 } });
  return result;
}

export function appendLogWindow(previous, incoming, limit = LOG_VIEW_LIMIT, maxBytes = LOG_VIEW_BYTES) {
  return boundLogWindow(incoming.length ? previous.concat(incoming) : previous, { limit, maxBytes }).entries;
}

// Retain bounded chunks until the next display update instead of copying the full view per IPC.
export function createLogBatchBuffer(onFlush, {
  limit = LOG_VIEW_LIMIT, maxBytes = LOG_VIEW_BYTES, interval = 100, schedule = setTimeout, cancel = clearTimeout
} = {}) {
  let chunks = [];
  let head = 0, count = 0, bytes = 0;
  let truncated = false;
  let timer = null;

  function reset() {
    if (timer !== null) cancel(timer);
    timer = null;
    chunks = [];
    head = 0; count = 0; bytes = 0;
    truncated = false;
  }

  function flush() {
    const batch = { entries: chunks.slice(head).flatMap(chunk => chunk.entries.slice(chunk.start)), truncated };
    reset();
    if (batch.entries.length || batch.truncated) onFlush(batch);
  }

  function push(payload) {
    const entries = Array.isArray(payload) ? payload : payload?.entries;
    if (!Array.isArray(entries)) return;
    truncated ||= payload?.truncated === true;
    if (entries.length) {
      let incomingChunk;
      for (const entry of entries) {
        const size = logRowByteLength(entry);
        if (size > maxBytes || limit <= 0) { truncated = true; continue; }
        if (!incomingChunk) { incomingChunk = { entries: [], start: 0 }; chunks.push(incomingChunk); }
        incomingChunk.entries.push(entry); count++; bytes += size;
        while (count > limit || bytes > maxBytes) {
          const chunk = chunks[head], removed = chunk.entries[chunk.start];
          bytes -= logRowByteLength(removed); count--; truncated = true;
          chunk.entries[chunk.start++] = null; // Release evicted raw text before the delayed flush.
          if (chunk.start === chunk.entries.length) chunks[head++] = null;
          else if (chunk.start > 1024 && chunk.start * 2 > chunk.entries.length) { chunk.entries = chunk.entries.slice(chunk.start); chunk.start = 0; }
        }
      }
      if (head > 64 && head * 2 > chunks.length) { chunks = chunks.slice(head); head = 0; }
    }
    if (timer === null && (count || truncated)) timer = schedule(flush, interval);
  }

  return { push, flush, reset, get pendingBytes() { return bytes; }, get pendingCount() { return count; } };
}
