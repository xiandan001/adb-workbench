import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PORTABLE_PREF_KEYS, collectMigrationPreferences, applyMigrationPreferences, readMigratedPreference } from '../src/shared/dataMigrationStorage.js';
import { PINNED_DEVICES_KEY, readPinnedDevices } from '../src/shared/deviceDiscovery.js';
import { SERIAL_PREFS_KEY, SERIAL_HISTORY_KEY, defaultSerialPreferences, readSerialPreferences } from '../src/shared/serialSettings.js';
const require = createRequire(import.meta.url);
const backend = require('../electron/lib/data-migration-policy.cjs');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('renderer and backend preference allowlists agree exactly', () => {
  assert.deepEqual(PORTABLE_PREF_KEYS, backend.PORTABLE_PREF_KEYS);
});

test('serial preferences migrate but history, COM bindings and running state never migrate', () => {
  const prefs = { ...defaultSerialPreferences(), config: { ...defaultSerialPreferences().config, baudRate: 115200 },
    favorites: [{ id: 'status', name: '状态', mode: 'hex', content: '00 ff', lineEnding: 'none' }] };
  const source = storage({ [SERIAL_PREFS_KEY]: JSON.stringify(prefs), [SERIAL_HISTORY_KEY]: '[{"content":"private"}]',
    'serial-current-port': 'COM4', 'serial-active-session': 'running' });
  const portable = collectMigrationPreferences(source);
  assert.deepEqual(Object.keys(portable), [SERIAL_PREFS_KEY]);
  const target = storage({ [SERIAL_HISTORY_KEY]: 'keep local history', 'serial-current-port': 'COM9', activeDeviceId: 'unchanged' });
  applyMigrationPreferences(backend.normalizePreferences(portable), target);
  assert.deepEqual(readSerialPreferences(target), prefs);
  assert.equal(target.getItem(SERIAL_HISTORY_KEY), 'keep local history');
  assert.equal(target.getItem('serial-current-port'), 'COM9');
  assert.equal(target.getItem('activeDeviceId'), 'unchanged');
  for (const unsafe of [{ ...prefs, path: 'COM4' }, { ...prefs, autoConnect: true }, { ...prefs, sessionId: 'running' },
    { ...prefs, config: { ...prefs.config, path: 'COM4' } },
    { ...prefs, favorites: [{ ...prefs.favorites[0], autoSend: true }] }]) {
    const input = { [SERIAL_PREFS_KEY]: JSON.stringify(unsafe) };
    assert.throws(() => backend.normalizePreferences(input));
    assert.throws(() => applyMigrationPreferences(input, target));
    assert.deepEqual(readSerialPreferences(target), prefs);
  }
  assert.throws(() => backend.normalizePreferences({ [SERIAL_HISTORY_KEY]: '[]' }));
  assert.throws(() => applyMigrationPreferences({ [SERIAL_HISTORY_KEY]: '[]' }, target));
});

test('ASCII v1 preferences migrate with old UTF-8 and HEX favorites without binding or execution state', () => {
  const prefs = { ...defaultSerialPreferences(), receiveMode: 'ascii', sendMode: 'ascii', lineEnding: 'crlf', favorites: [
    { id: 'ascii', name: 'AT', mode: 'ascii', content: 'AT', lineEnding: 'crlf' },
    { id: 'text', name: '文本', mode: 'text', content: '中文😀', lineEnding: 'lf' },
    { id: 'hex', name: '字节', mode: 'hex', content: '00 ff', lineEnding: 'none' }
  ] };
  const source = storage({ [SERIAL_PREFS_KEY]: JSON.stringify(prefs) });
  const target = storage({ activeDeviceId: 'unchanged', 'serial-current-port': 'COM9' });
  applyMigrationPreferences(backend.normalizePreferences(collectMigrationPreferences(source)), target);
  assert.deepEqual(readSerialPreferences(target), prefs);
  assert.equal(target.getItem('activeDeviceId'), 'unchanged');
  assert.equal(target.getItem('serial-current-port'), 'COM9');
  assert.equal(target.getItem(SERIAL_HISTORY_KEY), null);
  const invalid = { ...prefs, favorites: [{ ...prefs.favorites[0], content: '中' }] };
  const input = { [SERIAL_PREFS_KEY]: JSON.stringify(invalid) };
  assert.throws(() => backend.normalizePreferences(input), /ASCII/);
  assert.throws(() => applyMigrationPreferences(input, target), /ASCII/);
  assert.deepEqual(readSerialPreferences(target), prefs);
});

test('device pins migrate and restore without changing the active device or unrelated preferences', () => {
  const saved = storage({ [PINNED_DEVICES_KEY]: '["离线设备","192.168.1.2:5555"]', activeDeviceId: 'current' });
  const exported = collectMigrationPreferences(saved);
  assert.deepEqual(exported, { [PINNED_DEVICES_KEY]: '["离线设备","192.168.1.2:5555"]' });
  const target = storage({ activeDeviceId: 'target-current', unrelated: 'keep' });
  applyMigrationPreferences(backend.normalizePreferences(exported), target);
  assert.deepEqual(readPinnedDevices(target), ['离线设备', '192.168.1.2:5555']);
  assert.equal(target.getItem('activeDeviceId'), 'target-current');
  assert.equal(target.getItem('unrelated'), 'keep');
  for (const value of [null, {}, [42], [''], [' '], ['bad\u0000id'], ['x'.repeat(301)], Array(1001).fill('a')]) {
    const preferences = { [PINNED_DEVICES_KEY]: JSON.stringify(value) };
    assert.throws(() => applyMigrationPreferences(preferences, target));
    assert.throws(() => backend.normalizePreferences(preferences));
  }
  assert.deepEqual(readPinnedDevices(target), ['离线设备', '192.168.1.2:5555']);
});

