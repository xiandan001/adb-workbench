import test from 'node:test';
import assert from 'node:assert/strict';
import { readLogWindowThemeKey, resolveLogWindowTheme } from '../src/shared/logWindowTheme.js';
import { isDarkTheme } from '../src/shared/theme.js';
test('standalone log window follows actual saved light/dark/custom theme without rewriting invalid preferences', () => {
  const storage = { getItem: () => 'default' }; assert.equal(readLogWindowThemeKey(storage), 'default');
  assert.equal(isDarkTheme(resolveLogWindowTheme('default')), false); assert.equal(isDarkTheme(resolveLogWindowTheme('tech')), true);
  const custom = { key: 'my-log-theme', card: 'bg-black', isDark: true };
  assert.equal(resolveLogWindowTheme(custom.key, [custom]), custom);
  assert.equal(isDarkTheme(resolveLogWindowTheme('constructor')), true);
  assert.equal(readLogWindowThemeKey({ getItem: () => '{invalid' }), 'tech');
  assert.equal(readLogWindowThemeKey({ getItem: () => { throw Error('blocked'); } }), 'tech');
});
