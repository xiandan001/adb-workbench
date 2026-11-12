import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { UI_WORKSPACE_KEY, defaultUiWorkspace, normalizeUiWorkspace, readUiWorkspace, saveUiWorkspace, recentWirelessEntries } from '../src/shared/workbenchUiState.js';
const require = createRequire(import.meta.url);
const backend = require('../electron/lib/workbench-worksets-policy.cjs');
function storage() { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
test('UI workspace restores compact preference, exact device expansion, search and per-page position without commands', () => {
  const disk = storage(), value = { ...defaultUiWorkspace(), density: 'compact', expandedDeviceIds: ['USB-AbC', 'hdc:USB-AbC'], deviceQuery: 'Board', scrollPositions: { devices: 420, tasks: 100 } };
  saveUiWorkspace(value, disk); assert.deepEqual(readUiWorkspace(disk), value); assert.deepEqual(backend.normalizeUiWorkspace(value), value); assert.equal(backend.UI_WORKSPACE_KEY, UI_WORKSPACE_KEY);
});
test('both validators reject execution state, malformed IDs, oversized lists, unknown pages and sparse arrays', () => {
  const invalid = [{ ...defaultUiWorkspace(), execute: true }, { ...defaultUiWorkspace(), expandedDeviceIds: [' A'] }, { ...defaultUiWorkspace(), expandedDeviceIds: Array(2) },
    { ...defaultUiWorkspace(), scrollPositions: { execute: 0 } }, { ...defaultUiWorkspace(), scrollPositions: { devices: -1 } }, { ...defaultUiWorkspace(), density: 'unknown' }];
  for (const value of invalid) { assert.throws(() => normalizeUiWorkspace(value)); assert.throws(() => backend.normalizeUiWorkspace(value)); }
});
test('corrupt stored preferences and failed writes do not overwrite previous bytes', () => {
  const disk = storage(); disk.values.set(UI_WORKSPACE_KEY, '{bad');
  assert.throws(() => saveUiWorkspace(defaultUiWorkspace(), disk)); assert.equal(disk.values.get(UI_WORKSPACE_KEY), '{bad');
  disk.values.set(UI_WORKSPACE_KEY, JSON.stringify(defaultUiWorkspace()));
  const previous = disk.values.get(UI_WORKSPACE_KEY); disk.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveUiWorkspace({ ...defaultUiWorkspace(), density: 'compact' }, disk), /quota/); assert.equal(disk.values.get(UI_WORKSPACE_KEY), previous);
});
test('wireless recents retain exact transport identities without host discovery or reconnecting', () => {
  const rows = [{ type: 'wifi', deviceId: 'hdc:192.0.2.1:5555' }, { type: 'usb', deviceId: 'usb' }, { type: 'wifi', deviceId: '192.0.2.1:5555' }, { type: 'wifi', deviceId: 'hdc:192.0.2.1:5555' }, { type: 'wifi', deviceId: '192.0.2.2:5555' }];
  assert.deepEqual(recentWirelessEntries(rows).map(item => item.deviceId), ['hdc:192.0.2.1:5555', '192.0.2.1:5555', '192.0.2.2:5555']);
});