test('collect copies only supported saved preferences and propagates failures', () => {
  const saved = storage({ currentTheme: 'tech', deviceNames: '{"a":"设备"}', autoUpdateEnabled: 'true', 'vip-token': 'not-exported', activeDeviceId: 'old' });
  assert.deepEqual(collectMigrationPreferences(saved), { autoUpdateEnabled: 'true', deviceNames: '{"a":"设备"}', currentTheme: 'tech' });
  assert.throws(() => collectMigrationPreferences(storage({ deviceNames: '{bad' })));
  assert.throws(() => collectMigrationPreferences({ getItem() { throw new Error('blocked'); } }), /blocked/);
});

test('apply merges only imported keys and preserves all unrelated local storage', () => {
  const saved = storage({ currentTheme: 'default', autoUpdateEnabled: 'true', 'unrelated-key': 'keep', 'vip-token': 'keep-local' });
  applyMigrationPreferences({ currentTheme: 'tech', deviceNames: '{"a":"设备"}' }, saved);
  assert.equal(saved.getItem('currentTheme'), 'tech');
  assert.equal(saved.getItem('autoUpdateEnabled'), 'true');
  assert.equal(saved.getItem('unrelated-key'), 'keep');
  assert.equal(saved.getItem('vip-token'), 'keep-local');
});

test('apply validates all keys and values before any storage write', () => {
  const saved = storage({ currentTheme: 'default' });
  for (const bad of [{ currentTheme: 'tech', 'vip-token': 'bad' }, { currentTheme: 'tech', deviceNames: '[]' },
    { currentTheme: 'tech', autoUpdateEnabled: '"true"' }, { deviceNames: '{"__proto__":{"polluted":true}}' },
    JSON.parse('{"constructor":"true"}')]) {
    assert.throws(() => applyMigrationPreferences(bad, saved));
    assert.equal(saved.getItem('currentTheme'), 'default');
  }
  assert.throws(() => applyMigrationPreferences(Object.create({ currentTheme: 'tech' }), saved));
});

test('quota failure rolls back earlier writes and removes keys originally absent', () => {
  const saved = storage({ currentTheme: 'default', untouched: 'keep' });
  const write = saved.setItem;
  saved.setItem = (key, value) => { if (key === 'packageSearchVisible') throw new Error('quota'); write(key, value); };
  assert.throws(() => applyMigrationPreferences({ currentTheme: 'tech', deviceNames: '{}', packageSearchVisible: 'false' }, saved), /quota/);
  assert.equal(saved.getItem('currentTheme'), 'default');
  assert.equal(saved.getItem('deviceNames'), null);
  assert.equal(saved.getItem('untouched'), 'keep');
});

test('explicit restoration removes only allowlisted formerly absent keys and rolls back removal on later failure', () => {
  const saved = storage({ currentTheme: 'tech', deviceNames: '{}', unrelated: 'keep' });
  applyMigrationPreferences({ currentTheme: 'default' }, saved, ['deviceNames']);
  assert.equal(saved.getItem('deviceNames'), null);
  assert.equal(saved.getItem('unrelated'), 'keep');
  assert.throws(() => applyMigrationPreferences({}, saved, ['unrelated']));
  const write = saved.setItem;
  saved.setItem = (key, value) => { if (key === 'packageSearchVisible') throw new Error('quota'); write(key, value); };
  assert.throws(() => applyMigrationPreferences({ packageSearchVisible: 'true' }, saved, ['currentTheme']), /quota/);
  assert.equal(saved.getItem('currentTheme'), 'default');
});

test('read returns raw theme, parsed objects and booleans, malformed values return fallback', () => {
  const saved = storage({ currentTheme: 'tech', deviceNames: '{"a":"设备"}', autoUpdateEnabled: 'false',
    scrcpySettings: '{"screenOff":false,"stayAwake":true,"bitrate":"8 Mbps","maxSize":"0"}' });
  assert.equal(readMigratedPreference('currentTheme', 'default', saved), 'tech');
  assert.equal(readMigratedPreference('autoUpdateEnabled', true, saved), false);
  assert.deepEqual(readMigratedPreference('deviceNames', {}, saved), { a: '设备' });
  assert.equal(readMigratedPreference('scrcpySettings', null, saved).bitrate, '8 Mbps');
  saved.setItem('scrcpySettings', '{}');
  assert.equal(readMigratedPreference('scrcpySettings', null, saved), null);
  saved.setItem('deviceNames', '{"a":42}');
  assert.deepEqual(readMigratedPreference('deviceNames', {}, saved), {});
});
