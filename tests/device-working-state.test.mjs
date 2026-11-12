import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceWorkingStore, defaultDeviceWorkingState, normalizeDeviceWorkingConfig,
  parseDeviceWorkingStates, boundDeviceTerminalOutput, visibleDeviceTerminalOutput, DEVICE_WORKING_STATE_KEY, DEVICE_WORKING_LIMITS } from '../src/shared/deviceWorkingState.js';
import { collectMigrationPreferences } from '../src/shared/dataMigrationStorage.js';

function fixture(raw = null) {
  const entries = new Map(raw === null ? [] : [[DEVICE_WORKING_STATE_KEY, raw]]), jobs = new Map(), writes = []; let jobId = 0;
  const storage = { fail: false, getItem: key => entries.get(key) ?? null,
    setItem(key, value) { if (this.fail) throw new Error('quota'); entries.set(key, value); writes.push([key, value]); } };
  const options = { storage, schedule: callback => { jobs.set(++jobId, callback); return jobId; }, cancel: id => jobs.delete(id) };
  const store = createDeviceWorkingStore(options);
  return { store, storage, entries, writes, jobs, restart: () => createDeviceWorkingStore(options),
    flushJobs() { for (const [id, callback] of [...jobs]) { jobs.delete(id); callback(); } } };
}
const config = () => normalizeDeviceWorkingConfig(Object.fromEntries(Object.entries(defaultDeviceWorkingState())
  .filter(([key]) => !['terminalOutput', 'terminalOutputTruncated', 'draftNotSaved', 'isExecuting', 'storageError'].includes(key))));

test('exact identities isolate drafts and a live request settles after every subscriber unmounts without replay', async () => {
  const f = fixture(), a = 'USB-A', b = '10.0.0.1:5555', h = 'hdc:USB-A'; let notifications = 0, release;
  const unsubscribe = f.store.subscribe(a, () => notifications++);
  f.store.update(a, { terminalCommand: 'unsent secret', showTerminal: true });
  f.store.update(b, { terminalCommand: 'network draft' });
  f.store.update(h, { terminalCommand: 'native draft' });
  assert.equal(f.store.beginExecution(a), true); assert.equal(f.store.beginExecution(a), false);
  const request = new Promise(resolve => { release = resolve; }).then(output => {
    f.store.update(a, state => ({ terminalOutput: [...state.terminalOutput, { type: 'output', text: output }], isExecuting: false }));
  });
  unsubscribe(); const before = notifications;
  release('settled without mounted card'); await request;
  assert.equal(notifications, before); assert.equal(f.store.getSnapshot(a).isExecuting, false);
  assert.equal(f.store.getSnapshot(a).terminalOutput[0].text, 'settled without mounted card');
  assert.equal(f.store.getSnapshot(a).terminalCommand, 'unsent secret');
  assert.equal(f.store.getSnapshot(b).terminalCommand, 'network draft'); assert.equal(f.store.getSnapshot(h).terminalCommand, 'native draft');
  assert.equal(f.store.beginExecution(a), true); assert.equal(f.writes.length, 0);
});

test('batched private persistence restores config and draft but no output, execution or privilege authority', () => {
  const f = fixture();
  for (let index = 0; index < 50; index++) f.store.update('USB-A', { terminalCommand: `draft ${index}` });
  f.store.update('USB-A', { terminalFontSize: 20, maintenanceOpen: true, showTerminal: true, panelOrder: ['terminal'],
    terminalScroll: { top: 123, atBottom: false }, terminalOutput: [{ type: 'output', text: 'PRIVATE OUTPUT' }],
    isExecuting: true, suMode: true, suStrategy: 'direct', terminalFullscreen: true });
  assert.equal(f.jobs.size, 1); assert.equal(f.writes.length, 0); f.flushJobs(); assert.equal(f.writes.length, 1);
  const raw = f.storage.getItem(DEVICE_WORKING_STATE_KEY);
  assert.doesNotMatch(raw, /PRIVATE OUTPUT|isExecuting|suMode|suStrategy|terminalFullscreen/);
  const restored = f.restart().getSnapshot('USB-A');
  assert.equal(restored.terminalCommand, 'draft 49'); assert.equal(restored.terminalFontSize, 20);
  assert.equal(restored.showTerminal, true); assert.equal(restored.maintenanceOpen, true);
  assert.deepEqual(restored.terminalScroll, { top: 123, atBottom: false }); assert.deepEqual(restored.terminalOutput, []);
  assert.equal(restored.isExecuting, false); assert.equal(restored.suMode, undefined);
  assert.deepEqual(collectMigrationPreferences(f.storage), {}, 'raw terminal draft key is not exported by ordinary migration');
});

test('corrupt, unknown-field, duplicate-id and oversized storage remains untouched with an inline error', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 2, devices: [] }), JSON.stringify({ version: 1, devices: [], suMode: true }),
    JSON.stringify({ version: 1, devices: [{ deviceId: 'A', config: config() }, { deviceId: 'A', config: config() }] }),
    JSON.stringify({ version: 1, devices: [{ deviceId: 'A', config: { ...config(), terminalOutput: [] } }] }),
    'x'.repeat(DEVICE_WORKING_LIMITS.storage + 1)]) {
    const f = fixture(raw); assert.ok(f.store.getSnapshot('A').storageError);
    f.store.update('A', { terminalCommand: 'do not lose this draft' }); f.flushJobs(); assert.equal(f.store.flush(), false);
    assert.equal(f.storage.getItem(DEVICE_WORKING_STATE_KEY), raw); assert.deepEqual(f.writes, []);
    assert.equal(f.store.getSnapshot('A').terminalCommand, 'do not lose this draft');
  }
});

