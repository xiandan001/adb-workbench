const { performance } = require('node:perf_hooks');

const MAX_TRANSACTIONS = 200, RESPONSE_TIMEOUT_MS = 5000;
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
  const key = row => JSON.stringify([row.sessionId, row.opcode]);
  const pending = row => ['writing', 'waiting', 'reply-before-write'].includes(row.status);
  const mark = row => dirty.set(row.id, row);
  const stopTimer = row => { if (row.timer) clearTimer(row.timer); row.timer = null; };
  const ambiguous = row => { row.status = 'ambiguous'; uncertain.add(key(row)); stopTimer(row); mark(row); };
  function project(row) {
    return { id: row.id, sessionId: row.sessionId, commandId: row.commandId, valueKind: row.valueKind, opcode: row.opcode,
      status: row.status, writeState: row.writeState, requestAt: row.requestAt,
      txRecordId: row.txRecord?.id || 0, rxRecordId: row.rxRecord?.id || 0,
      ...(row.value !== undefined ? { value: row.value } : {}), ...(row.elapsedMs !== undefined ? { elapsedMs: row.elapsedMs } : {}) };
  }
  function begin({ sessionId, bytes, cursor, time }) {
    const contract = queryContract(bytes);
    if (disposed || !contract || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(cursor)) return null;
    const row = { id: ++sequence, sessionId, ...contract, cursor, requestAt: time, started: now(), status: 'writing', writeState: 'writing' };
    const peers = rows.filter(item => item.sessionId === sessionId && item.opcode === row.opcode && pending(item));
    rows.push(row); mark(row);
    if (peers.length || uncertain.has(key(row))) { peers.forEach(ambiguous); ambiguous(row); }
    else {
      row.timer = setTimer(() => {
        if (disposed || !pending(row) || row.rxRecord) return;
        row.status = 'timeout'; uncertain.add(key(row)); mark(row);
        try { onChange(); } catch { /* Observation cannot alter the original serial operation. */ }
      }, RESPONSE_TIMEOUT_MS); row.timer?.unref?.();
    }
    while (rows.length > MAX_TRANSACTIONS) { const removed = rows.shift(); if (pending(removed)) uncertain.add(key(removed)); stopTimer(removed); dirty.delete(removed.id); }
    return row.id;
  }
  function receive(entry) {
    const parsed = response(entry); if (disposed || !parsed) return;
    const candidates = rows.filter(row => row.sessionId === entry.sessionId && row.opcode === parsed.opcode && pending(row)
      && Number.isSafeInteger(entry._order) && entry._order >= row.cursor && now() - row.started <= RESPONSE_TIMEOUT_MS);
    if (candidates.length !== 1 || uncertain.has(JSON.stringify([entry.sessionId, parsed.opcode]))) { candidates.forEach(ambiguous); return; }
    const row = candidates[0]; row.rxRecord = entry; row.value = parsed.value;
    const elapsed = now() - row.started; if (elapsed >= 0) row.elapsedMs = Math.round(elapsed);
    row.status = row.writeState === 'written' ? 'matched' : 'reply-before-write'; stopTimer(row); mark(row);
  }
  function written(id, record, failed = false) {
    const row = rows.find(item => item.id === id); if (!row || disposed) return;
    row.writeState = failed ? 'failed' : 'written';
    if (failed) { row.status = 'write-failed'; uncertain.add(key(row)); stopTimer(row); }
    else {
      row.txRecord = record;
      if (row.status === 'writing') row.status = 'waiting';
      else if (row.status === 'reply-before-write') row.status = 'matched';
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
  const clear = () => { for (const row of rows) { if (pending(row)) uncertain.add(key(row)); stopTimer(row); } rows.length = 0; dirty.clear(); };
  return { begin, receive, written, endSession, metadata, snapshot, drainChanges, clear, dispose() { disposed = true; clear(); uncertain.clear(); } };
}
module.exports = { createSerialTransactions, MAX_TRANSACTIONS, RESPONSE_TIMEOUT_MS };
