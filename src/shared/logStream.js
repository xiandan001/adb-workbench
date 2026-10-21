export const LOG_VIEW_LIMIT = 50000;

export function appendLogWindow(previous, incoming, limit = LOG_VIEW_LIMIT) {
  if (!incoming.length) return previous;
  if (incoming.length >= limit) return incoming.slice(-limit);
  return previous.slice(Math.max(0, previous.length + incoming.length - limit)).concat(incoming);
}

// Retain bounded chunks until the next display update instead of copying the full view per IPC.
export function createLogBatchBuffer(onFlush, {
  limit = LOG_VIEW_LIMIT, interval = 100, schedule = setTimeout, cancel = clearTimeout
} = {}) {
  let chunks = [];
  let count = 0;
  let truncated = false;
  let timer = null;

  function reset() {
    if (timer !== null) cancel(timer);
    timer = null;
    chunks = [];
    count = 0;
    truncated = false;
  }

  function flush() {
    const batch = { entries: chunks.flat(), truncated };
    reset();
    if (batch.entries.length || batch.truncated) onFlush(batch);
  }

  function push(payload) {
    const entries = Array.isArray(payload) ? payload : payload?.entries;
    if (!Array.isArray(entries)) return;
    truncated ||= payload?.truncated === true;
    if (entries.length) {
      chunks.push(entries.length > limit ? entries.slice(-limit) : entries);
      count += Math.min(entries.length, limit);
      truncated ||= entries.length > limit || count > limit;
      while (count > limit) {
        const remove = Math.min(chunks[0].length, count - limit);
        if (remove === chunks[0].length) chunks.shift();
        else chunks[0] = chunks[0].slice(remove);
        count -= remove;
      }
    }
    if (timer === null && (count || truncated)) timer = schedule(flush, interval);
  }

  return { push, flush, reset };
}
