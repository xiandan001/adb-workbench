import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { APPLICATION_CONTEXT_KEY, normalizeApplicationContext } from '../src/shared/applicationContext.js';
import { APPLICATION_RECENTS_KEY, normalizeApplicationRecents } from '../src/shared/applicationPicker.js';
import { AI_DRAFT_KEY, normalizeAiSelectionDraft } from '../src/shared/aiSelectionDraft.js';
import { ARTIFACT_VIEW_KEY, normalizeArtifactViewState } from '../src/shared/artifactViewState.js';
import { SERIAL_SCHEME_SELECTION_KEY, normalizeSerialSchemeSelection } from '../src/shared/serialSchemeConnection.js';
import { PORTABLE_PREF_KEYS, applyMigrationPreferences, collectMigrationPreferences } from '../src/shared/dataMigrationStorage.js';

const require = createRequire(import.meta.url), policy = require('../electron/lib/data-migration-policy.cjs');
const backend = require('../electron/lib/ux-metadata-policy.cjs');
const archive = require('../electron/lib/data-migration-archive.cjs');
const ai = () => ({ version: 1, mode: 'diagnose', cases: Object.fromEntries(['diagnose', 'analysis', 'task'].map(mode => [mode,
  { deviceId: 'USB-A', checks: ['device_info', 'app_package'], diagnostic: { packageName: 'com.example.app', symptom: 'crash' } }])) });
