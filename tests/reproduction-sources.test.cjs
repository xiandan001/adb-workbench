const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceSnapshots } = require('../electron/lib/reproduction-sources.cjs');
const selection = { serial: [{ workspace: 'terminal', sessionId: 'one' }], ssh: [] };

test('source sampling excludes old history and captures same-ID serial upserts', async () => {
  const snapshot = { sessionId: 'one', entries: [{ id: 1, text: 'old', direction: 'RX' }] };
  const read = createSourceSnapshots({ serial: { snapshot: () => snapshot }, ssh: {} });
  const initial = await read(selection, {}, true); assert.deepEqual(initial.items, []);
  assert.equal((await read(selection, initial.cursors)).items[0].text, '');
  snapshot.entries[0].text += ' tail';
  const next = await read(selection, initial.cursors);
  assert.equal(JSON.parse(next.items[0].text).update, true); assert.match(next.items[0].text, /old tail/);
  snapshot.sessionId = 'two';
  const changed = await read(selection, next.cursors);
  assert.equal(changed.items[0].unavailable, true); assert.ok(changed.cursors['serial:terminal'].closed);
});

test('bursts keep the newest bounded serial window and expose omissions', async () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, text: `row-${i + 1} ${'x'.repeat(4096)}`, direction: 'RX' }));
  const read = createSourceSnapshots({ serial: { snapshot: () => ({ sessionId: 'one', entries: rows }) }, ssh: {} });
  const result = await read(selection, { 'serial:terminal': { id: 1, textHash: '' } });
  assert.equal(result.items[0].truncated, true); assert.ok(Buffer.byteLength(result.items[0].text) < 64 * 1024);
  assert.equal(JSON.parse(result.items[0].text.split('\n').at(-1)).id, 10000);
});

test('SSH reads only selected terminal and tracks offsets without executing commands', async () => {
  const source = { sessionId: 's', terminalId: 't', startOffset: 0, endOffset: 200, title: 'fixture' }; const reads = [];
  const read = createSourceSnapshots({ serial: {}, ssh: { getAnalysisSources: () => [source], readAnalysisTerminal: item => { reads.push(item); return { text: 'delta' }; } } });
  const selected = { serial: [], ssh: [{ sessionId: 's', terminalId: 't' }] };
  const initial = await read(selected, {}, true); assert.equal(reads.length, 0);
  source.endOffset = 250;
  const next = await read(selected, initial.cursors); assert.equal(reads[0].startOffset, 200); assert.equal(next.items[0].truncated, false);
  source.endOffset = 20000;
  assert.equal((await read(selected, next.cursors)).items[0].truncated, true);
});
