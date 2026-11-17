export function createRendererLanguage({ store, catalogs, defaultLocale = 'zh-CN', clock = globalThis, document = globalThis.document, timeoutMs = 1800 }) {
  const listeners = new Set();
  let generation = 0, authorityRevision = 0, changing = false, initialization, alive = true;
  let snapshot = { locale: catalogs.has(store.getLocale()) ? store.getLocale() : defaultLocale,
    pendingLocale: '', loading: false, error: '', initializing: !catalogs.has(store.getLocale()), languageSelectionPending: store.getLanguageSelectionPending() };
  const timers = new Set(), completions = new Set();
  function publish(patch) {
    if (!alive) return;
    const next = { ...snapshot, ...patch };
    if (Object.keys(next).every(key => next[key] === snapshot[key])) return;
    snapshot = next;
    if (document) document.documentElement.lang = snapshot.locale;
    for (const listener of listeners) listener();
  }
  function synchronize(locale) {
    if (!alive) return Promise.resolve(snapshot.locale);
    const token = ++generation;
    publish({ pendingLocale: locale, loading: !catalogs.has(locale), error: '', languageSelectionPending: store.getLanguageSelectionPending() });
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; completions.delete(finish); resolve(snapshot.locale); } };
      completions.add(finish);
      const current = () => alive && token === generation && store.getLocale() === locale;
      const timer = clock.setTimeout(() => {
        timers.delete(timer);
        if (current()) publish({ loading: false, initializing: false, error: 'catalog-unavailable' });
        finish();
      }, timeoutMs);
      timers.add(timer);
      Promise.resolve().then(() => catalogs.load(locale)).then(() => {
        if (current()) publish({ locale, pendingLocale: '', loading: false, initializing: false, error: '' });
      }, () => {
        if (current()) publish({ loading: false, initializing: false, error: 'catalog-unavailable' });
      }).finally(() => { clock.clearTimeout(timer); timers.delete(timer); finish(); });
    });
  }
  const unsubscribe = store.subscribe(() => { authorityRevision++; void synchronize(store.getLocale()); });
  return {
    getLocale: () => snapshot.locale,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize() {
      if (!initialization) {
        initialization = synchronize(store.getLocale());
        void store.initialize().then(() => {
          if (alive && store.getLocale() !== snapshot.locale && store.getLocale() !== snapshot.pendingLocale) void synchronize(store.getLocale());
        }).catch(() => {});
      }
      return initialization;
    },
    async setLanguage(locale) {
      if (!alive) throw Error('LANGUAGE_OWNER_CHANGED');
      if (changing) throw Error('LANGUAGE_SAVE_PENDING');
      changing = true; const revision = authorityRevision;
      try {
        try { await catalogs.load(locale); } catch { throw Error('LANGUAGE_CATALOG_UNAVAILABLE'); }
        if (!alive) throw Error('LANGUAGE_OWNER_CHANGED');
        if (authorityRevision !== revision && store.getLocale() !== locale) throw Error('LANGUAGE_CHANGED');
        await store.setLanguage(locale);
        if (!alive) throw Error('LANGUAGE_OWNER_CHANGED');
        return await synchronize(store.getLocale());
      } finally { changing = false; }
    },
    retry: () => synchronize(store.getLocale()),
    dispose() { alive = false; generation++; unsubscribe(); for (const timer of timers) clock.clearTimeout(timer); timers.clear(); for (const finish of completions) finish(); listeners.clear(); },
  };
}
