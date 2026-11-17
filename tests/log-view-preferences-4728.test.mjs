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

test('AI scope and usage folds persist as booleans without storing content or consent', () => {
  const backend = require('../electron/lib/log-view-preferences.cjs'), storage = memory();
  const value = updateLogView(defaultLogViewPreferences(), 'device-A', 'realtime', { scopeExpanded: true, usageExpanded: true });
  saveLogViewPreferences(value, storage);
  assert.equal(logViewFor(readLogViewPreferences(storage), 'device-A', 'realtime').scopeExpanded, true);
  assert.equal(logViewFor(readLogViewPreferences(storage), 'device-A', 'realtime').usageExpanded, true);
  assert.equal(logViewFor(value, 'device-B', 'realtime').scopeExpanded, false);
  assert.deepEqual(normalizeLogViewPreferences(value), backend.normalizeLogViewPreferences(value));
  const migrated = memory(), policy = require('../electron/lib/data-migration-policy.cjs');
  applyMigrationPreferences(policy.normalizePreferences(collectMigrationPreferences(storage)), migrated);
  assert.deepEqual(readLogViewPreferences(migrated), readLogViewPreferences(storage));
  for (const patch of [{ scopeExpanded: 1 }, { usageExpanded: null }, { usageExpanded: 'true' }, { previewId: 'not-a-preference' }, { confirmed: true }]) {
    const invalid = { ...value, views: [{ ...value.views[0], ...patch }] };
    assert.throws(() => normalizeLogViewPreferences(invalid)); assert.throws(() => backend.normalizeLogViewPreferences(invalid));
  }
});

test('both legacy view shapes load collapsed and are not rewritten during reads', () => {
  const backend = require('../electron/lib/log-view-preferences.cjs');
  const current = updateLogView(defaultLogViewPreferences(), 'device-A', 'realtime', {});
  for (const oldLayout of [false, true]) {
    const legacy = structuredClone(current); delete legacy.views[0].scopeExpanded; delete legacy.views[0].usageExpanded;
    if (oldLayout) { delete legacy.views[0].filter; delete legacy.views[0].buffers; }
    const raw = JSON.stringify(legacy), storage = memory(); storage.setItem(LOG_VIEW_PREFS_KEY, raw);
    const loaded = readLogViewPreferences(storage);
    assert.equal(loaded.views[0].scopeExpanded, false); assert.equal(loaded.views[0].usageExpanded, false);
    assert.equal(storage.getItem(LOG_VIEW_PREFS_KEY), raw);
    assert.deepEqual(loaded, backend.normalizeLogViewPreferences(legacy));
  }
});

test('information disclosure is isolated, restartable metadata with exact backup and main parity', () => {
  const backend = require('../electron/lib/log-view-preferences.cjs'), policy = require('../electron/lib/data-migration-policy.cjs'), storage = memory();
  const value = updateLogView(defaultLogViewPreferences(), 'device-A', 'realtime', { infoExpanded: true, scopeExpanded: true,
    filter: { tag: 'RetainedTag' }, buffers: ['main', 'system'] });
  saveLogViewPreferences(value, storage);
  const restarted = readLogViewPreferences(storage);
  assert.equal(logViewFor(restarted, 'device-A', 'realtime').infoExpanded, true);
  assert.equal(logViewFor(restarted, 'device-B', 'realtime').infoExpanded, false);
  assert.equal(logViewFor(restarted, 'device-A', 'file').infoExpanded, false);
  assert.equal(logViewFor(restarted, 'device-A', 'realtime').scopeExpanded, true);
  assert.deepEqual(logViewFor(restarted, 'device-A', 'realtime').filter, { tag: 'RetainedTag' });
  assert.deepEqual(normalizeLogViewPreferences(value), backend.normalizeLogViewPreferences(value));
  const restored = memory(); applyMigrationPreferences(policy.normalizePreferences(collectMigrationPreferences(storage)), restored);
  assert.deepEqual(readLogViewPreferences(restored), restarted);
  const raw = storage.getItem(LOG_VIEW_PREFS_KEY); storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveLogViewPreferences(updateLogView(restarted, 'device-A', 'realtime', { infoExpanded: false }), storage), /quota/);
  assert.equal(storage.getItem(LOG_VIEW_PREFS_KEY), raw);
  assert.equal(logViewFor(readLogViewPreferences(storage), 'device-A', 'realtime').infoExpanded, true);
  for (const infoExpanded of [1, 0, null, 'true', [], {}]) {
    const invalid = { ...value, views: [{ ...value.views[0], infoExpanded }] };
    assert.throws(() => normalizeLogViewPreferences(invalid)); assert.throws(() => backend.normalizeLogViewPreferences(invalid));
  }
});

test('missing information disclosure defaults false without rewriting either legacy view or corrupt source bytes', () => {
  const backend = require('../electron/lib/log-view-preferences.cjs');
  const current = updateLogView(defaultLogViewPreferences(), 'device-A', 'realtime', { infoExpanded: true });
  for (const oldLayout of [false, true]) {
    const legacy = structuredClone(current); delete legacy.views[0].infoExpanded;
    if (oldLayout) { delete legacy.views[0].filter; delete legacy.views[0].buffers; delete legacy.views[0].scopeExpanded; delete legacy.views[0].usageExpanded; }
    const raw = JSON.stringify(legacy), storage = memory(); storage.setItem(LOG_VIEW_PREFS_KEY, raw);
    assert.equal(logViewFor(readLogViewPreferences(storage), 'device-A', 'realtime').infoExpanded, false);
    assert.deepEqual(readLogViewPreferences(storage), backend.normalizeLogViewPreferences(legacy));
    assert.equal(storage.getItem(LOG_VIEW_PREFS_KEY), raw);
  }
  const corrupt = memory(); corrupt.setItem(LOG_VIEW_PREFS_KEY, '{original invalid bytes');
  assert.throws(() => saveLogViewPreferences(current, corrupt)); assert.equal(corrupt.getItem(LOG_VIEW_PREFS_KEY), '{original invalid bytes');
  const quota = memory(); quota.setItem(LOG_VIEW_PREFS_KEY, JSON.stringify(current)); const previous = quota.getItem(LOG_VIEW_PREFS_KEY);
  quota.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveLogViewPreferences(updateLogView(current, 'device-A', 'realtime', { infoExpanded: false }), quota), /quota/);
  assert.equal(quota.getItem(LOG_VIEW_PREFS_KEY), previous);
});
