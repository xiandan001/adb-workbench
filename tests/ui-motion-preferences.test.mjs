import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { UI_MOTION_PREFS_KEY, normalizeUiMotionPreferences, readUiMotionPreferences, saveUiMotionPreferences, applyUiMotionPreferences } from '../src/shared/uiMotionPreferences.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url);
const policy = require('../electron/lib/data-migration-policy.cjs');
const storage = (raw = null) => ({ raw, getItem(key) { return key === UI_MOTION_PREFS_KEY ? this.raw : null; }, setItem(key, value) { assert.equal(key, UI_MOTION_PREFS_KEY); this.raw = value; } });

test('motion defaults are reduced off / startup on and only strict visual flags can be persisted', () => {
  const saved = storage(); assert.deepEqual(readUiMotionPreferences(saved), { version: 1, reducedMotion: false, startupAnimation: true }); assert.equal(saved.raw, null);
  const value = { version: 1, reducedMotion: true, startupAnimation: false };
  saveUiMotionPreferences(value, saved); assert.deepEqual(readUiMotionPreferences(saved), value);
  for (const invalid of [{ ...value, version: 2 }, { ...value, startAtLogin: true }, { ...value, reducedMotion: 1 }, null]) assert.throws(() => normalizeUiMotionPreferences(invalid));
  const corrupt = storage('{not json'); assert.throws(() => readUiMotionPreferences(corrupt)); assert.equal(corrupt.raw, '{not json');
  saveUiMotionPreferences(value, corrupt); assert.deepEqual(readUiMotionPreferences(corrupt), value);
  assert.throws(() => saveUiMotionPreferences(value, { setItem() { throw Error('full'); } }), /保存失败/);
});

test('motion changes apply immediately and never override system reduced-motion accessibility', () => {
  const target = { dataset: {} };
  applyUiMotionPreferences({ version: 1, reducedMotion: true, startupAnimation: false }, target, false);
  assert.deepEqual(target.dataset, { reducedMotion: 'true', startupAnimation: 'false' });
  applyUiMotionPreferences({ version: 1, reducedMotion: false, startupAnimation: true }, target, true);
  assert.equal(target.dataset.reducedMotion, 'true');
  applyUiMotionPreferences({ version: 1, reducedMotion: false, startupAnimation: true }, target, false);
  assert.equal(target.dataset.reducedMotion, 'false');
});

test('pre-style startup preference script agrees with React defaults and avoids writes or a disabled-animation flash', () => {
  const code = readFileSync(new URL('../public/startup-preferences.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/startup-preferences.js') < html.indexOf('/startup.css'));
  for (const raw of [null, JSON.stringify({ version: 1, reducedMotion: true, startupAnimation: false }), '{bad', '{"version":1}', 'x'.repeat(257)]) {
    const document = { documentElement: { dataset: {} } };
    const saved = storage(raw);
    runInNewContext(code, { window: { localStorage: saved, matchMedia: () => ({ matches: false }) }, document });
    let expected = { version: 1, reducedMotion: false, startupAnimation: true };
    try { expected = readUiMotionPreferences(saved); } catch { /* Runtime preserves defaults when settings are corrupt. */ }
    assert.equal(document.documentElement.dataset.reducedMotion, String(expected.reducedMotion));
    assert.equal(document.documentElement.dataset.startupAnimation, String(expected.startupAnimation)); assert.equal(saved.raw, raw);
  }
});

test('visual settings migrate through both layers; native login startup remains machine-local', () => {
  const value = { version: 1, reducedMotion: true, startupAnimation: false }; const original = storage(JSON.stringify(value));
  const exported = policy.normalizePreferences(collectMigrationPreferences(original));
  const target = storage(); applyMigrationPreferences(exported, target); assert.deepEqual(readUiMotionPreferences(target), value);
  assert.equal(policy.PORTABLE_PREF_KEYS.includes('startAtLogin'), false); assert.equal(policy.isAllowedFile('startup-preferences.json'), false);
  for (const raw of [JSON.stringify({ ...value, reducedMotion: 2 }), JSON.stringify({ ...value, startAtLogin: true }), ' '.repeat(257) + JSON.stringify(value)]) {
    assert.throws(() => policy.normalizePreferences({ [UI_MOTION_PREFS_KEY]: raw }));
    assert.throws(() => applyMigrationPreferences({ [UI_MOTION_PREFS_KEY]: raw }, target));
    assert.deepEqual(readUiMotionPreferences(target), value);
  }
});

