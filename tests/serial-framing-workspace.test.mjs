import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applySerialDelta, applySerialSnapshot, emptySerialSnapshot } from '../src/shared/serialWorkspace.js';

const { createSerialBuffer } = createRequire(import.meta.url)('../electron/lib/serial-buffer.cjs');
const config = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const sample = 'ab050adf4eab07984401860b';
const append = (buffer, hex) => buffer.append({ sessionId: 'test', path: 'COM17', config, direction: 'RX', bytes: Buffer.from(hex, 'hex') });

test('provisional framing upserts and added rows replay with contiguous IDs for every received byte', () => {
  const buffer = createSerialBuffer({ now: () => 100 });
  let workspace = applySerialSnapshot(emptySerialSnapshot(), { ...buffer.metadata(), revision: 0, entries: [] });
  let revision = 0;
  for (let offset = 0; offset < sample.length; offset += 2) {
    append(buffer, sample.slice(offset, offset + 2));
    workspace = applySerialDelta(workspace, { ...buffer.metadata(), baseRevision: revision, revision: ++revision, entries: buffer.drainChanges() });
    assert.equal(workspace.needsSnapshot, false);
    assert.equal(workspace.entries.map(row => row.hex).join(''), sample.slice(0, offset + 2));
    assert.equal(workspace.rxBytes, (offset + 2) / 2);
  }
  assert.deepEqual(workspace.entries.map(row => [row.kind, row.hex]), [
    ['frame', 'ab050adf4e'], ['frame', 'ab07984401860b']
  ]);
});

test('sealing a false length reuses its row ID and publishes later recovered frames', () => {
  const buffer = createSerialBuffer({ now: () => 100 });
  append(buffer, 'abff' + sample);
  let workspace = applySerialSnapshot(emptySerialSnapshot(), { ...buffer.metadata(), revision: 1, entries: buffer.entriesAfter() });
  const pendingId = workspace.entries[0].id;
  buffer.drainChanges();
  buffer.sealReceive();
  workspace = applySerialDelta(workspace, { ...buffer.metadata(), baseRevision: 1, revision: 2, entries: buffer.drainChanges() });
  assert.equal(workspace.needsSnapshot, false);
  assert.equal(workspace.entries[0].id, pendingId);
  assert.deepEqual(workspace.entries.map(row => [row.kind, row.hex]), [
    ['raw', 'abff'], ['frame', 'ab050adf4e'], ['frame', 'ab07984401860b']
  ]);
  assert.equal(workspace.rxBytes, 14);
});

test('lost provisional update is repaired from snapshot without duplicating completed frames', () => {
  const buffer = createSerialBuffer({ now: () => 100 });
  append(buffer, 'ab');
  let workspace = applySerialSnapshot(emptySerialSnapshot(), { ...buffer.metadata(), revision: 1, entries: buffer.entriesAfter() });
  buffer.drainChanges();
  append(buffer, '050a');
  buffer.drainChanges(); // Simulate one lost renderer publication.
  append(buffer, 'df4eab07984401860b');
  workspace = applySerialDelta(workspace, { ...buffer.metadata(), baseRevision: 2, revision: 3, entries: buffer.drainChanges() });
  assert.equal(workspace.needsSnapshot, true);
  workspace = applySerialSnapshot(workspace, { ...buffer.metadata(), revision: 3, entries: buffer.entriesAfter() });
  assert.equal(workspace.needsSnapshot, false);
  assert.deepEqual(workspace.entries.map(row => row.hex), ['ab050adf4e', 'ab07984401860b']);
  assert.equal(workspace.rxBytes, 12);
});

test('all 2048 driver partitions of the user response yield the same two canonical frames', () => {
  const bytes = Buffer.from(sample, 'hex');
  for (let boundaries = 0; boundaries < 1 << (bytes.length - 1); boundaries++) {
    const buffer = createSerialBuffer({ now: () => 100 });
    let start = 0;
    for (let end = 1; end <= bytes.length; end++) {
      if (end !== bytes.length && !(boundaries & (1 << (end - 1)))) continue;
      append(buffer, bytes.subarray(start, end).toString('hex'));
      start = end;
    }
    assert.deepEqual(buffer.entriesAfter().map(row => [row.kind, row.hex]), [
      ['frame', 'ab050adf4e'], ['frame', 'ab07984401860b']
    ], `driver partition ${boundaries}`);
    assert.equal(buffer.metadata().rxBytes, 12);
  }
});

test('all 2048 partitions of the FE response preserve its final 01 CF in one frame', () => {
  const bytes = Buffer.from('fe09584248434d4401f101cf', 'hex');
  for (let boundaries = 0; boundaries < 1 << (bytes.length - 1); boundaries++) {
    const buffer = createSerialBuffer({ now: () => 100 });
    let start = 0;
    for (let end = 1; end <= bytes.length; end++) {
      if (end !== bytes.length && !(boundaries & (1 << (end - 1)))) continue;
      append(buffer, bytes.subarray(start, end).toString('hex'));
      start = end;
    }
    assert.deepEqual(buffer.entriesAfter().map(row => [row.kind, row.protocol, row.hex]), [
      ['frame', 'xbh', bytes.toString('hex')]
    ], `FE driver partition ${boundaries}`);
    assert.equal(buffer.metadata().rxBytes, 12);
  }
});
