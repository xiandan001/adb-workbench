export function createLocaleCatalogLoader({ loaders, makeTranslator, defaultLocale = 'zh-CN' }) {
  const loaded = new Map(), flights = new Map();
  let translate = makeTranslator({});
  function load(locale) {
    if (locale === defaultLocale || loaded.has(locale)) return Promise.resolve();
    if (!Object.hasOwn(loaders, locale)) return Promise.reject(Error('INVALID_LOCALE'));
    if (flights.has(locale)) return flights.get(locale);
    const flight = Promise.resolve().then(() => loaders[locale]()).then(domains => {
      const entries = domains.flatMap(domain => Object.entries(domain.default && typeof domain.default === 'object' ? domain.default : domain));
      const next = new Map(loaded); next.set(locale, entries);
      const prepared = makeTranslator(Object.fromEntries(next));
      loaded.set(locale, entries); translate = prepared;
    }).finally(() => flights.delete(locale));
    flights.set(locale, flight); return flight;
  }
  return {
    load,
    has: locale => locale === defaultLocale || loaded.has(locale),
    translate(text, params = {}, locale = defaultLocale) {
      if (!loaded.size && typeof text === 'string') return text.replace(/\{(\d+)\}/g, (token, index) => Object.hasOwn(params, index) ? String(params[index] ?? '') : token);
      return translate(text, params, locale);
    },
  };
}
