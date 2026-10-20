import test from 'node:test';
import assert from 'node:assert/strict';
import themes from '../src/data/themes.js';
import { isDarkTheme } from '../src/shared/theme.js';

test('built-in dark theme is detected by its surface, not its accent name', () => {
  assert.equal(isDarkTheme(themes.tech), true);
  for (const key of ['default', 'cute', 'ocean', 'forest', 'sunset']) assert.equal(isDarkTheme(themes[key]), false);
});

test('custom surfaces and explicit overrides keep independent accent colors', () => {
  assert.equal(isDarkTheme({ primary: 'cyan', card: 'bg-white' }), false);
  assert.equal(isDarkTheme({ primary: 'pink', card: 'bg-slate-900' }), true);
  assert.equal(isDarkTheme({ card: 'bg-[#202124]/90' }), true);
  assert.equal(isDarkTheme({ card: 'bg-gradient-to-br from-slate-800 to-green-900' }), true);
  assert.equal(isDarkTheme({ card: 'bg-black' }), true);
  assert.equal(isDarkTheme({ isDark: false, card: 'bg-slate-800' }), false);
});
