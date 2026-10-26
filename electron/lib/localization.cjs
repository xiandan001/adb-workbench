const { types } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');

const localeConfig = require('../locales/locale-config.json');
const LOCALES = Object.freeze([...localeConfig.supportedLocales]);
const normalizeLocale = locale => LOCALES.includes(locale) ? locale : localeConfig.defaultLocale;
const messages = Object.create(null);
for (const [locale, prefix] of Object.entries(localeConfig.catalogPrefixes)) {
  messages[locale] = Object.create(null);
  for (const domain of ['core', 'workspace', 'tools', 'backend']) {
    for (const [source, value] of Object.entries(require(`../locales/${prefix}-${domain}.json`))) {
      if (!Object.hasOwn(messages[locale], source)) messages[locale][source] = value;
    }
  }
}
let currentLocale = localeConfig.defaultLocale;
const operationLocale = new AsyncLocalStorage();
const listeners = new Set();
function onLocaleChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); }

function getLocale() { return operationLocale.getStore() || currentLocale; }
function withLocale(locale, callback) { return operationLocale.run(LOCALES.includes(locale) ? locale : currentLocale, callback); }
function scopeIpc(ipcMain) {
  return new Proxy(ipcMain, { get(target, property) {
    if (property === 'handle') return (channel, callback) => target.handle(channel, (...args) => withLocale(currentLocale, () => callback(...args)));
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function setLocale(locale) {
  if (!LOCALES.includes(locale)) throw new Error(tr('不支持的界面语言'));
  currentLocale = locale;
  for (const listener of listeners) { try { withLocale(locale, () => listener(locale)); } catch { /* A closed native surface cannot prevent a durable language change. */ } }
  return locale;
}
function tr(source, params = {}, locale = getLocale()) {
  const catalog = messages[locale];
  const message = catalog && Object.hasOwn(catalog, source) ? catalog[source] : source;
  return String(message).replace(/\{(\d+)\}/g, (placeholder, key) => Object.hasOwn(params, key) ? String(params[key]) : placeholder);
}
function windowArguments() { return [`--app-language=${getLocale()}`]; }

function matchSystemLocale(values) {
  for (const value of Array.isArray(values) ? values : [values]) {
    if (typeof value !== 'string') continue;
    const language = value.replaceAll('_', '-').toLowerCase();
    if (/^zh(?:-|$)/.test(language)) return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(language) ? 'zh-TW' : 'zh-CN';
    if (/^en(?:-|$)/.test(language)) return 'en-US';
    if (/^ja(?:-|$)/.test(language)) return 'ja-JP';
    if (/^ko(?:-|$)/.test(language)) return 'ko-KR';
  }
  return localeConfig.defaultLocale;
}

function createLocalizationService({ readSettings, writeSettingsPatch, getMainWindow, getWindows,
  hasExistingProfile = () => true, getSystemLocales = () => [], getInstallerLanguage = async () => null }) {
  let queue = Promise.resolve();
  let languageSelectionPending = false;
  let selectionTracked = false;
  const state = () => ({ locale: currentLocale, ...(selectionTracked ? { languageSelectionPending } : {}) });
  const firstRunFailure = () => Object.assign(new Error(tr('语言设置保存失败，请重试')), { code: 'LANGUAGE_FIRST_RUN_INIT_FAILED' });
  const enqueue = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const live = window => window && !window.isDestroyed() && !window.webContents.isDestroyed();
  const owns = (event, window) => live(window) && window.webContents.mainFrame
    && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const error = message => ({ success: false, error: { message: tr(message) } });
  async function initialize() {
    return enqueue(async () => {
      let existing;
      try { existing = await hasExistingProfile(); } catch { throw firstRunFailure(); }
      let settings;
      try { settings = await readSettings(); }
      catch {
        if (!existing) throw firstRunFailure();
        setLocale(localeConfig.defaultLocale);
        return getLocale();
      }
      selectionTracked = typeof settings?.languageSelectionPending === 'boolean';
      languageSelectionPending = settings?.languageSelectionPending === true;
      if (!existing && !selectionTracked && !LOCALES.includes(settings?.locale)) {
        let installerLocale;
        try { installerLocale = await getInstallerLanguage(); } catch { /* Keep the first-run picker if the receipt cannot be read. */ }
        let suggested = localeConfig.defaultLocale;
        const selectedInInstaller = LOCALES.includes(installerLocale);
        if (selectedInInstaller) suggested = installerLocale;
        else try { suggested = matchSystemLocale(getSystemLocales()); } catch { /* An unavailable OS locale uses the supported default. */ }
        // Commit this before any BrowserWindow can create Local Storage. If it
        // fails, main must stop startup so the next launch remains a new profile.
        try { await writeSettingsPatch({ locale: suggested, languageSelectionPending: !selectedInInstaller }); }
        catch { throw firstRunFailure(); }
        selectionTracked = true; languageSelectionPending = !selectedInInstaller; setLocale(suggested);
      } else setLocale(normalizeLocale(settings?.locale));
      return getLocale();
    });
  }
  function register(ipcMain) {
    ipcMain.on('language:initial', (event, ...args) => {
      event.returnValue = !args.length && getWindows().some(window => owns(event, window)) ? state() : null;
    });
    ipcMain.handle('language:get', event => getWindows().some(window => owns(event, window))
      ? { success: true, ...state() } : error(tr('请在应用窗口读取语言设置')));
    ipcMain.handle('language:set', (event, value) => enqueue(async () => {
      if (!owns(event, getMainWindow())) return error(tr('只能在主窗口修改语言'));
      if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return error(tr('语言设置参数无效'));
      const descriptor = Object.getOwnPropertyDescriptor(value, 'locale');
      if (Reflect.ownKeys(value).length !== 1 || !descriptor || !Object.hasOwn(descriptor, 'value')
        || !LOCALES.includes(descriptor.value)) return error(tr('语言设置参数无效'));
      const locale = descriptor.value;
      try {
        await writeSettingsPatch({ locale, ...(languageSelectionPending ? { languageSelectionPending: false } : {}) }, () => {
          if (!owns(event, getMainWindow())) throw new Error('language_owner_closed');
        });
      } catch { return error(tr('语言设置保存失败，请重试')); }
      languageSelectionPending = false;
      setLocale(locale);
      for (const window of getWindows()) if (live(window)) {
        try { window.webContents.send('language:changed', state()); }
        catch { /* A window may close after the durable setting is saved. */ }
      }
      return { success: true, ...state() };
    }));
  }
  return { initialize, register };
}

let service;
function defaultService() {
  if (!service) {
    const settings = require('./settings.cjs'); const context = require('./app-context.cjs');
    service = createLocalizationService({ readSettings: settings.readSettings, writeSettingsPatch: settings.writeSettingsPatch,
      hasExistingProfile: settings.hasExistingLanguageProfile,
      getInstallerLanguage: () => {
        const { app } = require('electron');
        return require('./installer-language.cjs').readInstallerLanguage({ isPackaged: app.isPackaged, executablePath: app.getPath('exe') });
      },
      getSystemLocales: () => {
        const { app } = require('electron');
        return app.getPreferredSystemLanguages?.() || [app.getLocale?.()];
      },
      getMainWindow: context.getMainWindow, getWindows: () => [context.getMainWindow(), context.getLogAnalyzerWindow()] });
  }
  return service;
}
module.exports = { tr, getLocale, setLocale, normalizeLocale, withLocale, scopeIpc, onLocaleChanged, windowArguments, matchSystemLocale, createLocalizationService,
  initialize: () => defaultService().initialize(), register: ipcMain => defaultService().register(ipcMain) };
