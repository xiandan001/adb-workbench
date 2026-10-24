export const DEFAULT_LOCALE = 'zh-CN';
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US']);
export const LANGUAGE_STORAGE_KEY = 'adb-workbench.language.v1';

export function normalizeLocale(value) {
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

// Renderer preferences are a cache only. Electron owns durable writes and broadcasts.
export function createLanguageStore({ api, storage, initialLocale } = {}) {
  let cached;
  try { cached = storage?.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Private storage may be unavailable. */ }
  let locale = normalizeLocale(initialLocale ?? api?.initialLanguage ?? cached);
  let initialized = false;
  let unsubscribe;
  let saving = false;
  const listeners = new Set();
  function publish(next) {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    try { storage?.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Main-process persistence remains authoritative. */ }
    if (locale === next) return;
    locale = next;
    for (const listener of listeners) listener();
  }
  async function initialize() {
    if (initialized) return locale;
    initialized = true;
    unsubscribe = api?.onLanguageChanged?.(value => publish(value?.locale));
    if (typeof api?.languageGet === 'function') {
      try {
        const value = await api.languageGet();
        if (value?.success && SUPPORTED_LOCALES.includes(value.locale)) publish(value.locale);
      } catch { /* The validated preload locale remains usable during startup. */ }
    }
    return locale;
  }
  async function setLanguage(next) {
    if (!SUPPORTED_LOCALES.includes(next)) throw new Error('INVALID_LOCALE');
    if (saving) throw new Error('LANGUAGE_SAVE_PENDING');
    if (next === locale) return locale;
    saving = true;
    try {
      if (typeof api?.languageSet === 'function') {
        const result = await api.languageSet({ locale: next });
        if (!result?.success || result.locale !== next) throw new Error(result?.error?.message || 'LANGUAGE_SAVE_FAILED');
      } else if (storage) {
        storage.setItem(LANGUAGE_STORAGE_KEY, next);
      }
      publish(next);
      return locale;
    } finally { saving = false; }
  }
  return {
    getLocale: () => locale,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize,
    setLanguage,
    dispose() { unsubscribe?.(); listeners.clear(); initialized = false; },
  };
}
