const { StringDecoder } = require('node:string_decoder');

const MAX_ENTRIES = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const RX_MERGE_GAP_MS = 50;
const RX_MERGE_SPAN_MS = 1000;
const RX_MERGE_MAX_PARTS = 2;

function createSerialBuffer({ now = Date.now, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, mergeReceive = true } = {}) {
  const entryLimit = boundedLimit(maxEntries, MAX_ENTRIES);
  const byteLimit = boundedLimit(maxBytes, MAX_BYTES);
  const chunkLimit = Math.min(MAX_CHUNK_BYTES, byteLimit);
  const ring = new Array(entryLimit);
  const decoders = new Map();
  const dirtyIds = new Set();
  let head = 0;
  let count = 0;
  let retainedBytes = 0;
  let nextId = 1;
  let rxBytes = 0;
  let txBytes = 0;
  let evicted = 0;
  let receiveId = 0;

  function removeFirst() {
    const removed = ring[head];
    retainedBytes -= removed.bytes;
    dirtyIds.delete(removed.id);
    if (receiveId === removed.id) receiveId = 0;
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
    const time = now();
    if (direction !== 'RX') sealReceive();
    for (let offset = 0; offset < raw.length;) {
      const tail = count ? ring[(head + count - 1) % entryLimit] : null;
      const merge = canMerge(tail, sessionId, direction, time);
      const part = raw.subarray(offset, offset + (merge ? chunkLimit - tail.bytes : chunkLimit));
      while (count && ((!merge && count >= entryLimit) || retainedBytes + part.length > byteLimit)) removeFirst();
      const text = stream.decoder.write(part);
      const entry = merge ? {
        ...tail, bytes: tail.bytes + part.length, hex: tail.hex + part.toString('hex'),
        text: tail.text + text, parts: tail.parts + 1, endTime: time
      } : {
        id: nextId++, sessionId, path, config: { ...config }, direction, time, endTime: time,
        bytes: part.length, hex: part.toString('hex'), text, parts: 1
      };
      ring[(head + count - (merge ? 1 : 0)) % entryLimit] = entry;
      if (!merge) count++;
      retainedBytes += part.length;
      dirtyIds.add(entry.id);
      stream.lastId = entry.id;
      receiveId = direction === 'RX' ? entry.id : 0;
      offset += part.length;
    }
    if (direction === 'RX') rxBytes += raw.length;
    else txBytes += raw.length;
    return true;
  }

  function canMerge(tail, sessionId, direction, time) {
    return mergeReceive && direction === 'RX' && tail && receiveId === tail.id
      && tail.direction === 'RX' && tail.sessionId === sessionId && tail.bytes < chunkLimit
      && tail.parts < RX_MERGE_MAX_PARTS
      && time >= tail.endTime && time - tail.endTime <= RX_MERGE_GAP_MS
      && time >= tail.time && time - tail.time < RX_MERGE_SPAN_MS;
  }

  function sealReceive() {
    receiveId = 0;
  }

  function endSession(sessionId) {
    if (count && ring[(head + count - 1) % entryLimit].sessionId === sessionId) sealReceive();
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
        dirtyIds.add(ring[index].id);
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

  function drainChanges(reset = false) {
    const entries = [];
    for (let offset = 0; offset < count; offset++) {
      const entry = ring[(head + offset) % entryLimit];
      if (reset || dirtyIds.has(entry.id)) entries.push({ ...entry, config: { ...entry.config } });
    }
    dirtyIds.clear();
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
    dirtyIds.clear();
    sealReceive();
    head = 0;
    count = 0;
    retainedBytes = 0;
    rxBytes = 0;
    txBytes = 0;
    evicted = 0;
  }

  return { append, endSession, entriesAfter, drainChanges, sealReceive, metadata, clear };
}

function boundedLimit(value, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

module.exports = { createSerialBuffer, MAX_ENTRIES, MAX_BYTES, MAX_CHUNK_BYTES, RX_MERGE_GAP_MS, RX_MERGE_SPAN_MS, RX_MERGE_MAX_PARTS };
