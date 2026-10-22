const { StringDecoder } = require('node:string_decoder');
const { splitSerialResponses } = require('./serial-response-framer.cjs');

const MAX_ENTRIES = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const RX_MERGE_GAP_MS = 50;
const RX_MERGE_SPAN_MS = 1000;
const RX_MERGE_MAX_PARTS = 2;
const RX_PENDING_IDLE_MS = 500;

function createSerialBuffer({ now = Date.now, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, mergeReceive = true } = {}) {
  const entryLimit = boundedLimit(maxEntries, MAX_ENTRIES);
  const byteLimit = boundedLimit(maxBytes, MAX_BYTES);
  const chunkLimit = Math.min(MAX_CHUNK_BYTES, byteLimit);
  const decoders = new Map();
  const dirtyIds = new Set();
  let rows = [];
  let head = 0;
  let retainedBytes = 0;
  let nextId = 1;
  let nextPart = 1;
  let nextOrder = 1;
  let rxBytes = 0;
  let txBytes = 0;
  let evicted = 0;
  let receiveId = 0;
  let pending = null;
  let resetNeeded = false;

  function decoderFor(sessionId, direction) {
    if (!decoders.has(sessionId)) decoders.set(sessionId, {});
    const session = decoders.get(sessionId);
    if (!session[direction]) session[direction] = { decoder: new StringDecoder('utf8'), lastId: 0 };
    return session[direction];
  }

  function trim() {
    while (rows.length - head > entryLimit || retainedBytes > byteLimit) {
      const removed = rows[head];
      retainedBytes -= removed.bytes;
      dirtyIds.delete(removed.id);
      if (receiveId === removed.id) receiveId = 0;
      if (pending?.entry === removed) pending = null;
      rows[head++] = undefined;
      evicted++;
    }
    if (head > 1024 && head * 2 > rows.length) { rows = rows.slice(head); head = 0; }
  }

  function put(entry, replacement) {
    if (replacement?.id) {
      entry.id = replacement.id;
      rows.splice(replacement.index, 0, entry);
      replacement.id = 0;
    } else {
      entry.id = nextId++;
      rows.push(entry);
    }
    retainedBytes += entry.bytes;
    dirtyIds.add(entry.id);
    return entry;
  }

  function sourceSlices(bytes, offset, old, source) {
    const slices = [];
    let consumed = 0;
    while (old && offset + consumed < old.bytes.length && consumed < bytes.length) {
      const first = old.tokens[offset + consumed];
      let end = consumed + 1;
      while (offset + end < old.bytes.length && end < bytes.length && old.tokens[offset + end].part === first.part) end++;
      slices.push({ bytes: bytes.subarray(consumed, end), tokens: old.tokens.slice(offset + consumed, offset + end), ...first });
      consumed = end;
    }
    if (consumed < bytes.length) {
      slices.push({ bytes: bytes.subarray(consumed), part: source.part, time: source.time,
        order: source.order + offset + consumed - (old?.bytes.length || 0) });
    }
    return slices;
  }

  function canMergeRaw(tail, context, slice) {
    return mergeReceive && context.direction === 'RX' && tail?.kind === 'raw' && receiveId === tail.id
      && tail.direction === 'RX' && tail.sessionId === context.sessionId && tail.bytes < chunkLimit
      && (tail._lastPart === slice.part || tail.parts < RX_MERGE_MAX_PARTS)
      && tail._endOrder + 1 === slice.order && slice.time >= tail.endTime
      && slice.time - tail.endTime <= RX_MERGE_GAP_MS && slice.time - tail.time < RX_MERGE_SPAN_MS;
  }

  function appendRaw(slice, context, stream, replacement) {
    for (let offset = 0; offset < slice.bytes.length;) {
      const tail = rows.at(-1);
      const position = { ...slice, order: slice.order + offset };
      const merge = !replacement?.id && canMergeRaw(tail, context, position);
      const bytes = slice.bytes.subarray(offset, offset + (merge ? chunkLimit - tail.bytes : chunkLimit));
      const text = slice.tokens ? slice.tokens.slice(offset, offset + bytes.length).map(token => token.text).join('') : stream.decoder.write(bytes);
      let entry;
      if (merge) {
        entry = { ...tail, bytes: tail.bytes + bytes.length, hex: tail.hex + bytes.toString('hex'), text: tail.text + text,
          parts: tail.parts + (tail._lastPart === slice.part ? 0 : 1), endTime: slice.time,
          _lastPart: slice.part, _endOrder: position.order + bytes.length - 1 };
        rows[rows.length - 1] = entry;
        retainedBytes += bytes.length;
        dirtyIds.add(entry.id);
      } else {
        entry = put({ ...context, config: { ...context.config }, kind: 'raw', time: slice.time, endTime: slice.time,
          bytes: bytes.length, hex: bytes.toString('hex'), text, parts: 1,
          _lastPart: slice.part, _order: position.order, _endOrder: position.order + bytes.length - 1 }, replacement);
      }
      receiveId = context.direction === 'RX' ? entry.id : 0;
      stream.lastId = entry.id;
      offset += bytes.length;
    }
  }

  function appendFramed(segment, slices, context, stream, replacement) {
    sealRawReceive();
    const tokens = [];
    let text = '';
    for (const slice of slices) {
      if (slice.tokens) {
        text += slice.tokens.map(token => token.text).join('');
        if (segment.kind === 'pending') tokens.push(...slice.tokens);
      } else if (segment.kind === 'pending') {
        for (let index = 0; index < slice.bytes.length; index++) {
          const decoded = stream.decoder.write(slice.bytes.subarray(index, index + 1));
          text += decoded;
          tokens.push({ text: decoded, part: slice.part, time: slice.time, order: slice.order + index });
        }
      } else text += stream.decoder.write(slice.bytes);
    }
    const first = slices[0];
    const last = slices.at(-1);
    const entry = put({ ...context, config: { ...context.config }, kind: segment.kind, protocol: segment.protocol,
      time: first.time, endTime: last.time, bytes: segment.bytes.length, hex: segment.bytes.toString('hex'), text,
      parts: new Set(slices.map(slice => slice.part)).size, _lastPart: last.part,
      _order: first.order, _endOrder: last.order + last.bytes.length - 1 }, replacement);
    stream.lastId = entry.id;
    if (segment.kind === 'pending') pending = { entry, bytes: Buffer.from(segment.bytes), tokens };
  }

  function repairOrder() {
    let needsRepair = false;
    for (let index = head + 1; index < rows.length; index++) {
      if (rows[index - 1]._order > rows[index]._order || rows[index - 1].id + 1 !== rows[index].id) { needsRepair = true; break; }
    }
    if (!needsRepair) return;
    rows = rows.slice(head).sort((a, b) => a._order - b._order);
    head = 0;
    const ids = new Map();
    for (const row of rows) { const oldId = row.id; row.id = nextId++; ids.set(oldId, row.id); }
    for (const session of decoders.values()) for (const stream of Object.values(session)) stream.lastId = ids.get(stream.lastId) || 0;
    receiveId = ids.get(receiveId) || 0;
    dirtyIds.clear();
    for (const row of rows) dirtyIds.add(row.id);
    resetNeeded = true;
  }

  function processResponses(bytes, context, source, final = false) {
    const old = pending;
    let replacement;
    let mayReorder = false;
    if (old) {
      const index = rows.indexOf(old.entry, head);
      if (index < 0) throw new Error('串口待接收记录状态无效');
      mayReorder = index !== rows.length - 1;
      replacement = { id: old.entry.id, index };
      rows.splice(index, 1);
      retainedBytes -= old.entry.bytes;
      dirtyIds.delete(old.entry.id);
      pending = null;
      sealRawReceive();
    }
    const combined = old ? Buffer.concat([old.bytes, bytes]) : bytes;
    const stream = decoderFor(context.sessionId, 'RX');
    const segments = splitSerialResponses(combined, { final }).flatMap(segment =>
      segment.kind === 'pending' && segment.bytes.length > chunkLimit ? splitSerialResponses(segment.bytes, { final: true }) : [segment]);
    let offset = 0;
    for (const segment of segments) {
      const slices = sourceSlices(segment.bytes, offset, old, source);
      if (segment.kind === 'raw' || segment.bytes.length > chunkLimit) {
        for (const slice of slices) appendRaw(slice, context, stream, replacement);
      } else appendFramed(segment, slices, context, stream, replacement);
      offset += segment.bytes.length;
    }
    if (mayReorder) repairOrder();
    trim();
  }

  function append({ sessionId, path, config, direction, bytes }) {
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!raw.length) return false;
    const time = now();
    const context = { sessionId, path, config, direction };
    const source = { time, part: nextPart++, order: nextOrder };
    nextOrder += raw.length;
    if (direction === 'RX' && mergeReceive) {
      if (pending && (pending.entry.sessionId !== sessionId || time - pending.entry.endTime >= RX_PENDING_IDLE_MS)) sealReceive();
      for (let offset = 0; offset < raw.length; offset += MAX_CHUNK_BYTES) {
        processResponses(raw.subarray(offset, offset + MAX_CHUNK_BYTES), context, { ...source, order: source.order + offset });
      }
    } else {
      sealRawReceive();
      for (let offset = 0; offset < raw.length; offset += MAX_CHUNK_BYTES) {
        appendRaw({ bytes: raw.subarray(offset, offset + MAX_CHUNK_BYTES), ...source, order: source.order + offset }, context, decoderFor(sessionId, direction));
        trim();
      }
    }
    if (direction === 'RX') rxBytes += raw.length;
    else txBytes += raw.length;
    return true;
  }

  function sealRawReceive() { receiveId = 0; }

  function sealReceive() {
    sealRawReceive();
    if (!pending) return false;
    const { sessionId, path, config } = pending.entry;
    processResponses(Buffer.alloc(0), { sessionId, path, config, direction: 'RX' }, null, true);
    sealRawReceive();
    return true;
  }

  function endSession(sessionId) {
    let changed = pending?.entry.sessionId === sessionId ? sealReceive() : false;
    sealRawReceive();
    const session = decoders.get(sessionId);
    if (!session) return changed;
    for (const stream of Object.values(session)) {
      const tail = stream.decoder.end();
      if (!tail) continue;
      const row = rows.find(entry => entry?.id === stream.lastId);
      if (row) { row.text += tail; dirtyIds.add(row.id); changed = true; }
    }
    decoders.delete(sessionId);
    return changed;
  }

  function clone(entry) {
    const { _lastPart, _order, _endOrder, ...publicEntry } = entry;
    return { ...publicEntry, config: { ...entry.config } };
  }

  function entriesAfter(id = 0) { return rows.slice(head).filter(entry => entry.id > id).map(clone); }

  function drainChanges(reset = false) {
    const entries = rows.slice(head).filter(entry => reset || dirtyIds.has(entry.id)).map(clone);
    dirtyIds.clear();
    return entries;
  }

  function consumeReset() { const needed = resetNeeded; resetNeeded = false; return needed; }
  function hasPendingReceive() { return !!pending; }

  function metadata() {
    return { rxBytes, txBytes, evicted, firstId: rows[head]?.id || 0, lastId: rows.at(-1)?.id || 0 };
  }

  function clear() {
    rows = []; head = 0; retainedBytes = 0; rxBytes = 0; txBytes = 0; evicted = 0;
    pending = null; resetNeeded = false; decoders.clear(); dirtyIds.clear(); sealRawReceive();
  }

  return { append, endSession, entriesAfter, drainChanges, consumeReset, hasPendingReceive,
    sealReceive, sealRawReceive, metadata, clear };
}

function boundedLimit(value, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

module.exports = { createSerialBuffer, MAX_ENTRIES, MAX_BYTES, MAX_CHUNK_BYTES,
  RX_MERGE_GAP_MS, RX_MERGE_SPAN_MS, RX_MERGE_MAX_PARTS, RX_PENDING_IDLE_MS };
