const { StringDecoder } = require('node:string_decoder');

const MAX_ENTRIES = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;

function createSerialBuffer({ now = Date.now, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const entryLimit = boundedLimit(maxEntries, MAX_ENTRIES);
  const byteLimit = boundedLimit(maxBytes, MAX_BYTES);
  const chunkLimit = Math.min(MAX_CHUNK_BYTES, byteLimit);
  const ring = new Array(entryLimit);
  const decoders = new Map();
  let head = 0;
  let count = 0;
  let retainedBytes = 0;
  let nextId = 1;
  let rxBytes = 0;
  let txBytes = 0;
  let evicted = 0;

  function removeFirst() {
    retainedBytes -= ring[head].bytes;
    ring[head] = undefined;
    head = (head + 1) % entryLimit;
    count--;
    evicted++;
  }

  function decoderFor(sessionId, direction) {
    if (!decoders.has(sessionId)) decoders.set(sessionId, {});
    const session = decoders.get(sessionId);
    if (!session[direction]) session[direction] = { decoder: new StringDecoder('utf8'), lastId: 0 };
    return session[direction];
  }

  function append({ sessionId, path, config, direction, bytes }) {
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!raw.length) return false;
    const stream = decoderFor(sessionId, direction);
    for (let offset = 0; offset < raw.length; offset += chunkLimit) {
      const part = raw.subarray(offset, offset + chunkLimit);
      while (count && (count >= entryLimit || retainedBytes + part.length > byteLimit)) removeFirst();
      const entry = {
        id: nextId++, sessionId, path, config: { ...config }, direction, time: now(),
        bytes: part.length, hex: part.toString('hex'), text: stream.decoder.write(part)
      };
      ring[(head + count) % entryLimit] = entry;
      count++;
      retainedBytes += part.length;
      stream.lastId = entry.id;
    }
    if (direction === 'RX') rxBytes += raw.length;
    else txBytes += raw.length;
    return true;
  }

  function endSession(sessionId) {
    const session = decoders.get(sessionId);
    if (!session) return false;
    let changed = false;
    for (const stream of Object.values(session)) {
      const tail = stream.decoder.end();
      if (!tail) continue;
      // Amend the original byte-bearing row, rather than fabricating received bytes.
      for (let offset = count - 1; offset >= 0; offset--) {
        const index = (head + offset) % entryLimit;
        if (ring[index].id !== stream.lastId) continue;
        ring[index] = { ...ring[index], text: ring[index].text + tail };
        changed = true;
        break;
      }
    }
    decoders.delete(sessionId);
    return changed;
  }

  function entriesAfter(id = 0) {
    const entries = [];
    for (let offset = 0; offset < count; offset++) {
      const entry = ring[(head + offset) % entryLimit];
      if (entry.id > id) entries.push({ ...entry, config: { ...entry.config } });
    }
    return entries;
  }

  function metadata() {
    return {
      rxBytes, txBytes, evicted,
      firstId: count ? ring[head].id : 0,
      lastId: count ? ring[(head + count - 1) % entryLimit].id : 0
    };
  }

  function clear() {
    ring.fill(undefined);
    decoders.clear();
    head = 0;
    count = 0;
    retainedBytes = 0;
    rxBytes = 0;
    txBytes = 0;
    evicted = 0;
  }

  return { append, endSession, entriesAfter, metadata, clear, cursor: () => nextId - 1 };
}

function boundedLimit(value, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

module.exports = { createSerialBuffer, MAX_ENTRIES, MAX_BYTES, MAX_CHUNK_BYTES };
