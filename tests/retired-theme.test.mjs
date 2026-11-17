import test from 'node:test';
import assert from 'node:assert/strict';
import themes from '../src/data/themes.js';
import * as themePolicy from '../src/shared/theme.js';
import { readLogWindowThemeKey, resolveLogWindowTheme } from '../src/shared/logWindowTheme.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';

test('Future Tech is not selectable, while the six remaining built-ins are intact', () => {
  assert.equal(Object.hasOwn(themes, 'tech'), false);
  assert.deepEqual(Object.keys(themes).sort(), ['default', 'cute', 'ocean', 'forest', 'graphite', 'sunset'].sort());
});

test('retired built-in key resolves to the same graphite object without rewriting storage', () => {
  const values = new Map([['currentTheme', 'tech'], ['unrelated', 'keep']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(themePolicy.resolveThemeKey('tech', []), 'graphite');
  assert.equal(resolveLogWindowTheme(readLogWindowThemeKey(storage)), themes.graphite);
  assert.equal(storage.getItem('currentTheme'), 'tech'); assert.equal(storage.getItem('unrelated'), 'keep');
  assert.equal(themePolicy.isDarkTheme({ primary: 'tech' }), true, 'The internal dark sentinel is not the retired built-in option');
});

test('existing custom tech keys and custom display names take priority over the retired built-in alias', () => {
  const custom = { key: 'tech', name: 'My existing theme', card: 'bg-pink-50', primary: 'pink' };
  assert.equal(themePolicy.resolveThemeKey('tech', [custom]), 'tech');
  assert.equal(resolveLogWindowTheme('tech', [custom]), custom);
  const named = { ...custom, key: 'custom_existing', name: '科技未来' };
  assert.equal(themePolicy.resolveThemeKey(named.key, [named]), named.key);
  assert.equal(resolveLogWindowTheme(named.key, [named]), named);
  assert.equal(themePolicy.resolveThemeKey('default', []), 'default');
});

test('missing and invalid standalone theme keys fall back to graphite without touching saved data', () => {
  assert.equal(readLogWindowThemeKey({ getItem: () => null }), 'graphite');
  assert.equal(readLogWindowThemeKey({ getItem: () => '{bad' }), 'graphite');
  assert.equal(readLogWindowThemeKey({ getItem: () => { throw Error('blocked'); } }), 'graphite');
  assert.equal(resolveLogWindowTheme('constructor'), themes.graphite);
});

test('legacy theme preferences still round-trip backup without forced canonicalization', () => {
  const values = new Map([['currentTheme', 'tech']]), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const exported = collectMigrationPreferences(storage); assert.deepEqual(exported, { currentTheme: 'tech' });
  values.set('currentTheme', 'default'); applyMigrationPreferences(exported, storage);
  assert.equal(storage.getItem('currentTheme'), 'tech');
  assert.equal(resolveLogWindowTheme(readLogWindowThemeKey(storage)), themes.graphite);
});
