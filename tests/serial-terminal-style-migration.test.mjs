import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { collectMigrationPreferences, applyMigrationPreferences, PORTABLE_PREF_KEYS } from '../src/shared/dataMigrationStorage.js';
import { restoreStartupData } from '../src/shared/dataMigrationBootstrap.js';
import { SERIAL_TERMINAL_STYLE_KEY, readSerialTerminalStyle } from '../src/shared/serialTerminalStyle.js';
const require = createRequire(import.meta.url);
const policy = require('../electron/lib/data-migration-policy.cjs');
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('renderer and main export/import only the visual terminal style and agree on its allowlist', () => {
  assert.deepEqual(PORTABLE_PREF_KEYS, policy.PORTABLE_PREF_KEYS);
  for (const style of ['current', 'classic']) {
    const source = storage({ [SERIAL_TERMINAL_STYLE_KEY]: JSON.stringify(style), 'serial-enter': 'lf', 'serial-localEcho': 'true', 'serial-current-port': 'COM55', 'serial-draft': 'must not send' });
    const exported = collectMigrationPreferences(source);
    assert.deepEqual(exported, { [SERIAL_TERMINAL_STYLE_KEY]: JSON.stringify(style) });
    const target = storage({ 'serial-current-port': 'COM99', 'serial-draft': 'keep local', unrelated: 'keep' });
    applyMigrationPreferences(policy.normalizePreferences(exported), target);
    assert.equal(readSerialTerminalStyle(target), style); assert.equal(target.getItem('serial-current-port'), 'COM99');
    assert.equal(target.getItem('serial-draft'), 'keep local'); assert.equal(target.getItem('serial-enter'), null);
    assert.equal(target.getItem('serial-localEcho'), null); assert.equal(target.getItem('unrelated'), 'keep');
  }
});

test('legacy backups without a style retain the target choice instead of silently resetting or deleting it', () => {
  const target = storage({ [SERIAL_TERMINAL_STYLE_KEY]: '"classic"', currentTheme: 'default' });
  applyMigrationPreferences(policy.normalizePreferences({ currentTheme: 'tech' }), target);
  assert.equal(readSerialTerminalStyle(target), 'classic'); assert.equal(target.getItem('currentTheme'), 'tech');
  const emptyTarget = storage(); applyMigrationPreferences(policy.normalizePreferences({ currentTheme: 'default' }), emptyTarget);
  assert.equal(readSerialTerminalStyle(emptyTarget), 'current'); assert.equal(emptyTarget.getItem(SERIAL_TERMINAL_STYLE_KEY), null);
});

test('invalid migrated styles are rejected by both layers before overwriting any good preference', () => {
  const target = storage({ [SERIAL_TERMINAL_STYLE_KEY]: '"classic"', currentTheme: 'default' });
  for (const raw of ['"CLASSIC"', '"future"', '{}', 'null', 'false', '["classic"]', '{"style":"classic","enter":"lf"}', `${' '.repeat(65)}"classic"`]) {
    const values = { currentTheme: 'tech', [SERIAL_TERMINAL_STYLE_KEY]: raw };
    assert.throws(() => policy.normalizePreferences(values)); assert.throws(() => applyMigrationPreferences(values, target));
    assert.equal(target.getItem('currentTheme'), 'default'); assert.equal(readSerialTerminalStyle(target), 'classic');
    assert.throws(() => collectMigrationPreferences(storage({ [SERIAL_TERMINAL_STYLE_KEY]: raw })));
  }
});

test('style storage failure rolls back earlier migration preferences while preserving the previous style', () => {
  const target = storage({ [SERIAL_TERMINAL_STYLE_KEY]: '"classic"', currentTheme: 'default' }); const write = target.setItem;
  target.setItem = (key, value) => { if (key === SERIAL_TERMINAL_STYLE_KEY) throw Error('fixture quota'); write(key, value); };
  assert.throws(() => applyMigrationPreferences({ currentTheme: 'tech', [SERIAL_TERMINAL_STYLE_KEY]: '"current"' }, target), /quota/);
  assert.equal(target.getItem('currentTheme'), 'default'); assert.equal(readSerialTerminalStyle(target), 'classic');
});

test('startup migration restores style before acknowledgement without invoking a serial backend', async () => {
  const target = storage(); const calls = [];
  const api = { migrationBootstrap: async () => ({ ok: true, id: 'style-fixture', preferences: { [SERIAL_TERMINAL_STYLE_KEY]: '"classic"' } }),
    migrationAcknowledge: async () => { calls.push('ack'); assert.equal(readSerialTerminalStyle(target), 'classic'); return { ok: true }; },
    serialConnect: () => { throw Error('must not connect'); }, serialTerminalWrite: () => { throw Error('must not send'); },
  };
  await restoreStartupData(api, target); assert.deepEqual(calls, ['ack']); assert.equal(readSerialTerminalStyle(target), 'classic');
});
