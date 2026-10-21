// Count- and byte-bounded rolling storage. Eviction never shifts the retained log array.
function createLogCaptureBuffer({ maxEntries, maxBytes, sizeOf = entry => Buffer.byteLength(entry?.raw || '', 'utf8') }) {
  let entries = new Array(maxEntries);
  let sizes = new Array(maxEntries);
  let start = 0;
  let length = 0;
  let bytes = 0;
  let truncated = false;
  let snapshot = null;

  function push(entry) {
    const size = sizeOf(entry);
    while (length && (length === maxEntries || bytes + size > maxBytes)) {
      bytes -= sizes[start];
      entries[start] = undefined;
      sizes[start] = undefined;
      start = (start + 1) % maxEntries;
      length -= 1;
      truncated = true;
    }
    snapshot = null;
    if (size > maxBytes) {
      truncated = true;
      return -1;
    }
    const index = (start + length) % maxEntries;
    entries[index] = entry;
    sizes[index] = size;
    length += 1;
    bytes += size;
    return length - 1;
  }

  function clear() {
    entries = new Array(maxEntries);
    sizes = new Array(maxEntries);
    start = 0;
    length = 0;
    bytes = 0;
    truncated = false;
    snapshot = null;
  }

  function toArray() {
    if (snapshot) return snapshot;
    snapshot = new Array(length);
    for (let index = 0; index < length; index += 1) {
      snapshot[index] = entries[(start + index) % maxEntries];
    }
    return snapshot;
  }

  return {
    push, clear, toArray,
    get length() { return length; },
    get bytes() { return bytes; },
    get truncated() { return truncated; }
  };
}

module.exports = { createLogCaptureBuffer };
