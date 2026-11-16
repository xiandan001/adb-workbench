import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LOG_VIEW_PREFS_KEY, LOG_VIEW_PREFS_LIMIT, defaultLogViewPreferences, normalizeLogViewPreferences, readLogViewPreferences, saveLogViewPreferences, logViewFor, updateLogView } from '../src/shared/logViewPreferences.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url);
const memory = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };

test('log layout and archive preferences are bounded metadata with exact renderer/main parity', () => {
  const backend = require('../electron/lib/log-view-preferences.cjs');
  const value = updateLogView(defaultLogViewPreferences(), 'hdc:board', 'realtime', { sidebarOpen: true, aiPanelHeight: 600, filter: { pkg: 'com.test', text: 'error', regex: '^error', pid: 123 }, buffers: ['app'] });
  value.archive = { enabled: true, maxBytes: 512 * 1024 * 1024 };
  assert.deepEqual(normalizeLogViewPreferences(value), backend.normalizeLogViewPreferences(value));
  assert.equal(logViewFor(value, 'hdc:board', 'realtime').aiPanelHeight, 600);
  assert.equal(logViewFor(value, 'board', 'realtime').sidebarOpen, false);
  assert.equal(logViewFor(value, 'hdc:board', 'file').sidebarOpen, false);
  assert.equal(logViewFor(value, 'hdc:board', 'realtime').filter.pid, 123);
  const legacy = structuredClone(value); delete legacy.views[0].filter; delete legacy.views[0].buffers;
  assert.deepEqual(normalizeLogViewPreferences(legacy), backend.normalizeLogViewPreferences(legacy));
  assert.deepEqual(normalizeLogViewPreferences(legacy).views[0].filter, {});
  for (const altered of [ { ...value, rawLogs: [] }, { ...value, grant: true }, { ...value, version: 2 }, { ...value, archive: { enabled: true, maxBytes: 1 } },
    { ...value, views: [{ ...value.views[0], pausedRows: [] }] }, { ...value, views: [{ ...value.views[0], aiPanelHeight: 10000 }] },
    { ...value, views: [value.views[0], value.views[0]] }, { ...value, views: [{ ...value.views[0], filter: { password: 'secret' } }] },
    { ...value, views: [{ ...value.views[0], filter: { text: 'x'.repeat(1025) } }] }, { ...value, views: [{ ...value.views[0], buffers: ['invalid'] }] } ]) {
    assert.throws(() => normalizeLogViewPreferences(altered)); assert.throws(() => backend.normalizeLogViewPreferences(altered));
  }
});

test('layout reads and writes preserve corrupt original data and keep unrelated device views', () => {
  const storage = memory(); let value = defaultLogViewPreferences();
  for (let index = 0; index < 25; index++) value = updateLogView(value, `device-${index}`, 'realtime', { detailWrap: false });
  assert.equal(value.views.length, 20); saveLogViewPreferences(value, storage);
  assert.deepEqual(readLogViewPreferences(storage), value);
  storage.values.set(LOG_VIEW_PREFS_KEY, '{broken'); assert.throws(() => saveLogViewPreferences(value, storage));
  assert.equal(storage.values.get(LOG_VIEW_PREFS_KEY), '{broken');
  storage.values.delete(LOG_VIEW_PREFS_KEY); storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveLogViewPreferences(value, storage), /quota/); assert.equal(storage.getItem(LOG_VIEW_PREFS_KEY), null);
});

test('log metadata survives backup with identical limits and rejects private fields before writing', () => {
  const storage = memory(), backend = require('../electron/lib/data-migration-policy.cjs');
  saveLogViewPreferences(defaultLogViewPreferences(), storage);
  const prefs = collectMigrationPreferences(storage), normalized = backend.normalizePreferences(prefs);
  assert.deepEqual(JSON.parse(normalized[LOG_VIEW_PREFS_KEY]), readLogViewPreferences(storage));
  const restored = memory(); applyMigrationPreferences(normalized, restored); assert.deepEqual(readLogViewPreferences(restored), readLogViewPreferences(storage));
  for (const raw of [JSON.stringify({ ...defaultLogViewPreferences(), raw: 'private logs' }), ' '.repeat(LOG_VIEW_PREFS_LIMIT + 1)]) {
    assert.throws(() => backend.normalizePreferences({ [LOG_VIEW_PREFS_KEY]: raw }));
    assert.throws(() => applyMigrationPreferences({ [LOG_VIEW_PREFS_KEY]: raw }, restored));
  }
  assert.equal(restored.getItem(LOG_VIEW_PREFS_KEY), storage.getItem(LOG_VIEW_PREFS_KEY));
});
