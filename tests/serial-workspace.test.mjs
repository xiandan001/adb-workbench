import test from 'node:test';
import assert from 'node:assert/strict';
import { applySerialDelta, applySerialSnapshot, emptySerialSnapshot, createSerialDiscovery, readSerialWorkspace, updateSerialWorkspace } from '../src/shared/serialWorkspace.js';

const row = id => ({ id, bytes: 1, hex: '41', text: 'A' });

test('serial page workspace retains only session UI state across navigation without a whole-page collapse', () => {
  const original = readSerialWorkspace();
  try {
    updateSerialWorkspace({ selectedPath: 'COM10', draft: '待发送草稿', advanced: true, commandsOpen: true, following: false });
    const restored = readSerialWorkspace();
    assert.deepEqual(restored, { selectedPath: 'COM10', draft: '待发送草稿', advanced: true, commandsOpen: true, following: false });
    restored.draft = 'mutated copy';
    assert.equal(readSerialWorkspace().draft, '待发送草稿');
    assert.equal('open' in restored, false);
    assert.equal('connected' in restored, false);
    assert.equal('sessionId' in restored, false);
  } finally { updateSerialWorkspace(original); }
});

test('serial deltas trim evicted records and merge bounded chronological additions', () => {
  const initial = { ...emptySerialSnapshot(), revision: 2, entries: [row(1)], firstId: 1, lastId: 1 };
  const result = applySerialDelta(initial, { revision: 3, firstId: 2, lastId: 2, entries: [row(2)], reset: false });
  assert.deepEqual(result.entries.map(item => item.id), [2]);
  assert.equal(result.needsSnapshot, false);
  assert.deepEqual(initial.entries.map(item => item.id), [1]);
});

test('late snapshots and duplicate deltas cannot replace newer data', () => {
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 5, firstId: 1, lastId: 2, entries: [row(1), row(2)] });
  assert.equal(applySerialDelta(initial, { revision: 4, entries: [] }), initial);
  assert.equal(applySerialSnapshot(initial, { revision: 3, entries: [] }), initial);
  assert.deepEqual(applySerialDelta(initial, { revision: 6, firstId: 1, lastId: 2, entries: [row(2)] }).entries.map(item => item.id), [1, 2]);
});

test('missing delta rows request an authoritative snapshot; metadata-only revisions are valid', () => {
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 1, firstId: 1, lastId: 1, entries: [row(1)] });
  assert.equal(applySerialDelta(initial, { revision: 9, firstId: 1, lastId: 3, entries: [row(3)] }).needsSnapshot, true);
  assert.equal(applySerialDelta(initial, { revision: 7, firstId: 1, lastId: 1, entries: [], status: 'connected' }).needsSnapshot, false);
});

test('reset clears rows without assuming IDs restart; snapshot replaces equal revision', () => {
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 2, firstId: 20, lastId: 20, entries: [row(20)] });
  const cleared = applySerialDelta(initial, { revision: 3, reset: true, firstId: 0, lastId: 0, entries: [] });
  assert.deepEqual(cleared.entries, []);
  const resumed = applySerialDelta(cleared, { revision: 4, firstId: 21, lastId: 21, entries: [row(21)] });
  assert.equal(resumed.needsSnapshot, false);
  assert.deepEqual(applySerialSnapshot(resumed, { revision: 4, firstId: 21, lastId: 21, entries: [row(21)] }).entries, [row(21)]);
});

test('discovery deduplicates pending requests and preserves list on failure or disposal', async () => {
  let calls = 0;
  let resolve;
  const results = [];
  const discover = createSerialDiscovery({ list: () => { calls++; return new Promise(done => { resolve = done; }); }, onResult: value => results.push(value) });
  const first = discover.refresh();
  const duplicate = discover.refresh();
  assert.equal(calls, 1);
  resolve({ success: true, ports: [{ path: 'COM10' }] });
  await Promise.all([first, duplicate]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].ports, [{ path: 'COM10' }]);
  const second = discover.refresh();
  resolve({ success: false, error: 'driver unavailable' });
  await second;
  assert.equal(results[1].error, 'driver unavailable');
  assert.equal('ports' in results[1], false);
  const third = discover.refresh();
  discover.dispose();
  resolve({ success: true, ports: [] });
  await third;
  assert.equal(results.length, 2);
});
