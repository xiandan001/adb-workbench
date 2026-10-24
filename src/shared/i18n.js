import { useSyncExternalStore } from 'react';
import core from '../../electron/locales/en-core.json' with { type: 'json' };
import workspace from '../../electron/locales/en-workspace.json' with { type: 'json' };
import tools from '../../electron/locales/en-tools.json' with { type: 'json' };
import backend from '../../electron/locales/en-backend.json' with { type: 'json' };
import { createLanguageStore, DEFAULT_LOCALE } from './localeStore.js';
import { createMessageTranslator } from './messageCatalog.js';

const translate = createMessageTranslator([...Object.entries(backend), ...Object.entries(tools), ...Object.entries(workspace), ...Object.entries(core)]);
const store = createLanguageStore({ api: globalThis.window?.electronAPI, storage: globalThis.localStorage });
export const getLocale = store.getLocale;
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
