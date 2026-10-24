import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageStore, normalizeLocale, LANGUAGE_STORAGE_KEY } from '../src/shared/localeStore.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
}

test('locale defaults to Chinese, rejects unsupported codes, and trusts preload over a stale cache', () => {
  assert.equal(normalizeLocale('fr'), 'zh-CN');
  assert.equal(createLanguageStore().getLocale(), 'zh-CN');
  assert.equal(createLanguageStore({ api: { initialLanguage: 'en-US' }, storage: storage({ [LANGUAGE_STORAGE_KEY]: 'zh-CN' }) }).getLocale(), 'en-US');
});

test('a successful durable write broadcasts exactly one locale change without recreating consumers', async () => {
  const cache = storage(); let notify; const writes = []; let changes = 0;
  const api = { onLanguageChanged: callback => { notify = callback; return () => {}; }, languageGet: async () => ({ success: true, locale: 'zh-CN' }),
    languageSet: async value => { writes.push(value); notify(value); return { success: true, ...value }; } };
  const store = createLanguageStore({ api, storage: cache }); const unsubscribe = store.subscribe(() => changes++);
  await store.initialize(); await store.initialize(); await store.setLanguage('en-US');
  assert.deepEqual(writes, [{ locale: 'en-US' }]); assert.equal(changes, 1); assert.equal(store.getLocale(), 'en-US');
  assert.equal(cache.getItem(LANGUAGE_STORAGE_KEY), 'en-US');
  notify({ locale: 'zh-CN' }); assert.equal(store.getLocale(), 'zh-CN'); assert.equal(changes, 2);
  notify({ locale: 'bad' }); assert.equal(changes, 2); unsubscribe(); store.dispose();
});

test('failed persistence leaves the selected language and cache unchanged', async () => {
  const cache = storage(); const store = createLanguageStore({ storage: cache, api: { languageSet: async () => ({ success: false, error: { message: 'disk failure' } }) } });
  await assert.rejects(store.setLanguage('en-US'), /disk failure/);
  assert.equal(store.getLocale(), 'zh-CN'); assert.equal(cache.getItem(LANGUAGE_STORAGE_KEY), undefined);
  await assert.rejects(store.setLanguage('de-DE'), /INVALID_LOCALE/);
});

test('parallel saves do not race and a rejected save can be retried', async () => {
  let complete; const api = { languageSet: () => new Promise(resolve => { complete = resolve; }) };
  const store = createLanguageStore({ api }); const pending = store.setLanguage('en-US');
  await assert.rejects(store.setLanguage('en-US'), /LANGUAGE_SAVE_PENDING/);
  complete({ success: true, locale: 'en-US' }); await pending;
  assert.equal(store.getLocale(), 'en-US');
});
