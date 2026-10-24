import { useSyncExternalStore } from 'react';
import core from '../../electron/locales/en-core.json' with { type: 'json' };
import workspace from '../../electron/locales/en-workspace.json' with { type: 'json' };
import tools from '../../electron/locales/en-tools.json' with { type: 'json' };
import backend from '../../electron/locales/en-backend.json' with { type: 'json' };
import twCore from '../../electron/locales/tw-core.json' with { type: 'json' };
import twWorkspace from '../../electron/locales/tw-workspace.json' with { type: 'json' };
import twTools from '../../electron/locales/tw-tools.json' with { type: 'json' };
import twBackend from '../../electron/locales/tw-backend.json' with { type: 'json' };
import jaCore from '../../electron/locales/ja-core.json' with { type: 'json' };
import jaWorkspace from '../../electron/locales/ja-workspace.json' with { type: 'json' };
import jaTools from '../../electron/locales/ja-tools.json' with { type: 'json' };
import jaBackend from '../../electron/locales/ja-backend.json' with { type: 'json' };
import koCore from '../../electron/locales/ko-core.json' with { type: 'json' };
import koWorkspace from '../../electron/locales/ko-workspace.json' with { type: 'json' };
import koTools from '../../electron/locales/ko-tools.json' with { type: 'json' };
import koBackend from '../../electron/locales/ko-backend.json' with { type: 'json' };
import { createLanguageStore, DEFAULT_LOCALE } from './localeStore.js';
import { createMessageTranslator } from './messageCatalog.js';

const entries = (...domains) => domains.flatMap(domain => Object.entries(domain));
const translate = createMessageTranslator({
  'en-US': entries(backend, tools, workspace, core),
  'zh-TW': entries(twBackend, twTools, twWorkspace, twCore),
  'ja-JP': entries(jaBackend, jaTools, jaWorkspace, jaCore),
  'ko-KR': entries(koBackend, koTools, koWorkspace, koCore),
});
const store = createLanguageStore({ api: globalThis.window?.electronAPI, storage: globalThis.localStorage });
export const getLocale = store.getLocale;
export const getLanguageSelectionPending = store.getLanguageSelectionPending;
export async function initializeLanguage() {
  const locale = await store.initialize();
  if (globalThis.document) globalThis.document.documentElement.lang = locale;
  return locale;
}
export const setLanguage = store.setLanguage;
store.subscribe(() => { if (globalThis.document) globalThis.document.documentElement.lang = getLocale(); });

export function useLocale() {
  return useSyncExternalStore(store.subscribe, store.getLocale, () => DEFAULT_LOCALE);
}

export function useLanguageSelectionPending() {
  return useSyncExternalStore(store.subscribe, store.getLanguageSelectionPending, () => false);
}

// Only callers designate application-owned messages. Parameters are never translated.
export function tr(source, params = {}, locale = getLocale()) {
  return translate(source, params, locale);
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

export function formatDateTime(value, options = { dateStyle: 'short', timeStyle: 'medium' }) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), options).format(date);
}
