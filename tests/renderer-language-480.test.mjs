import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererLanguage } from '../src/shared/rendererLanguage.js';

function fixture() {
  let locale = 'zh-CN'; const listeners = new Set(), loaded = new Set(['zh-CN']), pending = new Map(), timers = new Set();
  const store = { getLocale: () => locale, getLanguageSelectionPending: () => false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, initialize: async () => locale,
    async setLanguage(next) { locale = next; for (const fn of listeners) fn(); return next; } };
  const catalogs = { has: value => loaded.has(value), load(value) { if (loaded.has(value)) return Promise.resolve(); if (!pending.has(value)) { let resolve, reject; const promise = new Promise((a, b) => { resolve = () => { loaded.add(value); a(); }; reject = b; }); pending.set(value, { promise, resolve, reject }); } return pending.get(value).promise; } };
  const clock = { setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); } };
  const language = createRendererLanguage({ store, catalogs, clock });
  return { language, pending, timers, broadcast: next => store.setLanguage(next), getLocale: () => locale };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('late external language resources cannot replace the latest requested language', async () => {
  const f = fixture(); const off = f.language.subscribe(() => {}); await f.language.initialize();
  await f.broadcast('ja-JP'); await f.broadcast('en-US'); assert.equal(f.language.getLocale(), 'zh-CN');
  f.pending.get('en-US').resolve(); await tick(); assert.equal(f.language.getLocale(), 'en-US');
  f.pending.get('ja-JP').resolve(); await tick(); assert.equal(f.language.getLocale(), 'en-US'); off(); f.language.dispose();
});
test('missing or stalled resources leave a usable language and a retryable notice, without writing preferences', async () => {
  const f = fixture(); await f.language.initialize(); await f.broadcast('ko-KR');
  for (const fn of [...f.timers]) fn(); await tick();
  assert.equal(f.language.getLocale(), 'zh-CN'); assert.equal(f.getLocale(), 'ko-KR'); assert.equal(f.language.getSnapshot().error, 'catalog-unavailable');
  f.pending.get('ko-KR').resolve(); await tick(); assert.equal(f.language.getLocale(), 'ko-KR'); assert.equal(f.language.getSnapshot().error, ''); f.language.dispose();
});
test('an explicit switch loads before persistence and does not overwrite a newer external change', async () => {
  const f = fixture(); await f.language.initialize(); const switching = f.language.setLanguage('en-US');
  assert.equal(f.getLocale(), 'zh-CN'); await f.broadcast('ja-JP');
  f.pending.get('en-US').resolve(); await assert.rejects(switching, /LANGUAGE_CHANGED/);
  assert.equal(f.getLocale(), 'ja-JP'); f.pending.get('ja-JP').resolve(); await tick(); f.language.dispose();
});

test('disposing a language owner before a deferred import resolves prevents a new preference write', async () => {
  const f = fixture(); await f.language.initialize(); const switching = f.language.setLanguage('ja-JP');
  f.language.dispose(); f.pending.get('ja-JP').resolve();
  await assert.rejects(switching, /LANGUAGE_OWNER_CHANGED/); assert.equal(f.getLocale(), 'zh-CN');
});
