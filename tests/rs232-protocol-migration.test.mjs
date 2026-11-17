import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PORTABLE_PREF_KEYS, collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url), backend = require('../electron/lib/data-migration-policy.cjs');
const KEY = 'adb-workbench.rs232-protocol.v1';
const value = () => ({ version: 1, overrides: [{ id: 'custom-10000000-0000-4000-8000-000000000001', name: '我的协议', category: '常用', template: ' FE 08 58 42 48 43 4D 44 00 01 CF\n', note: '原文不改', reviewed: true }], removed: ['lango-003'] });
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)); return { values, getItem: key => values.get(key) ?? null, setItem: (key, item) => values.set(key, item), removeItem: key => values.delete(key) };
}
test('RS232 metadata is the only new portable key and round-trips without COM, live state, drafts, RX or history', () => {
  assert.ok(PORTABLE_PREF_KEYS.includes(KEY)); assert.deepEqual(PORTABLE_PREF_KEYS, backend.PORTABLE_PREF_KEYS);
  const raw = JSON.stringify(value()), source = storage({ [KEY]: raw, 'serial-current-port': 'COM4', 'serial-session': 'running', 'serial-draft': 'PRIVATE TX', 'serial-rx': 'PRIVATE RX', 'serial-history': 'PRIVATE history' });
  const copied = collectMigrationPreferences(source); assert.deepEqual(copied, { [KEY]: raw });
  const target = storage({ 'serial-current-port': 'COM9', 'serial-draft': 'KEEP' }); applyMigrationPreferences(backend.normalizePreferences(copied), target);
  assert.deepEqual(JSON.parse(target.getItem(KEY)), value()); assert.equal(target.getItem('serial-current-port'), 'COM9'); assert.equal(target.getItem('serial-draft'), 'KEEP');
  assert.equal(source.getItem(KEY), raw);
});
test('unsafe RS232 fields or over-budget raw reject in both migration policies before any destination write', () => {
  for (const raw of [JSON.stringify({ ...value(), port: 'COM4' }), JSON.stringify({ ...value(), overrides: [{ ...value().overrides[0], history: ['PRIVATE'] }] }), ' '.repeat(512 * 1024) + JSON.stringify(value())]) {
    const target = storage({ [KEY]: 'EXACT OLD BYTES', currentTheme: 'graphite' }), before = Object.fromEntries(target.values);
    assert.throws(() => backend.normalizePreferences({ [KEY]: raw })); assert.throws(() => applyMigrationPreferences({ [KEY]: raw }, target));
    assert.deepEqual(Object.fromEntries(target.values), before);
  }
});
test('corrupt export is not skipped silently and a later import quota failure rolls all earlier keys back to exact original bytes', () => {
  const corrupt = storage({ [KEY]: '{broken PRIVATE' }); assert.throws(() => collectMigrationPreferences(corrupt)); assert.equal(corrupt.getItem(KEY), '{broken PRIVATE');
  const raw = ' {"version":1,"overrides":[],"removed":[]} ', target = storage({ [KEY]: raw, currentTheme: 'graphite' }), set = target.setItem;
  target.setItem = (key, item) => { if (key === KEY && item !== raw) throw Error('quota'); return set(key, item); };
  assert.throws(() => applyMigrationPreferences({ currentTheme: 'default', [KEY]: JSON.stringify(value()) }, target));
  assert.equal(target.getItem(KEY), raw); assert.equal(target.getItem('currentTheme'), 'graphite');
});
