import localeConfig from '../../electron/locales/locale-config.json' with { type: 'json' };

export const DEFAULT_LOCALE = localeConfig.defaultLocale;
export const SUPPORTED_LOCALES = Object.freeze([...localeConfig.supportedLocales]);
export const LANGUAGE_STORAGE_KEY = 'adb-workbench.language.v1';

export function normalizeLocale(value) {
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

// Renderer preferences are a cache only. Electron owns durable writes and broadcasts.
export function createLanguageStore({ api, storage, initialLocale } = {}) {
  let cached;
  try { cached = storage?.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Private storage may be unavailable. */ }
  let locale = normalizeLocale(initialLocale ?? api?.initialLanguage ?? cached);
  let languageSelectionPending = api?.initialLanguagePending === true;
  let revision = 0;
  let initialized = false;
  let unsubscribe;
  let saving = false;
  const listeners = new Set();
  function publish(next, pending) {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    try { storage?.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Main-process persistence remains authoritative. */ }
    const nextPending = typeof pending === 'boolean' ? pending : languageSelectionPending;
    if (locale === next && languageSelectionPending === nextPending) return;
    locale = next;
    languageSelectionPending = nextPending;
    revision++;
    for (const listener of listeners) listener();
  }
  async function initialize() {
    if (initialized) return locale;
    initialized = true;
    unsubscribe = api?.onLanguageChanged?.(value => publish(value?.locale, value?.languageSelectionPending));
    if (typeof api?.languageGet === 'function') {
      const initialRevision = revision;
      try {
        const value = await api.languageGet();
        if (revision === initialRevision && value?.success && SUPPORTED_LOCALES.includes(value.locale)) publish(value.locale, value.languageSelectionPending);
      } catch { /* The validated preload locale remains usable during startup. */ }
    }
    return locale;
  }
  async function setLanguage(next) {
    if (!SUPPORTED_LOCALES.includes(next)) throw new Error('INVALID_LOCALE');
    if (saving) throw new Error('LANGUAGE_SAVE_PENDING');
    if (next === locale && !languageSelectionPending) return locale;
    saving = true;
    try {
      if (typeof api?.languageSet === 'function') {
        const result = await api.languageSet({ locale: next });
        if (!result?.success || result.locale !== next) throw new Error(result?.error?.message || 'LANGUAGE_SAVE_FAILED');
        if (languageSelectionPending && result.languageSelectionPending !== false) throw new Error('LANGUAGE_SELECTION_NOT_CONFIRMED');
        publish(next, result.languageSelectionPending);
      } else if (languageSelectionPending) {
        throw new Error('LANGUAGE_SAVE_FAILED');
      } else if (storage) {
        storage.setItem(LANGUAGE_STORAGE_KEY, next);
      }
      publish(next);
      return locale;
    } finally { saving = false; }
  }
  return {
    getLocale: () => locale,
    getLanguageSelectionPending: () => languageSelectionPending,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize,
    setLanguage,
    dispose() { unsubscribe?.(); listeners.clear(); initialized = false; },
  };
}
