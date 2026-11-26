const { performance } = require('node:perf_hooks');
const { tclRequestContract, tclResponse, matchTclResult } = require('./serial-tcl-transactions.cjs');

const MAX_TRANSACTIONS = 200, RESPONSE_TIMEOUT_MS = 5000;
const TCL_AFTER_ACK_TIMEOUT_MS = 500;
const contracts = new Map([[0x08, { commandId: 'lango-005', valueKind: 'power' }], [0x03, { commandId: 'lango-043', valueKind: 'volume' }], [0x12, { commandId: 'lango-040', valueKind: 'mute' }]]);
function queryContract(bytes) {
  if (!bytes || bytes.length !== 11 || bytes[0] !== 0xfe || bytes[1] !== 8 || bytes[8] !== 2 || bytes[10] !== 0xcf
    || [0x58, 0x42, 0x48, 0x43, 0x4d, 0x44].some((byte, index) => bytes[index + 2] !== byte)) return null;
  return contracts.has(bytes[9]) ? { opcode: bytes[9], ...contracts.get(bytes[9]) } : null;
}
function response(entry) {
  if (entry.direction !== 'RX' || entry.kind !== 'frame' || entry.protocol !== 'xbh' || typeof entry.hex !== 'string'
    || !/^fe09584248434d4402[0-9a-f]{4}cf$/i.test(entry.hex)) return null;
  const opcode = parseInt(entry.hex.slice(18, 20), 16);
  return contracts.has(opcode) ? { opcode, value: parseInt(entry.hex.slice(20, 22), 16) } : null;
}
function createSerialTransactions({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  const rows = [], dirty = new Map(), uncertain = new Set(); let sequence = 0, disposed = false;
  // TCL's ACK and completion codes carry no request id or opcode.
  const key = row => JSON.stringify([row.sessionId, row.protocol === 'tcl' ? 'tcl' : row.opcode]);
  const pending = row => ['writing', 'waiting', 'reply-before-write', 'accepted'].includes(row.status);
  const mark = row => dirty.set(row.id, row);
  const stopTimer = row => { if (row.timer) clearTimer(row.timer); row.timer = null; };
  const ambiguous = row => { row.status = 'ambiguous'; uncertain.add(row.matchKey); stopTimer(row); mark(row); };
  function waitFor(row, duration) {
    stopTimer(row);
    row.deadline = now() + duration;
    const timer = setTimer(() => {
      if (disposed || row.timer !== timer || !pending(row) || row.rxRecord) return;
      row.status = 'timeout'; uncertain.add(row.matchKey); mark(row);
      try { onChange(); } catch { /* Observation cannot alter the original serial operation. */ }
    }, duration);
    row.timer = timer;
    timer?.unref?.();
  }
  function project(row) {
    return { id: row.id, sessionId: row.sessionId, commandId: row.commandId, valueKind: row.valueKind, opcode: row.opcode,
      status: row.status, writeState: row.writeState, requestAt: row.requestAt,
      txRecordId: row.txRecord?.id || 0, rxRecordId: row.rxRecord?.id || 0,
      ...(row.protocol === 'tcl' ? { protocol: 'tcl', ackRecordId: row.ackRecord?.id || 0,
        completionRecordId: row.completionRecord?.id || 0, ...(row.result ? { resultBytes: row.result.bytes,
          resultPreview: row.result.preview } : {}) } : {}),
      ...(row.value !== undefined ? { value: row.value } : {}), ...(row.elapsedMs !== undefined ? { elapsedMs: row.elapsedMs } : {}) };
  }
  function begin({ sessionId, bytes, cursor, time }) {
    if (disposed || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(cursor)) return null;
    const contract = queryContract(bytes) || tclRequestContract(bytes);
    if (!contract?.commandId) {
      const peers = rows.filter(item => item.sessionId === sessionId && item.protocol === 'tcl' && pending(item));
      if (peers.length || bytes?.[0] === 0xaa) {
        peers.forEach(ambiguous);
        uncertain.add(key({ sessionId, protocol: 'tcl' }));
      }
      return null;
    }
    const row = { id: ++sequence, sessionId, ...contract, cursor, requestAt: time, started: now(), status: 'writing', writeState: 'writing' };
    row.matchKey = key(row);
    const peers = rows.filter(item => item.matchKey === row.matchKey && pending(item));
    rows.push(row); mark(row);
    if (peers.length || uncertain.has(row.matchKey)) { peers.forEach(ambiguous); ambiguous(row); }
    else waitFor(row, RESPONSE_TIMEOUT_MS);
    while (rows.length > MAX_TRANSACTIONS) { const removed = rows.shift(); if (pending(removed)) uncertain.add(removed.matchKey); stopTimer(removed); dirty.delete(removed.id); }
    return row.id;
  }
  function finishReply(row, entry, status) {
    row.rxRecord = entry;
    const elapsed = now() - row.started; if (elapsed >= 0) row.elapsedMs = Math.round(elapsed);
    row.completedStatus = status;
    row.status = row.writeState === 'written' ? status : 'reply-before-write'; stopTimer(row); mark(row);
  }
  function receiveTcl(row, entry, parsed) {
    if (parsed.control === 'ack') {
      if (row.ackRecord) { ambiguous(row); return; }
      row.ackRecord = entry;
      row.status = 'accepted';
      waitFor(row, row.response?.offset === 4 ? RESPONSE_TIMEOUT_MS : TCL_AFTER_ACK_TIMEOUT_MS);
      mark(row);
    } else if (parsed.control === 'rejected' || parsed.control === 'transport-error') {
      uncertain.add(row.matchKey);
      finishReply(row, entry, parsed.control);
    } else if (row.ackRecord && parsed.control === 'completion') {
      if (row.completionRecord) { ambiguous(row); return; }
      row.completionRecord = entry;
      if (!row.response) finishReply(row, entry, 'completed');
      else mark(row); // A query is not complete until the expected results arrive.
    } else if (row.ackRecord) {
      const result = matchTclResult(row.response, parsed.bytes);
      if (result) { row.result = result; finishReply(row, entry, 'result'); }
    }
  }
  function receive(entry) {
    if (disposed || !Number.isSafeInteger(entry._order)) return;
    const parsed = response(entry) || tclResponse(entry);
    if (!parsed) return;
    const responseKey = key(parsed.opcode === undefined ? { sessionId: entry.sessionId, protocol: 'tcl' } : { sessionId: entry.sessionId, opcode: parsed.opcode });
    const received = now();
    const candidates = rows.filter(row => row.matchKey === responseKey && pending(row) && !row.rxRecord &&
      entry._order >= row.cursor && received <= row.deadline);
    if (candidates.length !== 1 || uncertain.has(responseKey)) { candidates.forEach(ambiguous); return; }
    const row = candidates[0];
    if (row.protocol === 'tcl') receiveTcl(row, entry, parsed);
    else { row.value = parsed.value; finishReply(row, entry, 'matched'); }
  }
  function written(id, record, failed = false) {
    const row = rows.find(item => item.id === id); if (!row || disposed) return;
    row.writeState = failed ? 'failed' : 'written';
    if (failed) { row.status = 'write-failed'; uncertain.add(row.matchKey); stopTimer(row); }
    else {
      row.txRecord = record;
      if (row.status === 'writing') row.status = 'waiting';
      else if (row.status === 'reply-before-write') row.status = row.completedStatus;
    }
    mark(row);
  }
  function endSession(sessionId) {
    for (const row of rows) if (row.sessionId === sessionId && pending(row)) { row.status = 'session-ended'; stopTimer(row); mark(row); }
    for (const item of uncertain) if (JSON.parse(item)[0] === sessionId) uncertain.delete(item);
  }
  const metadata = () => ({ firstTransactionId: rows[0]?.id || 0, lastTransactionId: rows.at(-1)?.id || 0 });
  const snapshot = () => rows.map(project);
  const drainChanges = (reset = false) => { const output = reset ? snapshot() : [...dirty.values()].sort((a, b) => a.id - b.id).map(project); dirty.clear(); return output; };
  const clear = () => { for (const row of rows) { if (pending(row)) uncertain.add(row.matchKey); stopTimer(row); } rows.length = 0; dirty.clear(); };
  return { begin, receive, written, endSession, metadata, snapshot, drainChanges, clear, dispose() { disposed = true; clear(); uncertain.clear(); } };
}
module.exports = { createSerialTransactions, MAX_TRANSACTIONS, RESPONSE_TIMEOUT_MS };
