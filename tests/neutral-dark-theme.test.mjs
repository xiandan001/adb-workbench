import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import themes from '../src/data/themes.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
import { readLogWindowThemeKey, resolveLogWindowTheme } from '../src/shared/logWindowTheme.js';

const require = createRequire(import.meta.url);
const backend = require('../electron/lib/data-migration-policy.cjs');
const documentFixture = initial => {
  const values = new Map(initial ? [['data-workbench-theme', initial]] : []);
  return { documentElement: { getAttribute: key => values.get(key) ?? null, setAttribute: (key, value) => values.set(key, value), removeAttribute: key => values.delete(key) }, values };
};
const scopeModule = () => import('../src/shared/neutralDarkScope.js');

test('neutral scope is opt-in to the actual built-in, releases on switch and never writes preferences', async () => {
  const { applyThemeScope } = await scopeModule(), document = documentFixture();
  const release = applyThemeScope(themes.graphite, document); assert.equal(document.values.get('data-workbench-theme'), 'graphite');
  release(); assert.equal(document.values.has('data-workbench-theme'), false);
  for (const theme of [themes.default, themes.tech, { ...themes.graphite, isCustom: true }]) {
    const stop = applyThemeScope(theme, document); assert.equal(document.values.has('data-workbench-theme'), false); stop();
  }
});

test('scope cleanup restores the original attribute and an old owner cannot clear a newer scope', async () => {
  const { applyThemeScope } = await scopeModule(), document = documentFixture('external');
  const old = applyThemeScope(themes.graphite, document), current = applyThemeScope(themes.default, document);
  old(); assert.equal(document.values.has('data-workbench-theme'), false);
  current(); assert.equal(document.values.get('data-workbench-theme'), 'external');
  const release = applyThemeScope(themes.graphite, document); document.documentElement.setAttribute('data-workbench-theme', 'another-owner');
  release(); assert.equal(document.values.get('data-workbench-theme'), 'another-owner');
});

test('the real layout hook applies and releases the document scope by the resolved theme identity', async () => {
  const { applyThemeScope } = await scopeModule(), document = documentFixture(), effects = [];
  const source = fs.readFileSync(new URL('../src/shared/useThemeScope.js', import.meta.url), 'utf8').replace(/^import .+;\n/gm, '').replace('export default function', 'function');
  const hook = vm.runInNewContext(source + '\nuseThemeScope', { useLayoutEffect: (callback, dependencies) => effects.push({ callback, dependencies }), applyThemeScope: theme => applyThemeScope(theme, document) });
  hook(themes.graphite); assert.equal(effects[0].dependencies[0], themes.graphite); const release = effects[0].callback();
  assert.equal(document.values.get('data-workbench-theme'), 'graphite'); release(); assert.equal(document.values.has('data-workbench-theme'), false);
});

test('graphite text and brand action colors have readable contrast without changing semantic colors', () => {
  const luminance = hex => hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a, b) => { const left = luminance(a), right = luminance(b); return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05); };
  const color = (classes, prefix) => classes.match(new RegExp('(?:^| )' + prefix + '-\\[#([a-f0-9]{6})\\]', 'i'))?.[1];
  const theme = themes.graphite;
  assert.ok(contrast(color(theme.text, 'text'), color(theme.card, 'bg')) >= 4.5);
  assert.ok(contrast(color(theme.textMuted, 'text'), color(theme.card, 'bg')) >= 4.5);
  assert.ok(contrast(color(theme.input, 'placeholder'), color(theme.input, 'bg')) >= 4.5);
  assert.ok(contrast(color(theme.button.primary, 'text'), color(theme.button.primary, 'bg')) >= 4.5);
});

test('graphite reuses the portable currentTheme key and leaves the old default and unrelated values intact', () => {
  const values = new Map([['currentTheme', 'graphite'], ['unrelated', 'keep']]), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.deepEqual(collectMigrationPreferences(storage), { currentTheme: 'graphite' });
  assert.deepEqual(backend.normalizePreferences({ currentTheme: 'graphite' }), { currentTheme: 'graphite' });
  applyMigrationPreferences({ currentTheme: 'default' }, storage); assert.equal(values.get('currentTheme'), 'default'); assert.equal(values.get('unrelated'), 'keep');
  values.set('currentTheme', 'graphite'); assert.equal(resolveLogWindowTheme(readLogWindowThemeKey(storage)), themes.graphite);
});

