const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerialBuffer, MAX_BYTES, MAX_ENTRIES } = require('../electron/lib/serial-buffer.cjs');

const config = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const record = (bytes, extra = {}) => ({ bytes, sessionId: 'session-A', path: 'COM2', config, direction: 'RX', ...extra });

test('dirty rows are bounded upserts; snapshots do not consume changes or expose mutable rows', () => {
  let clock = 100;
  const buffer = createSerialBuffer({ now: () => clock });
  buffer.append(record(Buffer.from('A')));
  const snapshot = buffer.entriesAfter();
  const first = buffer.drainChanges();
  assert.equal(first.length, 1);
  assert.deepEqual(buffer.drainChanges(), []);
  clock++;
  buffer.append(record(Buffer.from('B')));
  assert.equal(snapshot[0].text, 'A');
  assert.equal(first[0].text, 'A');
  buffer.entriesAfter();
  const update = buffer.drainChanges();
  assert.equal(update[0].id, first[0].id);
  assert.equal(update[0].text, 'AB');
  update[0].config.baudRate = 1;
  assert.equal(buffer.entriesAfter()[0].config.baudRate, 9600);
});

test('all RX bytes are retained or counted as evicted during a sustained multi-megabyte stream', () => {
  let clock = 100;
  const buffer = createSerialBuffer({ now: () => clock });
  const part = Buffer.alloc(1024, 0x61);
  for (let index = 0; index < 5000; index++) {
    buffer.append(record(part));
    clock++;
  }
  const rows = buffer.entriesAfter();
  assert.ok(rows.length <= MAX_ENTRIES);
  assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= MAX_BYTES);
  assert.ok(rows.every(row => row.bytes <= 16384));
  assert.equal(buffer.metadata().rxBytes, 5000 * part.length);
  assert.equal(buffer.metadata().evicted, rows[0].id - 1);
  assert.ok(buffer.drainChanges().length <= rows.length);
  assert.deepEqual(buffer.drainChanges(), []);
  assert.equal(rows.at(-1).hex, '61'.repeat(8192));
});

test('TX calls never merge and empty RX callbacks cannot extend a grouping interval', () => {
  let clock = 100;
  const buffer = createSerialBuffer({ now: () => clock });
  buffer.append(record(Buffer.from('T'), { direction: 'TX' }));
  buffer.append(record(Buffer.from('U'), { direction: 'TX' }));
  buffer.append(record(Buffer.from('A')));
  clock = 149;
  assert.equal(buffer.append(record(Buffer.alloc(0))), false);
  clock = 151;
  buffer.append(record(Buffer.from('B')));
  assert.deepEqual(buffer.entriesAfter().map(row => row.text), ['T', 'U', 'A', 'B']);
  assert.deepEqual(buffer.entriesAfter().map(row => row.parts), [1, 1, 1, 1]);
  assert.equal(buffer.metadata().rxBytes, 2);
  assert.equal(buffer.metadata().txBytes, 2);
});

test('decoder finalization modifies dirty evidence without adding bytes or parts', () => {
  const buffer = createSerialBuffer({ now: () => 100 });
  buffer.append(record(Buffer.from([0xe4])));
  const first = buffer.drainChanges()[0];
  assert.equal(first.text, '');
  assert.equal(buffer.endSession('session-A'), true);
  const update = buffer.drainChanges()[0];
  assert.equal(update.id, first.id);
  assert.equal(update.text, '�');
  assert.equal(update.hex, 'e4');
  assert.equal(update.parts, 1);
  assert.equal(buffer.metadata().rxBytes, 1);
});

test('deterministic mixed traffic preserves byte suffixes, counts, limits and replayable upserts', () => {
  let clock = 100;
  const buffer = createSerialBuffer({ now: () => clock, maxEntries: 7, maxBytes: 1000 });
  let allHex = '';
  let rxBytes = 0;
  let txBytes = 0;
  let seed = 97;
  const replay = new Map();
  for (let index = 0; index < 3000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = seed % 257 + 1;
    const bytes = Buffer.alloc(length, seed & 255);
    const direction = index % 17 === 0 ? 'TX' : 'RX';
    const sessionId = `session-${Math.floor(index / 127)}`;
    clock += index % 9 === 0 ? 51 : 3;
    if (index % 11 === 0) buffer.sealReceive();
    buffer.append(record(bytes, { direction, sessionId }));
    allHex += bytes.toString('hex');
    if (direction === 'RX') rxBytes += length;
    else txBytes += length;
    if (index % 37 !== 0 && index !== 2999) continue;
    const metadata = buffer.metadata();
    const rows = buffer.entriesAfter();
    for (const row of buffer.drainChanges()) replay.set(row.id, row);
    for (const id of replay.keys()) if (id < metadata.firstId) replay.delete(id);
    assert.deepEqual([...replay.values()].sort((a, b) => a.id - b.id), rows);
    assert.ok(rows.length <= 7);
    assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= 1000);
    assert.ok(allHex.endsWith(rows.map(row => row.hex).join('')));
    assert.equal(metadata.rxBytes, rxBytes);
    assert.equal(metadata.txBytes, txBytes);
    assert.ok(rows.every(row => row.bytes * 2 === row.hex.length && row.endTime - row.time < 1000));
  }
});
