import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSavedTaskRun } from '../src/shared/taskQuickRun.js';
import { applyAndConnectSerialScheme, normalizeSerialSchemeSelection, readSerialSchemeSelection, resetSerialSchemeSelection, saveSerialSchemeSelection } from '../src/shared/serialSchemeConnection.js';
import { defaultSerialPreferences } from '../src/shared/serialSettings.js';
import { addSerialScheme } from '../src/shared/serialSchemes.js';
import { seedQualityApplication } from '../src/shared/qualityDraft.js';

const online = [{ id: 'A', status: 'device' }, { id: 'B', status: 'device' }];
const script = () => ({ id: 'saved', name: 'Saved', targetPlatform: 'android', continueOnError: true, steps: [{ id: 's', type: 'delay', durationMs: 100 }] });
test('saved task run snapshots script and targets without editing caller state', () => {
  const selected = ['A'], source = script();
  const request = prepareSavedTaskRun({ script: source, deviceIds: selected, devices: online, outputBaseDir: 'output' });
  selected.push('B'); source.steps[0].durationMs = 999;
  assert.deepEqual(request.deviceIds, ['A']); assert.equal(request.script.steps[0].durationMs, 100);
  assert.equal(request.outputBaseDir, 'output'); assert.equal(request.concurrency, 1);
});
test('saved task run refuses offline, mismatched and wrong AI-target devices', () => {
  assert.throws(() => prepareSavedTaskRun({ script: script(), deviceIds: [], devices: online }));
  assert.throws(() => prepareSavedTaskRun({ script: script(), deviceIds: ['gone'], devices: online }));
  assert.throws(() => prepareSavedTaskRun({ script: script(), deviceIds: ['hdc:X'], devices: [{ id: 'hdc:X', status: 'device' }] }));
  assert.throws(() => prepareSavedTaskRun({ script: { ...script(), aiTargetDeviceId: 'A' }, deviceIds: ['B'], devices: online }));
});
function serialState() {
  return addSerialScheme(defaultSerialPreferences(), { id: 'scheme', name: 'Saved', workspace: 'rs232', config: { ...defaultSerialPreferences().config, baudRate: 115200 } });
}
test('serial combination saves first and connects the exact scheme with the current COM', async () => {
  const preferences = serialState(), order = [];
  const result = await applyAndConnectSerialScheme({ preferences, id: 'scheme', workspace: 'rs232', path: 'COM7', status: 'disconnected', pending: false,
    persist: next => { order.push('persist'); assert.equal(next.config.baudRate, 115200); return true; },
    connect: async request => { order.push('connect'); assert.equal(request.path, 'COM7'); assert.equal(request.config.baudRate, 115200); preferences.schemes[0].config.baudRate = 9600; return { success: true }; } });
  assert.deepEqual(order, ['persist', 'connect']); assert.equal(result.success, true);
});
test('serial persistence failure, missing COM and active sessions never connect', async () => {
  let connects = 0;
  const base = { preferences: serialState(), id: 'scheme', workspace: 'rs232', path: 'COM7', status: 'disconnected', pending: false,
    persist: () => false, connect: async () => { connects++; } };
  await assert.rejects(applyAndConnectSerialScheme(base));
  await assert.rejects(applyAndConnectSerialScheme({ ...base, persist: () => { throw Error('quota'); } }));
  await assert.rejects(applyAndConnectSerialScheme({ ...base, path: '', persist: () => true }));
  await assert.rejects(applyAndConnectSerialScheme({ ...base, status: 'connected', persist: () => true }));
  assert.equal(connects, 0);
});

test('serial request retains its exact configuration while persistence is pending', async () => {
  const preferences = serialState();
  let finishSave, payload;
  const promise = applyAndConnectSerialScheme({ preferences, id: 'scheme', workspace: 'rs232', path: 'COM7', status: 'disconnected', pending: false,
    persist: () => new Promise(resolve => { finishSave = resolve; }), connect: request => { payload = request; return { success: true }; } });
  preferences.schemes[0].config.baudRate = 9600;
  preferences.config.baudRate = 4800;
  finishSave(true); await promise;
  assert.equal(payload.config.baudRate, 115200); assert.equal(payload.path, 'COM7');
  assert.equal(Object.isFrozen(payload), true); assert.equal(Object.isFrozen(payload.config), true);
});
test('quality defaults reuse only same-device application in an untouched empty draft', () => {
  const context = { deviceId: 'A', packageName: 'com.example.current' };
  assert.equal(seedQualityApplication({}, 'A', context).packageName, context.packageName);
  assert.equal(seedQualityApplication({}, 'B', context).packageName, '');
  assert.equal(seedQualityApplication({ packageName: 'com.example.saved' }, 'A', context).packageName, 'com.example.saved');
  assert.equal(seedQualityApplication({ apkPath: 'chosen.apk' }, 'A', context).packageName, '');
});
test('serial scheme selections persist independently without storing connections or overwriting corrupt values', () => {
  let raw = null, writes = 0;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; writes++; } };
  assert.deepEqual(readSerialSchemeSelection(storage), { version: 1, rs232: '', terminal: '' });
  saveSerialSchemeSelection({ version: 1, rs232: 'one', terminal: 'two' }, storage);
  assert.deepEqual(readSerialSchemeSelection(storage), { version: 1, rs232: 'one', terminal: 'two' });
  raw = '{broken'; assert.throws(() => saveSerialSchemeSelection({ version: 1, rs232: '', terminal: '' }, storage));
  assert.equal(raw, '{broken'); assert.equal(writes, 1);
  assert.deepEqual(resetSerialSchemeSelection(storage), { version: 1, rs232: '', terminal: '' });
  assert.deepEqual(readSerialSchemeSelection(storage), { version: 1, rs232: '', terminal: '' });
  for (const invalid of [{ version: 2, rs232: '', terminal: '' }, { version: 1, rs232: '', terminal: '', port: 'COM1' },
    { version: 1, rs232: ' ', terminal: '' }, { version: 1, rs232: 'a'.repeat(201), terminal: '' },
    { version: 1, rs232: 'a\n', terminal: '' }]) assert.throws(() => normalizeSerialSchemeSelection(invalid));
});
test('quality seed rejects control text and never replaces a saved non-default choice', () => {
  assert.equal(seedQualityApplication({}, 'A', { deviceId: 'A', packageName: 'com.bad\napp' }).packageName, '');
  assert.equal(seedQualityApplication({ rounds: 20 }, 'A', { deviceId: 'A', packageName: 'com.example' }).packageName, '');
});
