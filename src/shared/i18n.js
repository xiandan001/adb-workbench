import { useSyncExternalStore } from 'react';
import { createLanguageStore, DEFAULT_LOCALE } from './localeStore.js';
import { createMessageTranslator } from './messageCatalog.js';
import { createLocaleCatalogLoader } from './localeCatalogLoader.js';
import { languageCatalogs } from './languageCatalogs.js';
import { createRendererLanguage } from './rendererLanguage.js';

const catalogs = createLocaleCatalogLoader({ loaders: languageCatalogs, makeTranslator: createMessageTranslator });
const store = createLanguageStore({ api: globalThis.window?.electronAPI, storage: globalThis.localStorage });
const language = createRendererLanguage({ store, catalogs });
export const getLocale = language.getLocale;
export const getLanguageSelectionPending = () => language.getSnapshot().languageSelectionPending;
export const initializeLanguage = language.initialize;
export const preloadLanguage = catalogs.load;
export const getLanguageSnapshot = language.getSnapshot;
export const subscribeLanguage = language.subscribe;
export const retryLanguage = language.retry;
export async function setLanguage(locale) {
  try { return await language.setLanguage(locale); }
  catch (error) {
    if (error.message === 'LANGUAGE_CATALOG_UNAVAILABLE') throw Error(tr('语言资源未能加载，原语言保持不变，请重试。'));
    if (error.message === 'LANGUAGE_CHANGED') throw Error(tr('语言已在其他窗口更改，请重试。'));
    throw error;
  }
}

export function useLocale() {
  return useSyncExternalStore(language.subscribe, language.getLocale, () => DEFAULT_LOCALE);
}

export function useLanguageSelectionPending() {
  return useSyncExternalStore(language.subscribe, getLanguageSelectionPending, () => false);
}

// Only callers designate application-owned messages. Parameters are never translated.
export function tr(source, params = {}, locale = getLocale()) {
  return catalogs.translate(source, params, locale);
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

export function formatDateTime(value, options = { dateStyle: 'short', timeStyle: 'medium' }) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), options).format(date);
}