test('the neutral CSS is document scoped, excludes preserved previews/classic terminals/media and never filters pixels', () => {
  const css = fs.readFileSync(new URL('../src/styles/neutralDark.css', import.meta.url), 'utf8');
  const postcss = require('postcss'); postcss.parse(css).walkRules(rule => {
    if (['html[data-workbench-theme="graphite"]', 'html[data-workbench-theme="graphite"] body'].includes(rule.selector)) return;
    assert.equal(rule.parent.type, 'atrule'); assert.equal(rule.parent.name, 'scope'); assert.match(rule.parent.params, /^\(html\[data-workbench-theme="graphite"\]\)/);
  });
  assert.match(css, /data-theme-preserve/); assert.match(css, /\.xterm/); assert.match(css, /0d1117/); assert.match(css, /canvas/);
  assert.doesNotMatch(css, /(?:^|[;{\s])(?:filter|opacity)\s*:/); assert.doesNotMatch(css, /(?:bg|text)-(?:red|amber|emerald|green)-/);
});

test('main app and standalone log window both connect the same resolved-theme scope without selecting it automatically', () => {
  for (const file of ['../src/App.jsx', '../src/components/LogWindowApp.jsx']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8'); assert.match(source, /useThemeScope\(theme\)/);
  }
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'); assert.match(app, /readMigratedPreference\('currentTheme', 'default'\)/);
  assert.match(app, /data-theme-preserve/); assert.doesNotMatch(app, /setCurrentTheme\(['"]graphite['"]\)/);
});

test('actual log-window refresh follows storage/focus and the real custom-theme response envelope', async () => {
  const { applyThemeScope } = await scopeModule(), document = documentFixture(), listeners = new Map(), slots = [];
  const custom = { key: 'custom_fixture', card: 'bg-black', primary: 'pink', isCustom: true }, legacy = { ...custom, key: 'custom_legacy' };
  let response = { success: true, data: [custom] };
  let key = 'graphite', cursor = 0, changed = false, mounted = false, cleanup, scopeCleanup, scopedTheme, theme, loads = 0;
  const source = fs.readFileSync(new URL('../src/components/LogWindowApp.jsx', import.meta.url), 'utf8').replace(/^import .+;\n/gm, '')
    .replace('export default function', 'function').replace(/return <LogAnalyzer[^;]+;/, 'return theme;');
  const component = vm.runInNewContext(source + '\nLogWindowApp', {
    window: { electronAPI: { loadCustomThemes: async () => { loads++; return response; } }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    readLogWindowThemeKey: () => key, resolveLogWindowTheme,
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { if (!Object.is(value, slots[index].value)) { slots[index].value = value; changed = true; } }]; },
    useEffect(callback) { if (!mounted) { mounted = true; cleanup = callback(); } },
    useThemeScope(value) { if (scopedTheme !== value) { scopeCleanup?.(); scopeCleanup = applyThemeScope(value, document); scopedTheme = value; } },
  });
  const render = () => { cursor = 0; theme = component(); };
  const settle = async () => { for (let i = 0; i < 5; i++) { changed = false; render(); await new Promise(resolve => setImmediate(resolve)); if (!changed) return; } assert.fail('Log theme refresh did not settle'); };
  try {
    await settle(); assert.equal(theme, themes.graphite); assert.equal(document.values.get('data-workbench-theme'), 'graphite');
    key = custom.key; listeners.get('storage')({ key: 'currentTheme' }); await settle(); assert.equal(theme, custom); assert.equal(document.values.has('data-workbench-theme'), false);
    response = { success: false, data: [] }; listeners.get('focus')(); await settle(); assert.equal(theme, custom, 'A failed theme read cannot replace the last successful custom theme');
    response = [legacy]; key = legacy.key; listeners.get('focus')(); await settle(); assert.equal(theme, legacy, 'Legacy array IPC remains compatible');
    key = 'default'; listeners.get('focus')(); await settle(); assert.equal(theme, themes.default);
    key = 'graphite'; listeners.get('storage')({ key: 'currentTheme' }); await settle(); assert.equal(theme, themes.graphite);
    const before = loads; listeners.get('storage')({ key: 'unrelated' }); await settle(); assert.equal(loads, before);
  } finally { cleanup?.(); scopeCleanup?.(); }
  assert.equal(listeners.size, 0); assert.equal(document.values.has('data-workbench-theme'), false);
});
