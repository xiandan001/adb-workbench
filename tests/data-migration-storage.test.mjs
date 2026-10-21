import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PORTABLE_PREF_KEYS, collectMigrationPreferences, applyMigrationPreferences, readMigratedPreference } from '../src/shared/dataMigrationStorage.js';
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
