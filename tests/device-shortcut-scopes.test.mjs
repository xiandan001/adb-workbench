import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DEVICE_SHORTCUTS_KEY, SHORTCUTS_KEY, HARMONY_SHORTCUTS_KEY, SHORTCUTS_CHANGED,
  defaultDeviceShortcuts, normalizeDeviceShortcutOverrides, readDeviceShortcuts, saveDeviceShortcuts,
  saveDeviceShortcutsForDevice, restoreSharedDeviceShortcuts } from '../src/shared/deviceNavigationShortcuts.js';
import { PORTABLE_PREF_KEYS, collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url);
const backend = require('../electron/lib/device-shortcuts-policy.cjs');
const migration = require('../electron/lib/data-migration-policy.cjs');
function storage(entries = []) {
  const values = new Map(entries), writes = [], result = { values, writes, fail: '',
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (result.fail === key) throw new Error('quota'); values.set(key, value); writes.push(['set', key]); },
    removeItem(key) { if (result.fail === key) throw new Error('remove denied'); values.delete(key); writes.push(['remove', key]); } };
  return result;
}
const config = label => { const value = defaultDeviceShortcuts(); value.slots[0].label = label; return value; };
const map = devices => ({ version: 1, devices });
const notify = () => {};

test('missing override reads platform factory/shared without any writes and reports the exact source identity', () => {
  const s = storage();
  assert.equal(readDeviceShortcuts(s, 'A').source, 'default'); assert.equal(readDeviceShortcuts(s, 'A').deviceId, 'A');
  assert.equal(readDeviceShortcuts(s, 'A').hasOverride, false); assert.deepEqual(s.writes, []);
  saveDeviceShortcuts(config('shared'), s, notify, 'A');
  assert.equal(readDeviceShortcuts(s, 'B').source, 'shared'); assert.equal(readDeviceShortcuts(s, 'B').config.slots[0].label, 'shared');
  assert.equal(readDeviceShortcuts(s, 'hdc:A').source, 'default');
});

test('current-only writes preserve shared data and independent A/B/USB/IP/transport/case identities', () => {
  const s = storage([[SHORTCUTS_KEY, JSON.stringify(config('common'))], [HARMONY_SHORTCUTS_KEY, JSON.stringify(defaultDeviceShortcuts('hdc:A'))]]);
  const common = s.getItem(SHORTCUTS_KEY), harmony = s.getItem(HARMONY_SHORTCUTS_KEY);
  const ids = ['A', 'B', '172.20.74.121:5555', 'hdc:A', 'a'];
  for (const [index, id] of ids.entries()) saveDeviceShortcutsForDevice(config('device-' + index), s, notify, id);
  for (const [index, id] of ids.entries()) {
    const fresh = readDeviceShortcuts({ getItem: key => s.values.get(key) ?? null }, id);
    assert.equal(fresh.config.slots[0].label, 'device-' + index); assert.equal(fresh.source, 'device'); assert.equal(fresh.hasOverride, true);
  }
  assert.equal(s.getItem(SHORTCUTS_KEY), common); assert.equal(s.getItem(HARMONY_SHORTCUTS_KEY), harmony);
  assert.ok(s.writes.every(([, key]) => key === DEVICE_SHORTCUTS_KEY));
});

test('shared saves preserve every override including current; restore shared removes only the requested ID', () => {
  const s = storage(); saveDeviceShortcutsForDevice(config('A'), s, notify, 'A'); saveDeviceShortcutsForDevice(config('B'), s, notify, 'B');
  const before = s.getItem(DEVICE_SHORTCUTS_KEY); saveDeviceShortcuts(config('new shared'), s, notify, 'A');
  assert.equal(s.getItem(DEVICE_SHORTCUTS_KEY), before); assert.equal(readDeviceShortcuts(s, 'A').config.slots[0].label, 'A');
  assert.equal(readDeviceShortcuts(s, 'C').config.slots[0].label, 'new shared');
  assert.equal(restoreSharedDeviceShortcuts(s, notify, 'A'), true);
  assert.equal(readDeviceShortcuts(s, 'A').source, 'shared'); assert.equal(readDeviceShortcuts(s, 'B').source, 'device');
  assert.equal(restoreSharedDeviceShortcuts(s, notify, 'B'), true); assert.equal(s.getItem(DEVICE_SHORTCUTS_KEY), null);
  const count = s.writes.length; assert.equal(restoreSharedDeviceShortcuts(s, notify, 'absent'), false); assert.equal(s.writes.length, count);
});

test('valid override does not read corrupt unused shared data, and removal exposes rather than overwrites that data', () => {
  const value = map([{ deviceId: 'A', config: config('independent') }]);
  const s = storage([[DEVICE_SHORTCUTS_KEY, JSON.stringify(value)], [SHORTCUTS_KEY, '{broken']]);
  assert.equal(readDeviceShortcuts(s, 'A').config.slots[0].label, 'independent');
  assert.equal(readDeviceShortcuts(s, 'B').errorSource, 'shared');
  assert.equal(restoreSharedDeviceShortcuts(s, notify, 'A'), true);
  assert.equal(readDeviceShortcuts(s, 'A').config, null); assert.equal(readDeviceShortcuts(s, 'A').errorSource, 'shared');
  assert.equal(s.getItem(SHORTCUTS_KEY), '{broken');
});

