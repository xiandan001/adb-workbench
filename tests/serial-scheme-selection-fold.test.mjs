import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SERIAL_SCHEME_SELECTION_KEY, normalizeSerialSchemeSelection, readSerialSchemeSelection, saveSerialSchemeSelection, resetSerialSchemeSelection } from '../src/shared/serialSchemeConnection.js';
import { applyMigrationPreferences, collectMigrationPreferences } from '../src/shared/dataMigrationStorage.js';

const require = createRequire(import.meta.url), backend = require('../electron/lib/ux-metadata-policy.cjs'), policy = require('../electron/lib/data-migration-policy.cjs');
const legacy = () => ({ version: 1, rs232: 'saved-rs232', terminal: 'saved-terminal' });
const canonical = value => ({ ...value, rs232Expanded: false, terminalExpanded: false });
function storage(raw = null) {
  const values = new Map(raw == null ? [] : [[SERIAL_SCHEME_SELECTION_KEY, raw]]), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push([key, value]); values.set(key, value); }, removeItem: key => values.delete(key) };
}

test('both serial disclosures default collapsed and old selected IDs load without rewriting bytes', () => {
  const empty = storage(); assert.deepEqual(readSerialSchemeSelection(empty), canonical({ version: 1, rs232: '', terminal: '' }));
  assert.deepEqual(empty.writes, []);
  const raw = JSON.stringify(legacy(), null, 2) + '\n', saved = storage(raw);
  assert.deepEqual(readSerialSchemeSelection(saved), canonical(legacy())); assert.equal(saved.getItem(SERIAL_SCHEME_SELECTION_KEY), raw); assert.deepEqual(saved.writes, []);
  assert.deepEqual(normalizeSerialSchemeSelection(legacy()), backend.normalizeSerialSchemeSelection(legacy()));
  assert.deepEqual(resetSerialSchemeSelection(saved), canonical({ version: 1, rs232: '', terminal: '' }));
});

test('workspace fold choices survive saves and restart without replacing the other workspace selection', () => {
  const saved = storage(); saveSerialSchemeSelection({ ...legacy(), rs232Expanded: true }, saved);
  let current = readSerialSchemeSelection(saved); assert.equal(current.rs232Expanded, true); assert.equal(current.terminalExpanded, false);
  current = saveSerialSchemeSelection({ ...current, terminalExpanded: true, rs232: 'chosen-later' }, saved);
  assert.equal(current.terminal, 'saved-terminal'); assert.equal(current.rs232Expanded, true);
  assert.deepEqual(readSerialSchemeSelection(saved), current); assert.deepEqual(backend.normalizeSerialSchemeSelection(current), current);
  assert.deepEqual(Object.keys(current), ['version', 'rs232', 'terminal', 'rs232Expanded', 'terminalExpanded']);
});

test('only exact optional booleans are accepted with the original required fields and identity limits', () => {
  for (const field of ['rs232Expanded', 'terminalExpanded']) for (const value of [undefined, null, 0, 1, 'false', [], {}]) {
    const invalid = { ...legacy(), [field]: value };
    assert.throws(() => normalizeSerialSchemeSelection(invalid)); assert.throws(() => backend.normalizeSerialSchemeSelection(invalid));
  }
  for (const invalid of [{ version: 1, terminal: '' }, { rs232: '', terminal: '' }, { ...legacy(), version: 2 }, { ...legacy(), port: 'COM1' },
    { ...legacy(), autoConnect: true }, { ...legacy(), rs232: 'x'.repeat(201) }, { ...legacy(), terminal: 'bad\n' },
    Object.assign(Object.create({ inherited: true }), legacy())]) {
    assert.throws(() => normalizeSerialSchemeSelection(invalid)); assert.throws(() => backend.normalizeSerialSchemeSelection(invalid));
  }
});

test('corrupt and over-budget bytes are preserved and a failed fold save does not replace persisted choices', () => {
  for (const raw of ['{broken original', JSON.stringify(legacy()) + ' '.repeat(2048)]) {
    const original = storage(raw); assert.throws(() => readSerialSchemeSelection(original));
    assert.throws(() => saveSerialSchemeSelection({ ...legacy(), rs232Expanded: true }, original));
    assert.equal(original.getItem(SERIAL_SCHEME_SELECTION_KEY), raw); assert.deepEqual(original.writes, []);
  }
  const original = storage(JSON.stringify({ ...legacy(), terminalExpanded: true })), raw = original.getItem(SERIAL_SCHEME_SELECTION_KEY);
  original.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveSerialSchemeSelection({ ...readSerialSchemeSelection(original), rs232Expanded: true }, original), /quota/);
  assert.equal(original.getItem(SERIAL_SCHEME_SELECTION_KEY), raw); assert.equal(readSerialSchemeSelection(original).rs232Expanded, false);
  assert.equal(readSerialSchemeSelection(original).terminalExpanded, true);
});

test('backup preserves both folds with strict backend parity and import failure rolls back exact original bytes', () => {
  const value = { ...legacy(), rs232Expanded: true, terminalExpanded: false }, raw = JSON.stringify(value), original = storage(raw);
  const backup = collectMigrationPreferences(original), normalized = policy.normalizePreferences(backup), restored = storage();
  applyMigrationPreferences(normalized, restored); assert.deepEqual(readSerialSchemeSelection(restored), value);
  const budget = JSON.stringify(legacy()), exact = budget + ' '.repeat(2048 - budget.length);
  assert.doesNotThrow(() => collectMigrationPreferences(storage(exact))); assert.doesNotThrow(() => policy.normalizePreferences({ [SERIAL_SCHEME_SELECTION_KEY]: exact }));
  assert.throws(() => collectMigrationPreferences(storage(exact + ' '))); assert.throws(() => policy.normalizePreferences({ [SERIAL_SCHEME_SELECTION_KEY]: exact + ' ' }));
  const prior = storage('{corrupt original'); prior.values.set('currentTheme', 'graphite'); const before = [...prior.values], write = prior.setItem;
  prior.setItem = (key, content) => { write.call(prior, key, content); if (key === SERIAL_SCHEME_SELECTION_KEY && content === normalized[key]) throw Error('quota after write'); };
  assert.throws(() => applyMigrationPreferences({ currentTheme: 'default', ...normalized }, prior), /quota/); assert.deepEqual([...prior.values], before);
});