const fixtures = [
  [APPLICATION_CONTEXT_KEY, () => ({ version: 1, entries: [{ deviceId: 'USB-A', packageName: 'com.example.app' }] }), normalizeApplicationContext, 'normalizeApplicationContext', 32768],
  [APPLICATION_RECENTS_KEY, () => ({ version: 1, items: [{ deviceId: 'USB-A', packages: ['com.example.app'] }] }), normalizeApplicationRecents, 'normalizeApplicationRecents', 65536],
  [AI_DRAFT_KEY, ai, normalizeAiSelectionDraft, 'normalizeAiSelectionDraft', 16384],
  [ARTIFACT_VIEW_KEY, () => ({ version: 1, entries: [{ deviceId: 'USB-A', query: 'problem', typeFilter: 'task', sortOrder: 'newest', visibleCount: 60 }] }), normalizeArtifactViewState, 'normalizeArtifactViewState', 131072],
  [SERIAL_SCHEME_SELECTION_KEY, () => ({ version: 1, rs232: 'one', terminal: 'two' }), normalizeSerialSchemeSelection, 'normalizeSerialSchemeSelection', 2048]
];
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('five UX metadata keys share the portable contract and real renderer/backend normalized values', () => {
  assert.deepEqual(PORTABLE_PREF_KEYS, policy.PORTABLE_PREF_KEYS);
  const values = Object.fromEntries(fixtures.map(([key, create]) => [key, JSON.stringify(create())]));
  const source = storage({ ...values, 'raw-logs': 'private', 'vip-token': 'secret', 'artifact-selectedIds': '["delete"]' });
  const collected = collectMigrationPreferences(source);
  assert.deepEqual(collected, values);
  const migrated = policy.normalizePreferences(collected), target = storage(); applyMigrationPreferences(migrated, target);
  for (const [key, create, normalize, name] of fixtures) {
    assert.ok(PORTABLE_PREF_KEYS.includes(key)); assert.deepEqual(backend[name](create()), normalize(create()));
    assert.deepEqual(JSON.parse(target.getItem(key)), normalize(create()));
  }
  assert.equal(target.getItem('raw-logs'), null); assert.equal(target.getItem('vip-token'), null); assert.equal(target.getItem('artifact-selectedIds'), null);
});
test('raw budgets match exactly on both sides, including serial character rather than byte budget', () => {
  for (const [key, create, , , budget] of fixtures) {
    const value = create(); if (key === SERIAL_SCHEME_SELECTION_KEY) value.rs232 = '中'.repeat(200);
    const raw = JSON.stringify(value), current = key === SERIAL_SCHEME_SELECTION_KEY ? raw.length : Buffer.byteLength(raw);
    const exact = raw + ' '.repeat(budget - current), excess = exact + ' ';
    assert.doesNotThrow(() => collectMigrationPreferences(storage({ [key]: exact })));
    assert.doesNotThrow(() => policy.normalizePreferences({ [key]: exact }));
    assert.throws(() => collectMigrationPreferences(storage({ [key]: excess })));
    assert.throws(() => policy.normalizePreferences({ [key]: excess }));
  }
});
test('the real backup archive codec retains all five metadata keys without restoring an active operation', () => {
  const preferences = Object.fromEntries(fixtures.map(([key, create]) => [key, JSON.stringify(create(), null, 2) + '\n']));
  const encoded = archive.encodeArchive({ schemaVersion: 1, appVersion: '4.7.27', createdAt: '2026-11-16T00:00:00.000Z', files: [], preferences });
  const decoded = archive.readArchive(encoded);
  assert.equal(decoded.summary.preferenceCount, 5);
  const target = storage({ activeDeviceId: 'unchanged', 'serial-current-port': 'COM9', 'task-running': 'keep' });
  applyMigrationPreferences(decoded.payload.preferences, target);
  for (const [key, create, normalize] of fixtures) assert.deepEqual(JSON.parse(target.getItem(key)), normalize(create()));
  assert.equal(target.getItem('activeDeviceId'), 'unchanged'); assert.equal(target.getItem('serial-current-port'), 'COM9'); assert.equal(target.getItem('task-running'), 'keep');
});
test('unknown metadata fields, unsafe prototype keys and wrong versions reject before any migration writes', () => {
  for (const [key, create] of fixtures) for (const change of [value => ({ ...value, version: 9 }), value => ({ ...value, rawLogs: ['private'] }),
    value => ({ ...value, password: 'secret' }), value => ({ ...value, selectedIds: ['delete'] }), value => JSON.parse(JSON.stringify(value).replace('{', '{"__proto__":{},'))]) {
    const raw = JSON.stringify(change(create())), target = storage({ currentTheme: 'default', [key]: 'keep exact original' });
    assert.throws(() => policy.normalizePreferences({ [key]: raw }));
    assert.throws(() => applyMigrationPreferences({ currentTheme: 'tech', [key]: raw }, target));
    assert.equal(target.getItem('currentTheme'), 'default'); assert.equal(target.getItem(key), 'keep exact original');
  }
});
test('nested schema bounds and prototype rules match every shared normalizer without silent truncation', () => {
  const invalidChanges = {
    [APPLICATION_CONTEXT_KEY]: [value => { value.entries.push(value.entries[0]); }, value => { value.entries = Array.from({ length: 21 }, (_, i) => ({ deviceId: String(i), packageName: 'com.a' })); },
      ...['', ' ', 'bad\n', 'x'.repeat(301)].map(id => value => { value.entries[0].deviceId = id; }),
      ...['', 'bad/name', 'x'.repeat(257)].map(name => value => { value.entries[0].packageName = name; }), value => { value.entries[0].rawLogs = 'private'; }],
    [APPLICATION_RECENTS_KEY]: [value => { value.items.push(value.items[0]); }, value => { value.items = Array.from({ length: 21 }, (_, i) => ({ deviceId: String(i), packages: [] })); },
      value => { value.items[0].packages = Array.from({ length: 7 }, (_, i) => 'com.a' + i); }, value => { value.items[0].packages = ['com.a', 'com.a']; },
      ...['', 'bad/name', 'x'.repeat(257)].map(name => value => { value.items[0].packages = [name]; }), value => { value.items[0].deviceId = 'bad id'; },
      value => { value.items[0].secret = 'private'; }],
    [AI_DRAFT_KEY]: [value => { value.cases.diagnose.checks = Array(8).fill('device_info'); }, value => { value.cases.diagnose.checks = ['device_info', 'device_info']; },
      value => { value.cases.diagnose.checks = ['unknown']; }, value => { value.cases.task.requirements = { text: 'private' }; },
      value => { value.cases.analysis.diagnostic.question = 'private'; }, value => { value.cases.diagnose.diagnostic.symptom = 'unknown'; },
      ...['single', 'bad/name', 'x'.repeat(201)].map(name => value => { value.cases.diagnose.diagnostic.packageName = name; }),
      value => { value.cases.diagnose.deviceId = 'x'.repeat(301); }, value => { delete value.cases.task; }],
    [ARTIFACT_VIEW_KEY]: [value => { value.entries.push(value.entries[0]); }, value => { value.entries = Array.from({ length: 21 }, (_, i) => ({ ...value.entries[0], deviceId: String(i) })); },
      value => { value.entries[0].query = 'x'.repeat(301); }, value => { value.entries[0].query = 'bad\n'; }, value => { value.entries[0].deviceId = 'x'.repeat(301); },
      value => { value.entries[0].typeFilter = 'unknown'; }, value => { value.entries[0].sortOrder = 'unknown'; },
      ...[29, 31, 3030, 30.5, Number.MAX_SAFE_INTEGER + 1].map(count => value => { value.entries[0].visibleCount = count; }), value => { value.entries[0].selectedIds = ['delete']; }],
    [SERIAL_SCHEME_SELECTION_KEY]: [...[' ', 'bad\n', 'x'.repeat(201), 5, null].map(id => value => { value.rs232 = id; }),
      value => { value.port = 'COM1'; }, value => { value.autoConnect = true; }]
  };
  for (const [key, create, normalize, name] of fixtures) {
    for (const change of invalidChanges[key]) {
      const value = create(); change(value); assert.throws(() => normalize(value)); assert.throws(() => backend[name](value));
      const raw = JSON.stringify(value); assert.throws(() => collectMigrationPreferences(storage({ [key]: raw }))); assert.throws(() => policy.normalizePreferences({ [key]: raw }));
    }
    const inherited = Object.assign(Object.create({ injected: true }), create());
    assert.throws(() => normalize(inherited)); assert.throws(() => backend[name](inherited));
    const nullPrototype = Object.assign(Object.create(null), create());
    if ([APPLICATION_RECENTS_KEY, AI_DRAFT_KEY].includes(key)) { assert.throws(() => normalize(nullPrototype)); assert.throws(() => backend[name](nullPrototype)); }
    else assert.deepEqual(backend[name](nullPrototype), normalize(nullPrototype));
  }
});
test('corrupt exports preserve the original bytes and failed imports atomically restore corrupt and absent originals', () => {
  for (const [key] of fixtures) {
    const source = storage({ [key]: '{broken original' }); assert.throws(() => collectMigrationPreferences(source)); assert.equal(source.getItem(key), '{broken original');
  }
  const incoming = Object.fromEntries(fixtures.map(([key, create]) => [key, JSON.stringify(create())]));
  const target = storage({ [APPLICATION_CONTEXT_KEY]: '{corrupt original', [APPLICATION_RECENTS_KEY]: '{also corrupt', unrelated: 'keep' });
  const before = [...target.values], write = target.setItem;
  target.setItem = (key, value) => { write(key, value); if (key === AI_DRAFT_KEY && value === incoming[key]) throw Error('quota after partial write'); };
  assert.throws(() => applyMigrationPreferences(incoming, target), /quota/);
  assert.deepEqual([...target.values], before);
});
