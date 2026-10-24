const { types } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');

const LOCALES = Object.freeze(['zh-CN', 'en-US']);
const messages = Object.create(null);
for (const domain of ['core', 'workspace', 'tools', 'backend']) {
  try { for (const [source, value] of Object.entries(require(`../locales/en-${domain}.json`))) if (!Object.hasOwn(messages, source)) messages[source] = value; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
let currentLocale = 'zh-CN';
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
  const message = locale === 'en-US' && Object.hasOwn(messages, source) ? messages[source] : source;
  return String(message).replace(/\{(\d+)\}/g, (placeholder, key) => Object.hasOwn(params, key) ? String(params[key]) : placeholder);
}
function windowArguments() { return [`--app-language=${getLocale()}`]; }

function createLocalizationService({ readSettings, writeSettingsPatch, getMainWindow, getWindows }) {
  let queue = Promise.resolve();
  const enqueue = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const live = window => window && !window.isDestroyed() && !window.webContents.isDestroyed();
  const owns = (event, window) => live(window) && window.webContents.mainFrame
    && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const error = message => ({ success: false, error: { message: tr(message) } });
  async function initialize() {
    return enqueue(async () => {
      try { const settings = await readSettings(); setLocale(LOCALES.includes(settings?.locale) ? settings.locale : 'zh-CN'); }
      catch { setLocale('zh-CN'); }
      return getLocale();
    });
  }
  function register(ipcMain) {
    ipcMain.on('language:initial', (event, ...args) => {
      event.returnValue = !args.length && getWindows().some(window => owns(event, window)) ? { locale: currentLocale } : null;
    });
    ipcMain.handle('language:get', event => getWindows().some(window => owns(event, window))
      ? { success: true, locale: getLocale() } : error(tr('请在应用窗口读取语言设置')));
    ipcMain.handle('language:set', (event, value) => enqueue(async () => {
      if (!owns(event, getMainWindow())) return error(tr('只能在主窗口修改语言'));
      if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return error(tr('语言设置参数无效'));
      const descriptor = Object.getOwnPropertyDescriptor(value, 'locale');
      if (Reflect.ownKeys(value).length !== 1 || !descriptor || !Object.hasOwn(descriptor, 'value')
        || !LOCALES.includes(descriptor.value)) return error(tr('语言设置参数无效'));
      const locale = descriptor.value;
      try {
        await writeSettingsPatch({ locale }, () => {
          if (!owns(event, getMainWindow())) throw new Error('language_owner_closed');
        });
      } catch { return error(tr('语言设置保存失败，请重试')); }
      setLocale(locale);
      for (const window of getWindows()) if (live(window)) {
        try { window.webContents.send('language:changed', { locale }); }
        catch { /* A window may close after the durable setting is saved. */ }
      }
      return { success: true, locale };
    }));
  }
  return { initialize, register };
}

let service;
function defaultService() {
  if (!service) {
    const settings = require('./settings.cjs'); const context = require('./app-context.cjs');
    service = createLocalizationService({ readSettings: settings.readSettings, writeSettingsPatch: settings.writeSettingsPatch,
      getMainWindow: context.getMainWindow, getWindows: () => [context.getMainWindow(), context.getLogAnalyzerWindow()] });
  }
  return service;
}
module.exports = { tr, getLocale, setLocale, withLocale, scopeIpc, onLocaleChanged, windowArguments, createLocalizationService,
  initialize: () => defaultService().initialize(), register: ipcMain => defaultService().register(ipcMain) };