test('corrupt override storage is retained, fails closed and cannot be reset by silently changing global defaults', () => {
  const s = storage([[DEVICE_SHORTCUTS_KEY, '{broken']]);
  const result = readDeviceShortcuts(s, 'A'); assert.equal(result.config, null); assert.equal(result.errorSource, 'overrides');
  assert.throws(() => saveDeviceShortcutsForDevice(config('new'), s, notify, 'A'));
  assert.throws(() => restoreSharedDeviceShortcuts(s, notify, 'A'));
  assert.equal(s.getItem(DEVICE_SHORTCUTS_KEY), '{broken'); assert.deepEqual(s.writes, []);
});

test('quota and remove failures keep old data and never notify success', () => {
  const s = storage(); let notices = 0; const changed = () => notices++;
  saveDeviceShortcutsForDevice(config('old'), s, changed, 'A'); const raw = s.getItem(DEVICE_SHORTCUTS_KEY); assert.equal(notices, 1);
  s.fail = DEVICE_SHORTCUTS_KEY;
  assert.throws(() => saveDeviceShortcutsForDevice(config('new'), s, changed, 'A'), /quota/);
  assert.throws(() => restoreSharedDeviceShortcuts(s, changed, 'A'), /remove denied/);
  assert.equal(s.getItem(DEVICE_SHORTCUTS_KEY), raw); assert.equal(notices, 1);
});

test('override validators reject identical malformed containers, IDs, duplicates and nested operations', () => {
  const valid = map([{ deviceId: 'A', config: config('A') }, { deviceId: 'hdc:A', config: defaultDeviceShortcuts('hdc:A') }]);
  assert.deepEqual(normalizeDeviceShortcutOverrides(valid), backend.normalizeDeviceShortcutOverrides(valid));
  const bad = [null, [], { version: 2, devices: [] }, { ...valid, extra: true }, map(new Array(2)), map([{}, ...valid.devices]),
    map([valid.devices[0], valid.devices[0]]), map([{ ...valid.devices[0], extra: true }]),
    ...['', ' ', ' A', 'A B', 'A\nB', 'A\x7f', 'A'.repeat(301)].map(deviceId => map([{ deviceId, config: config('bad') }])),
    map([{ deviceId: 'A', config: { version: 1, slots: [] } }]), map(Array.from({ length: 1001 }, (_, i) => ({ deviceId: 'A' + i, config: config('A') })))];
  for (const value of bad) { assert.throws(() => normalizeDeviceShortcutOverrides(value)); assert.throws(() => backend.normalizeDeviceShortcutOverrides(value)); }
  for (const id of ['', ' A', 'A B']) assert.throws(() => saveDeviceShortcutsForDevice(config('A'), storage(), notify, id));
});

test('serialized UTF-8 limit is enforced identically, not merely an entry count or UTF-16 character limit', () => {
  const large = defaultDeviceShortcuts();
  large.slots = large.slots.map((slot, i) => ({ id: slot.id, type: 'shell', label: 'cmd-' + i, command: 'echo ' + '界'.repeat(1990) + i }));
  const value = map(Array.from({ length: 100 }, (_, i) => ({ deviceId: 'device-' + i, config: large })));
  assert.throws(() => normalizeDeviceShortcutOverrides(value)); assert.throws(() => backend.normalizeDeviceShortcutOverrides(value));
});

test('backups carry overrides through both validators, removal and rollback without altering unrelated data', () => {
  assert.ok(PORTABLE_PREF_KEYS.includes(DEVICE_SHORTCUTS_KEY)); assert.deepEqual([...PORTABLE_PREF_KEYS].sort(), [...migration.PORTABLE_PREF_KEYS].sort());
  const original = storage([['deviceNames', '{"A":"Alias"}']]); saveDeviceShortcutsForDevice(config('A'), original, notify, 'A');
  const portable = migration.normalizePreferences(collectMigrationPreferences(original)), restored = storage();
  applyMigrationPreferences(portable, restored); assert.equal(readDeviceShortcuts(restored, 'A').source, 'device'); assert.equal(restored.getItem('deviceNames'), original.getItem('deviceNames'));
  applyMigrationPreferences({}, restored, [DEVICE_SHORTCUTS_KEY]); assert.equal(restored.getItem(DEVICE_SHORTCUTS_KEY), null);
  const rollback = storage([['autoUpdateEnabled', 'true']]); rollback.fail = DEVICE_SHORTCUTS_KEY;
  assert.throws(() => applyMigrationPreferences({ autoUpdateEnabled: 'false', [DEVICE_SHORTCUTS_KEY]: original.getItem(DEVICE_SHORTCUTS_KEY) }, rollback), /quota/);
  assert.equal(rollback.getItem('autoUpdateEnabled'), 'true'); assert.equal(rollback.getItem(DEVICE_SHORTCUTS_KEY), null);
  const invalid = { [DEVICE_SHORTCUTS_KEY]: '{broken' }; const untouched = storage();
  assert.throws(() => applyMigrationPreferences(invalid, untouched)); assert.deepEqual(untouched.writes, []); assert.throws(() => migration.normalizePreferences(invalid));
});

test('same-window import notifies shortcut observers only after successful relevant writes', () => {
  const previous = globalThis.window, events = []; globalThis.window = { dispatchEvent: event => events.push(event.type) };
  try {
    const s = storage(); applyMigrationPreferences({ [DEVICE_SHORTCUTS_KEY]: JSON.stringify(map([{ deviceId: 'A', config: config('A') }])) }, s);
    assert.deepEqual(events, [SHORTCUTS_CHANGED]);
    applyMigrationPreferences({ autoUpdateEnabled: 'true' }, s); assert.equal(events.length, 1);
    s.fail = DEVICE_SHORTCUTS_KEY; assert.throws(() => applyMigrationPreferences({}, s, [DEVICE_SHORTCUTS_KEY])); assert.equal(events.length, 1);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
