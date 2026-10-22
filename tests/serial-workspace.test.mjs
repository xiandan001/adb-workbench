import test from 'node:test';
import assert from 'node:assert/strict';
import { applySerialDelta, applySerialSnapshot, emptySerialSnapshot, createSerialDiscovery, readSerialWorkspace, updateSerialWorkspace,
  emptySerialWorkspaces, applySerialWorkspaceSnapshot, applySerialWorkspaceDelta } from '../src/shared/serialWorkspace.js';

const row = id => ({ id, bytes: 1, hex: '41', text: 'A' });

test('independent serial workspaces can reuse revisions and record IDs without mixing data', () => {
  let states = emptySerialWorkspaces();
  states = applySerialWorkspaceSnapshot(states, { ...emptySerialSnapshot('rs232'), revision: 100, firstId: 1, lastId: 1, entries: [{ ...row(1), text: 'RS232' }] });
  states = applySerialWorkspaceSnapshot(states, { ...emptySerialSnapshot('terminal'), revision: 2, firstId: 1, lastId: 1, entries: [{ ...row(1), text: 'TERMINAL' }] });
  assert.equal(states.rs232.entries[0].text, 'RS232');
  assert.equal(states.terminal.entries[0].text, 'TERMINAL');
  const previousTerminal = states.terminal;
  states = applySerialWorkspaceDelta(states, { workspace: 'rs232', baseRevision: 100, revision: 101, firstId: 1, lastId: 1, entries: [{ ...row(1), text: 'RS232 updated' }] });
  assert.equal(states.terminal, previousTerminal);
  assert.equal(states.rs232.entries[0].text, 'RS232 updated');
  assert.equal(applySerialWorkspaceDelta(states, { workspace: 'unknown', revision: 999 }), states);
  assert.equal(applySerialWorkspaceSnapshot(states, { revision: 999, entries: [] }), states);
});

test('clearing or receiving a late snapshot only changes its captured serial workspace', () => {
  let states = emptySerialWorkspaces();
  states = applySerialWorkspaceSnapshot(states, { ...emptySerialSnapshot('terminal'), revision: 7, firstId: 1, lastId: 1, txBytes: 1, unsaved: true, entries: [row(1)] });
  states = applySerialWorkspaceSnapshot(states, { ...emptySerialSnapshot('rs232'), revision: 1, path: 'COM17', status: 'connected' });
  states = applySerialWorkspaceDelta(states, { workspace: 'rs232', baseRevision: 1, revision: 2, reset: true, firstId: 0, lastId: 0, txBytes: 0, entries: [], unsaved: false });
  assert.equal(states.terminal.txBytes, 1);
  assert.equal(states.terminal.unsaved, true);
  assert.equal(states.terminal.entries.length, 1);
  assert.equal(states.rs232.entries.length, 0);
  assert.equal(states.rs232.path, 'COM17');
});

test('serial page workspace retains only session UI state across navigation without a whole-page collapse', () => {
  const original = readSerialWorkspace();
  try {
    updateSerialWorkspace({ selectedPath: 'COM10', draft: '待发送草稿', advanced: true, commandsOpen: true, following: false });
    const restored = readSerialWorkspace();
    assert.deepEqual(restored, { ...original, selectedPath: 'COM10', draft: '待发送草稿', advanced: true, commandsOpen: true, following: false });
    restored.draft = 'mutated copy';
    assert.equal(readSerialWorkspace().draft, '待发送草稿');
    assert.equal('open' in restored, false);
    assert.equal('connected' in restored, false);
    assert.equal('sessionId' in restored, false);
  } finally { updateSerialWorkspace(original); }
});

