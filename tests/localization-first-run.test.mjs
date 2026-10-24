import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createLanguageStore } from '../src/shared/localeStore.js';

test('first choice is observable, same-locale confirmation calls IPC and only its successful reply clears pending', async () => {
  const calls = []; let notify; let complete; let changes = 0;
  const store = createLanguageStore({ api: { initialLanguage: 'ja-JP', initialLanguagePending: true,
    onLanguageChanged: callback => { notify = callback; return () => {}; },
    languageGet: async () => ({ success: true, locale: 'ja-JP', languageSelectionPending: true }),
    languageSet: args => { calls.push(args); return new Promise(resolve => { complete = resolve; }); } } });
  store.subscribe(() => changes++); await store.initialize(); assert.equal(store.getLanguageSelectionPending(), true);
  const pending = store.setLanguage('ja-JP'); assert.deepEqual(calls, [{ locale: 'ja-JP' }]);
  assert.equal(store.getLanguageSelectionPending(), true);
  notify({ locale: 'ja-JP', languageSelectionPending: false }); complete({ success: true, locale: 'ja-JP', languageSelectionPending: false }); await pending;
  assert.equal(store.getLanguageSelectionPending(), false); assert.equal(changes, 1);
  await store.setLanguage('ja-JP'); assert.equal(calls.length, 1); store.dispose();
});

test('failed or incomplete first-choice acknowledgement keeps the dialog pending and never invents success', async () => {
  for (const response of [{ success: false, error: { message: 'fixture failure' } }, { success: true, locale: 'en-US' }]) {
    const store = createLanguageStore({ api: { initialLanguage: 'zh-CN', initialLanguagePending: true, languageSet: async () => response } });
    await assert.rejects(store.setLanguage('en-US'));
    assert.equal(store.getLanguageSelectionPending(), true); assert.equal(store.getLocale(), 'zh-CN');
  }
  const noApi = createLanguageStore({ api: { initialLanguagePending: true } });
  await assert.rejects(noApi.setLanguage('zh-CN')); assert.equal(noApi.getLanguageSelectionPending(), true);
});

test('late initial snapshots cannot reopen a completed selection or overwrite a newer broadcast', async () => {
  let notify; let resolve;
  const store = createLanguageStore({ api: { initialLanguage: 'zh-CN', initialLanguagePending: true,
    onLanguageChanged: callback => { notify = callback; return () => {}; }, languageGet: () => new Promise(done => { resolve = done; }) } });
  const loading = store.initialize(); notify({ locale: 'ko-KR', languageSelectionPending: false });
  resolve({ success: true, locale: 'zh-CN', languageSelectionPending: true }); await loading;
  assert.equal(store.getLocale(), 'ko-KR'); assert.equal(store.getLanguageSelectionPending(), false); store.dispose();
});

test('App waits for language selection before consuming changelog or marking a version as seen', async () => {
  const require = createRequire(import.meta.url); const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'); let effect;
  require('@babel/traverse').default(require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
    if (node.callee.name === 'useEffect' && source.slice(node.arguments[0].start, node.arguments[0].end).includes('checkChangelog')) effect = node;
  } });
  assert.ok(effect); assert.ok(effect.arguments[1].elements.some(node => node.name === 'languageSelectionPending'));
  const calls = []; const updates = [];
  const scope = { languageSelectionPending: true, window: { electronAPI: { getVersion: async () => { calls.push('version'); return '4.7.3'; }, checkChangelog: async () => { calls.push('changelog'); return { needsShow: true, version: '4.7.3' }; } } },
    localStorage: { getItem: () => null, setItem: (...args) => calls.push(args) }, getChangelog: () => ({ title: 'selected locale' }),
    setAppVersion() {}, setChangelogContent: value => updates.push(value), setShowChangelog: value => updates.push(value), console };
  const run = runInNewContext(`(${source.slice(effect.arguments[0].start, effect.arguments[0].end)})`, scope);
  run(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, []);
  scope.languageSelectionPending = false; const cleanup = run(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['version', 'changelog', ['lastAppVersion', '4.7.3']]); assert.equal(updates.at(-1), true); cleanup?.();
});

test('initial language dialog uses native-language options, modal focus containment and explicit confirmation', () => {
  const source = fs.readFileSync(new URL('../src/components/InitialLanguageDialog.jsx', import.meta.url), 'utf8');
  for (const label of ['简体中文', '繁體中文', 'English', '日本語', '한국어']) assert.ok(source.includes(label));
  assert.match(source, /showModal\(\)/); assert.match(source, /onKeyDown=\{trapAppMessageFocus\}/);
  assert.match(source, /onCancel=\{event => event\.preventDefault\(\)\}/);
  assert.match(source, /type="radio"/); assert.match(source, /type="submit"/);
  assert.match(source, /await setLanguage\(selected\)/); assert.doesNotMatch(source, /location\.reload|languageSelectionPending\s*=|localStorage/);
});
