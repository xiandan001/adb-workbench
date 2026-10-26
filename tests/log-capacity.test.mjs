import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { applySerialDelta, applySerialSnapshot, emptySerialSnapshot, SERIAL_VIEW_LIMIT } from '../src/shared/serialWorkspace.js';
import { appendLogWindow, LOG_VIEW_LIMIT } from '../src/shared/logStream.js';
import { createSerialTerminalReader } from '../src/shared/serialTerminalTransport.js';

const require = createRequire(import.meta.url);
const { createSerialBuffer, MAX_ENTRIES, MAX_BYTES } = require('../electron/lib/serial-buffer.cjs');
const { createSerialTerminalBuffer } = require('../electron/lib/serial-terminal-buffer.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({ id, bytes: 2, hex: '410a', text: 'A\n' });

test('serial records retain 10,000 ordinary 500-byte entries independently of the 50k device log limit', () => {
  assert.equal(MAX_ENTRIES, SERIAL_VIEW_LIMIT); assert.equal(MAX_ENTRIES, 10000); assert.equal(LOG_VIEW_LIMIT, 50000); assert.equal(MAX_BYTES, 64 * 1024 * 1024);
  const buffer = createSerialBuffer({ mergeReceive: false });
  const input = { sessionId: 'capacity-fixture', path: 'synthetic-port', config: { baudRate: 115200 }, direction: 'RX', bytes: Buffer.alloc(500, 0x61) };
  for (let index = 0; index < 10000; index++) buffer.append(input);
  let state = applySerialSnapshot(emptySerialSnapshot(), { revision: 1, ...buffer.metadata(), entries: buffer.drainChanges(true) });
  assert.equal(state.entries.length, 10000); assert.equal(state.needsSnapshot, false); assert.equal(state.evicted, 0);
  assert.equal(state.rxBytes, 5000000); assert.equal(state.entries[0].id, 1);
  for (let index = 0; index < 1000; index++) buffer.append(input);
  const changes = buffer.drainChanges(); assert.equal(changes.length, 1000);
  state = applySerialDelta(state, { baseRevision: 1, revision: 2, ...buffer.metadata(), entries: changes });
  assert.equal(state.entries.length, 10000); assert.equal(state.firstId, 1001); assert.equal(state.lastId, 11000);
  assert.equal(state.entries[0].id, 1001); assert.equal(state.entries.at(-1).id, 11000);
  assert.equal(state.needsSnapshot, false); assert.equal(state.evicted, 1000); assert.deepEqual(buffer.drainChanges(), []);
});

test('large serial deltas match the reference upsert semantics without mutating or duplicating retained rows', () => {
  let state = applySerialSnapshot(emptySerialSnapshot(), { revision: 1, firstId: 1, lastId: 10000, entries: Array.from({ length: 10000 }, (_, index) => row(index + 1)) });
  for (let step = 0; step < 30; step++) {
    const previous = state;
    const firstId = previous.firstId + 7, lastId = previous.lastId + 7;
    const changes = [row(lastId), { ...row(firstId + 15), text: 'first update' }, row(lastId - 1),
      { ...row(firstId + 15), text: 'last update wins' }, ...Array.from({ length: 5 }, (_, index) => row(lastId - 2 - index))];
    const expected = new Map(previous.entries.map(entry => [entry.id, entry]));
    for (const entry of changes) expected.set(entry.id, entry);
    const reference = [...expected.values()].filter(entry => entry.id >= firstId && entry.id <= lastId).sort((left, right) => left.id - right.id).slice(-SERIAL_VIEW_LIMIT);
    state = applySerialDelta(previous, { baseRevision: previous.revision, revision: previous.revision + 1, firstId, lastId, entries: changes });
    assert.deepEqual(state.entries, reference); assert.equal(state.needsSnapshot, false); assert.equal(previous.entries[0].id, firstId - 7);
  }
  const metadataOnly = applySerialDelta(state, { baseRevision: state.revision, revision: state.revision + 1, entries: [], status: 'connected' });
  assert.equal(metadataOnly.entries, state.entries, 'Metadata changes must not recreate a 10k row array');
});

test('ordinary and incremental log views share the same 50k append boundary', () => {
  const all = Array.from({ length: 50010 }, (_, index) => row(index));
  assert.equal(appendLogWindow([], all).length, 50000);
  const source = readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  assert.match(source, /setSmartSearchIncremental\(prev => appendLogWindow\(prev, payload\.entries\)\)/);
  assert.doesNotMatch(source, /merged\.length > 5000/);
  assert.match(readFileSync(new URL('../src/components/SerialTerminal.jsx', import.meta.url), 'utf8'), /scrollback: SERIAL_VIEW_LIMIT/);
});

test('terminal replay storage is lazy even after connecting, and reset never exposes previous session bytes', () => {
  const source = readFileSync(new URL('../electron/lib/serial-terminal-buffer.cjs', import.meta.url), 'utf8');
  const allocations = []; const module = { exports: {} };
  runInThisContext(`(function(require,module,exports,Buffer){${source}\n})`)(createRequire(new URL('../electron/lib/serial-terminal-buffer.cjs', import.meta.url)), module, module.exports, {
    isBuffer: Buffer.isBuffer, alloc: size => { allocations.push(size); return Buffer.alloc(size); }
  });
  const buffer = module.exports.createSerialTerminalBuffer({ maxBytes: 16 * 1024 * 1024 }); assert.deepEqual(allocations, []);
  buffer.reset('A'); assert.equal(buffer.read({ sessionId: 'A', offset: 0 }).hex, ''); assert.deepEqual(allocations, []);
  buffer.append(Buffer.from('private old output')); assert.deepEqual(allocations, [16 * 1024 * 1024]);
  buffer.reset('B'); assert.equal(buffer.read({ sessionId: 'B', offset: 0 }).hex, '');
  buffer.append(Buffer.from('new')); assert.equal(buffer.read({ sessionId: 'B', offset: 0 }).hex, '6e6577');
  assert.deepEqual(allocations, [16 * 1024 * 1024], 'A new session can safely reuse the allocation, not its old readable range');
});

test('5MB terminal history replays in acknowledged 64KiB chunks without a 100ms pause between backlogged chunks', async () => {
  const raw = Buffer.alloc(10000 * 500, 0x61);
  for (let index = 0; index < 10000; index++) raw[index * 500 + 499] = 10;
  const buffer = createSerialTerminalBuffer({ maxBytes: 16 * 1024 * 1024 }); buffer.reset('replay-fixture'); buffer.append(raw);
  const callbacks = new Map(); const delays = []; const replay = []; const errors = []; let next = 0;
  let writing = false, written = 0, chunks = 0;
  const hash = createHash('sha256');
  const reader = createSerialTerminalReader({ sessionId: 'replay-fixture',
    read: args => ({ success: true, ...buffer.read(args) }),
    write: async (bytes, readonly) => {
      assert.equal(writing, false); writing = true; assert.equal(readonly, true); assert.ok(bytes.length <= 64 * 1024);
      await tick(); hash.update(bytes); written += bytes.length; chunks++; writing = false;
    },
    onReplayChange: value => replay.push(value), onTruncated: () => assert.fail('Ordinary 10k-line replay must not truncate'), onError: message => errors.push(message),
    schedule: (callback, delay) => { delays.push(delay); callbacks.set(++next, callback); return next; }, cancel: id => callbacks.delete(id) });
  reader.start();
  for (let iterations = 0; reader.state().replaying && !errors.length && iterations < 3000; iterations++) {
    await tick();
    if (callbacks.size) { const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback(); }
  }
  assert.deepEqual(errors, []); assert.equal(reader.state().replaying, false); assert.equal(written, raw.length);
  assert.equal(chunks, Math.ceil(raw.length / (64 * 1024))); assert.deepEqual(replay, [true, false]);
  assert.equal(hash.digest('hex'), createHash('sha256').update(raw).digest('hex'));
  assert.equal(delays.at(-1), 100); assert.ok(delays.slice(0, -1).every(delay => delay === 0));
  reader.dispose(); assert.equal(callbacks.size, 0);
});
