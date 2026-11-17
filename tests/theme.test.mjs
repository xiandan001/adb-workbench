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

test('graphite is an additional explicitly dark green-accented theme without changing existing built-ins', () => {
  assert.deepEqual(Object.keys(themes).sort(), ['default', 'cute', 'tech', 'ocean', 'forest', 'sunset', 'graphite'].sort());
  assert.equal(themes.graphite.isDark, true); assert.equal(themes.graphite.primary, 'emerald'); assert.equal(isDarkTheme(themes.graphite), true);
  assert.equal(themes.graphite.name, '中性深色'); assert.equal(themes.default.card, 'bg-white border-slate-200');
  assert.equal(themes.tech.primary, 'cyan'); assert.equal(themes.tech.card, 'bg-slate-800/80 border-[#3E4145]');
});