test('failed writes preserve disk and live draft; explicit retry saves without clearing input', () => {
  const initial = JSON.stringify({ version: 1, devices: [{ deviceId: 'A', config: config() }] }), f = fixture(initial);
  f.storage.fail = true; f.store.update('A', { terminalCommand: 'keep draft' }); f.flushJobs();
  assert.equal(f.storage.getItem(DEVICE_WORKING_STATE_KEY), initial); assert.ok(f.store.getSnapshot('A').storageError);
  assert.equal(f.store.getSnapshot('A').terminalCommand, 'keep draft'); f.storage.fail = false;
  assert.equal(f.store.flush(), true); assert.equal(f.store.getSnapshot('A').storageError, '');
  assert.equal(f.restart().getSnapshot('A').terminalCommand, 'keep draft');
});

test('runtime and disk limits evict old idle identities but never a pending request', () => {
  const f = fixture(); f.store.update('pending', { terminalCommand: 'pending draft' }); f.store.beginExecution('pending');
  f.store.update('pending', { terminalOutput: [{ type: 'output', text: 'pending result' }] });
  for (let index = 0; index < 30; index++) f.store.update(`device-${index}`, { terminalCommand: `draft ${index}` });
  assert.equal(f.store.getSnapshot('pending').isExecuting, true); assert.equal(f.store.getSnapshot('pending').terminalOutput[0].text, 'pending result');
  f.store.flush(); assert.equal(parseDeviceWorkingStates(f.storage.getItem(DEVICE_WORKING_STATE_KEY)).length, DEVICE_WORKING_LIMITS.devices);
  assert.equal(f.store.getSnapshot('device-0').terminalCommand, '', 'old nonpending identity is evicted');
});

test('output keeps a generous 50k rows, clips overlong text, and applies a global idle-output budget visibly', () => {
  const rows = Array.from({ length: DEVICE_WORKING_LIMITS.rows + 1 }, (_, index) => ({ type: 'output', text: String(index) }));
  const bounded = boundDeviceTerminalOutput(rows); assert.equal(bounded.rows.length, DEVICE_WORKING_LIMITS.rows);
  assert.equal(bounded.rows[0].text, '1'); assert.equal(bounded.truncated, true);
  const huge = boundDeviceTerminalOutput([{ type: 'output', text: 'x'.repeat(DEVICE_WORKING_LIMITS.output / 2 + 5) }]);
  assert.equal(huge.rows[0].text.length * 2, DEVICE_WORKING_LIMITS.output); assert.equal(huge.truncated, true);
  const f = fixture(), chunk = 'x'.repeat(DEVICE_WORKING_LIMITS.output / 2);
  f.store.beginExecution('pending'); f.store.update('pending', { terminalOutput: [{ type: 'output', text: chunk }] });
  for (let index = 0; index < 4; index++) f.store.update(`idle-${index}`, { terminalOutput: [{ type: 'output', text: chunk }] });
  assert.equal(f.store.getSnapshot('pending').terminalOutput[0].text.length, chunk.length);
  assert.deepEqual(f.store.getSnapshot('idle-0').terminalOutput, []); assert.equal(f.store.getSnapshot('idle-0').terminalOutputTruncated, true);
  assert.equal(f.store.getSnapshot('idle-3').terminalOutput[0].text.length, chunk.length);
});

test('scroll snapshots save silently without a render for every scroll event', () => {
  const f = fixture(); let notifications = 0; const unsubscribe = f.store.subscribe('A', () => notifications++);
  f.store.update('A', { terminalScroll: { top: 300, atBottom: false } }, { silent: true });
  assert.equal(notifications, 0); assert.deepEqual(f.store.getSnapshot('A').terminalScroll, { top: 300, atBottom: false });
  f.store.flush(); assert.equal(f.restart().getSnapshot('A').terminalScroll.top, 300); unsubscribe();
});

test('oversize runtime drafts remain executable verbatim while disk retains the last valid draft with an explicit warning', () => {
  const f = fixture(); f.store.update('A', { terminalCommand: 'last saved draft' }); f.store.flush();
  const long = 'x'.repeat(100000); f.store.update('A', { terminalCommand: long, terminalFontSize: 19 }); f.store.flush();
  assert.equal(f.store.getSnapshot('A').terminalCommand, long); assert.equal(f.store.getSnapshot('A').draftNotSaved, true);
  assert.equal(f.restart().getSnapshot('A').terminalCommand, 'last saved draft'); assert.equal(f.restart().getSnapshot('A').terminalFontSize, 19);
  assert.equal(f.store.beginExecution('A'), true); f.store.update('A', { terminalCommand: '' }); f.store.flush();
  assert.equal(f.store.getSnapshot('A').draftNotSaved, false); assert.equal(f.restart().getSnapshot('A').terminalCommand, '');
});

test('visible terminal output bounds both row DOM and one giant text node without shrinking the runtime buffer', () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({ type: 'output', text: String(index) }));
  const visible = visibleDeviceTerminalOutput(rows);
  assert.equal(visible.rows.length, DEVICE_WORKING_LIMITS.renderedRows); assert.equal(visible.rows[0].position, 1001);
  assert.equal(visible.rows.at(-1).text, '1999'); assert.equal(visible.clipped, true); assert.equal(rows.length, 2000);
  const giant = [{ type: 'output', text: 'x'.repeat(DEVICE_WORKING_LIMITS.renderedText + 50) }];
  assert.equal(visibleDeviceTerminalOutput(giant).rows[0].text.length, DEVICE_WORKING_LIMITS.renderedText);
  assert.equal(visibleDeviceTerminalOutput(giant).clipped, true); assert.equal(giant[0].text.length, DEVICE_WORKING_LIMITS.renderedText + 50);
});