test('serial mode defaults to RS232 and terminal settings remain local UI state across navigation', () => {
  const original = readSerialWorkspace();
  try {
    assert.equal(original.mode, 'rs232');
    assert.deepEqual(original.terminal, { enter: 'cr', backspace: 'del', localEcho: false, expanded: false, style: 'current' });
    updateSerialWorkspace({ mode: 'terminal', terminal: { ...original.terminal, enter: 'lf', style: 'classic' } });
    assert.equal(readSerialWorkspace().mode, 'terminal');
    const copied = readSerialWorkspace();
    copied.terminal.enter = 'crlf';
    copied.terminal.style = 'current';
    assert.equal(readSerialWorkspace().terminal.enter, 'lf');
    assert.equal(readSerialWorkspace().terminal.style, 'classic');
    assert.equal('connected' in copied, false);
  } finally { updateSerialWorkspace(original); }
});

test('RS232 and terminal keep independent port selections and advanced-panel state', () => {
  const original = readSerialWorkspace();
  try {
    updateSerialWorkspace({ selectedPath: 'COM3', advanced: true, terminalSelectedPath: 'COM17', terminalAdvanced: false });
    updateSerialWorkspace({ mode: 'terminal', terminalSelectedPath: 'COM22', terminalAdvanced: true });
    assert.equal(readSerialWorkspace().selectedPath, 'COM3');
    assert.equal(readSerialWorkspace().advanced, true);
    assert.equal(readSerialWorkspace().terminalSelectedPath, 'COM22');
    assert.equal(readSerialWorkspace().terminalAdvanced, true);
    updateSerialWorkspace({ mode: 'rs232', selectedPath: 'COM4' });
    assert.equal(readSerialWorkspace().terminalSelectedPath, 'COM22');
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

test('same-ID growth replaces the row without duplicating records or byte counts', () => {
  const first = { ...row(1), hex: 'ab05', bytes: 2, parts: 1, time: 100, endTime: 100 };
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 2, firstId: 1, lastId: 1, rxBytes: 2, entries: [first] });
  const updated = { ...first, hex: 'ab050adf4e', bytes: 5, parts: 2, endTime: 110 };
  const result = applySerialDelta(initial, { baseRevision: 2, revision: 3, firstId: 1, lastId: 1, rxBytes: 5, entries: [updated] });
  assert.deepEqual(result.entries, [updated]);
  assert.equal(result.rxBytes, 5);
  assert.equal(result.needsSnapshot, false);
  assert.equal(initial.entries[0].hex, 'ab05');
});

test('missed same-ID updates are detected by baseRevision and remain sticky until a full snapshot', () => {
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 2, firstId: 1, lastId: 2, entries: [row(1), row(2)] });
  const gap = applySerialDelta(initial, { baseRevision: 3, revision: 4, firstId: 1, lastId: 2, entries: [{ ...row(2), text: 'new' }] });
  assert.equal(gap.entries.length, 2);
  assert.equal(gap.needsSnapshot, true);
  const next = applySerialDelta(gap, { baseRevision: 4, revision: 5, firstId: 1, lastId: 2, entries: [] });
  assert.equal(next.needsSnapshot, true);
  assert.equal(applySerialDelta(next, { baseRevision: 5, revision: 6, reset: true, firstId: 0, lastId: 0, entries: [] }).needsSnapshot, true);
  assert.equal(applySerialSnapshot(next, { revision: 3, firstId: 1, lastId: 2, entries: [row(1), row(2)] }), next);
  const repaired = applySerialSnapshot(next, { revision: 5, firstId: 1, lastId: 2, entries: [{ ...row(1), text: 'missed update' }, row(2)] });
  assert.equal(repaired.needsSnapshot, false);
  assert.equal(repaired.entries[0].text, 'missed update');
});

test('a full snapshot newer than the last publication safely accepts the next overlapping delta', () => {
  const initial = applySerialSnapshot(emptySerialSnapshot(), { revision: 8, firstId: 1, lastId: 1, entries: [row(1)] });
  const result = applySerialDelta(initial, { baseRevision: 5, revision: 9, firstId: 1, lastId: 1, entries: [{ ...row(1), text: 'latest' }] });
  assert.equal(result.needsSnapshot, false);
  assert.equal(result.entries[0].text, 'latest');
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
