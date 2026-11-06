const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createReproductionStore } = require('../electron/lib/reproduction-store.cjs');
const { readMarkerNeighborhood, recordNearMarker, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_TOTAL_CHARS } = require('../electron/lib/reproduction-neighborhood.cjs');

async function fixture(t, names) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-marker-neighborhood-'));
  const store = createReproductionStore(path.join(temporary, 'sessions'));
  const marker = { id: randomUUID(), at: 105000, offsetMs: 5000, videoOffsetMs: null, note: 'Observed issue' };
  const session = { schemaVersion: 1, id: randomUUID(), title: 'Synthetic neighborhood', deviceId: 'QA-ONLY', startedAt: 100000,
    status: 'completed', markers: [marker], warnings: [], files: names.map(name => ({ name, label: name, bytes: 0, truncated: false })) };
  await store.create(session);
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('awb-marker-neighborhood-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const write = async (name, rows) => fs.writeFile(await store.filePath(session.id, name), typeof rows === 'string' ? rows : rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { store, session, marker, write };
}

test('marker windows include only nearby host receipts and performance, never pretend device logs are aligned', async t => {
  const h = await fixture(t, ['serial-rs232.jsonl', 'performance.jsonl', 'device.log']);
  await h.write('serial-rs232.jsonl', [
    { at: 104000, offsetMs: 4000, sourceTime: 'host-receipt', text: 'nearby serial event' },
    { at: 130000, offsetMs: 30000, sourceTime: 'host-receipt', text: 'outside window' },
    { at: 105000, sourceTime: 'device-clock', text: 'must not align' }
  ]);
  await h.write('performance.jsonl', [{ at: 106000, offsetMs: 6000, snapshot: { cpu: 75 } }]);
  await h.write('device.log', '01-01 00:00:00 device clock log');
  const result = await readMarkerNeighborhood(h.store, h.session, h.marker.id);
  assert.equal(result.windowMs, 10000);
  const serial = result.sources.find(source => source.name === 'serial-rs232.jsonl');
  assert.equal(serial.entries.length, 1);
  assert.equal(serial.entries[0].relativeMs, -1000);
  assert.equal(serial.entries[0].text, 'nearby serial event');
  assert.match(result.sources.find(source => source.name === 'performance.jsonl').entries[0].text, /75/);
  const device = result.sources.find(source => source.name === 'device.log');
  assert.equal(device.clockBasis, 'device-unsynchronized');
  assert.equal(device.scannedBytes, 0);
});

test('clock movement does not corrupt monotonic matching and old wall-time rows are explicitly unaligned', async t => {
  const h = await fixture(t, ['serial-terminal.jsonl']);
  h.marker.at -= 60000;
  await h.write('serial-terminal.jsonl', [
    { at: h.marker.at, sourceTime: 'host-receipt', text: 'old wall-clock-only row' },
    { at: h.marker.at + 2000, offsetMs: 7000, sourceTime: 'host-receipt', text: 'new monotonic row' }
  ]);
  const result = await readMarkerNeighborhood(h.store, h.session, h.marker.id);
  assert.equal(result.clockUncertain, true);
  assert.equal(result.sources[0].unaligned, 1);
  assert.equal(result.sources[0].entries.length, 1);
  assert.equal(result.sources[0].entries[0].clockBasis, 'host-monotonic');
  assert.equal(result.sources[0].entries[0].relativeMs, 2000);
  assert.equal(recordNearMarker({ at: 105000, sourceTime: 'host-receipt', text: 'legacy' }, { at: 105000, offsetMs: 5000 }, false, false).clockBasis, 'host-wall');
});

test('only a declared marker can trigger reads, malformed lines are isolated and output stays bounded', async t => {
  const h = await fixture(t, ['serial-rs232.jsonl']);
  let reads = 0;
  await assert.rejects(readMarkerNeighborhood({ filePath() { reads++; throw new Error('must not read'); } }, h.session, 'forged-marker'), /标记/);
  assert.equal(reads, 0);
  const row = JSON.stringify({ at: 105000, offsetMs: 5000, sourceTime: 'host-receipt', text: 'e'.repeat(10000) });
  await h.write('serial-rs232.jsonl', '{invalid\n' + (row + '\n').repeat(60));
  const result = await readMarkerNeighborhood(h.store, h.session, h.marker.id);
  assert.equal(result.sources[0].malformed, 1);
  assert.equal(result.sources[0].truncated, true);
  assert.ok(result.sources[0].entries.length <= 20);
  assert.ok(result.sources.flatMap(source => source.entries).reduce((sum, entry) => sum + entry.text.length, 0) <= MAX_TOTAL_CHARS);
  assert.ok(result.sources[0].entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 12000);
});

test('large streams obey per-file/global scan caps and yield the event loop', async t => {
  const names = ['serial-rs232.jsonl', 'serial-terminal.jsonl', `ssh-${'a'.repeat(24)}.jsonl`];
  const h = await fixture(t, names);
  const bytes = ('x'.repeat(64 * 1024) + '\n').repeat(145);
  for (const name of names) await h.write(name, bytes);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  try {
    const result = await readMarkerNeighborhood(h.store, h.session, h.marker.id);
    assert.ok(result.scannedBytes <= MAX_TOTAL_BYTES);
    assert.ok(result.sources.every(source => source.scannedBytes <= MAX_FILE_BYTES && source.truncated));
    assert.equal(result.sources[2].scannedBytes, 0);
    assert.ok(ticks > 0, 'chunk scanning must yield rather than monopolize the main thread');
  } finally { clearInterval(timer); }
});