test('early preferences send only effective visual flags to the native bridge without exposing or writing stored contents', () => {
  const code = readFileSync(new URL('../public/startup-preferences.js', import.meta.url), 'utf8');
  for (const [raw, system, expected] of [
    [null, false, { startupAnimation: true, reducedMotion: false }],
    [null, true, { startupAnimation: true, reducedMotion: true }],
    [JSON.stringify({ version: 1, reducedMotion: true, startupAnimation: false }), false, { startupAnimation: false, reducedMotion: true }],
    ['{"private":"DO_NOT_SEND"}', false, { startupAnimation: true, reducedMotion: false }],
  ]) {
    const saved = storage(raw); const document = { documentElement: { dataset: {} } }; const sent = [];
    runInNewContext(code, { document, window: { localStorage: saved, matchMedia: () => ({ matches: system }), electronAPI: {
      startupPresentationPreferences: value => sent.push(JSON.parse(JSON.stringify(value))), startupPresentationReady() {}, startupPresentationFailed() {},
    } } });
    assert.deepEqual(sent, [expected]); assert.equal(document.documentElement.dataset.nativeDesktop, 'true'); assert.equal(saved.raw, raw);
    assert.ok(!JSON.stringify(sent).includes('DO_NOT_SEND'));
  }
});

test('browser and incomplete/throwing native bridges keep safe visual defaults and do not write preferences', () => {
  const code = readFileSync(new URL('../public/startup-preferences.js', import.meta.url), 'utf8');
  for (const electronAPI of [undefined, {}, { startupPresentationPreferences() { throw Error('incomplete'); } }, {
    startupPresentationPreferences() { throw Error('disconnected'); }, startupPresentationReady() {}, startupPresentationFailed() {},
  }]) {
    const saved = storage(); const document = { documentElement: { dataset: {} } };
    assert.doesNotThrow(() => runInNewContext(code, { document, window: { localStorage: saved, matchMedia: () => ({ matches: false }), electronAPI } }));
    assert.equal(document.documentElement.dataset.startupAnimation, 'true'); assert.equal(saved.raw, null);
    assert.equal(document.documentElement.dataset.nativeDesktop === 'true', Boolean(electronAPI?.startupPresentationReady));
  }
});

test('global motion lifecycle reacts to saves, other-window storage and system changes, then cleans up', () => {
  const source = readFileSync(new URL('../src/components/UiMotionPreferences.jsx', import.meta.url), 'utf8');
  let effect;
  require('@babel/traverse').default(require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    CallExpression({ node }) { if (node.callee.name === 'useLayoutEffect') effect = node.arguments[0]; },
  });
  const listeners = new Map(); const target = { dataset: {} }; let preferences = { version: 1, reducedMotion: false, startupAnimation: true };
  const media = { matches: false, addEventListener: (name, fn) => listeners.set('media:' + name, fn), removeEventListener: name => listeners.delete('media:' + name) };
  const cleanup = runInNewContext('(' + source.slice(effect.start, effect.end) + ')', {
    window: { matchMedia: () => media, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { documentElement: target }, UI_MOTION_PREFS_KEY, UI_MOTION_CHANGED: 'workbench:motion-preferences-changed',
    applyUiMotionPreferences, defaultUiMotionPreferences: () => ({ version: 1, reducedMotion: false, startupAnimation: true }), readUiMotionPreferences: () => preferences,
  })();
  assert.equal(target.dataset.reducedMotion, 'false');
  preferences = { version: 1, reducedMotion: true, startupAnimation: false }; listeners.get('workbench:motion-preferences-changed')();
  assert.deepEqual(target.dataset, { reducedMotion: 'true', startupAnimation: 'false' });
  preferences = { version: 1, reducedMotion: false, startupAnimation: true }; listeners.get('storage')({ key: UI_MOTION_PREFS_KEY });
  assert.equal(target.dataset.reducedMotion, 'false'); media.matches = true; listeners.get('media:change')(); assert.equal(target.dataset.reducedMotion, 'true');
  cleanup(); assert.equal(listeners.size, 0);
});
