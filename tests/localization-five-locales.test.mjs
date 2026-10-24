import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createLanguageStore, normalizeLocale, SUPPORTED_LOCALES, LANGUAGE_STORAGE_KEY } from '../src/shared/localeStore.js';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import { tr as rendererMessage, getLocale, setLanguage } from '../src/shared/i18n.js';
import { CHANGELOGS, getChangelog } from '../src/data/changelogs.js';

const require = createRequire(import.meta.url);
const main = require('../electron/lib/localization.cjs');
const config = require('../electron/locales/locale-config.json');
const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
const brands = { 'zh-CN': '卓控台', 'zh-TW': '卓控臺', 'en-US': 'Veylo', 'ja-JP': 'Veylo', 'ko-KR': 'Veylo' };

test('all five locales share exact codes, durable stores and backend normalization', async () => {
  assert.deepEqual(SUPPORTED_LOCALES, locales);
  assert.deepEqual(config.supportedLocales, locales);
  for (const locale of locales) {
    assert.equal(normalizeLocale(locale), locale); assert.equal(main.normalizeLocale(locale), locale);
    const values = new Map([[LANGUAGE_STORAGE_KEY, locale], ['raw-input', '用户输入']]);
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    const store = createLanguageStore({ storage }); assert.equal(store.getLocale(), locale);
    for (const next of locales) { await store.setLanguage(next); assert.equal(values.get(LANGUAGE_STORAGE_KEY), next); }
    assert.equal(values.get('raw-input'), '用户输入'); store.dispose();
  }
  for (const invalid of ['zh', 'zh-HK', 'en', 'jp', 'kr', 'fr-FR', undefined]) {
    assert.equal(normalizeLocale(invalid), 'zh-CN'); assert.equal(main.normalizeLocale(invalid), 'zh-CN');
  }
});

test('five-language retained messages preserve every parameter across all locale pairs', () => {
  const key = '已保存 {0}，共 {1} 项';
  const templates = { 'zh-CN': key, 'zh-TW': '已儲存 {0}，共 {1} 項', 'en-US': 'Saved {0}, {1} items',
    'ja-JP': '{0} を保存しました（{1} 件）', 'ko-KR': '{0} 저장 완료, 총 {1}개' };
  const translate = createMessageTranslator(Object.fromEntries(Object.entries(templates).filter(([locale]) => locale !== 'zh-CN').map(([locale, text]) => [locale, [[key, text]]])));
  const raw = '保存 / 日本語 / 한국어 / {2} / $&';
  for (const from of locales) for (const to of locales) {
    const retained = translate(key, { 0: raw, 1: 3 }, from);
    assert.equal(translate(retained, {}, to), templates[to].replace('{0}', () => raw).replace('{1}', '3'));
    assert.equal(translate('原始日志，not an application message', {}, to), '原始日志，not an application message');
  }
});

test('real frontend and backend catalogs agree on the localized brand and every shared source key', () => {
  for (const locale of locales) {
    assert.equal(rendererMessage('卓控台', {}, locale), brands[locale]);
    assert.equal(main.tr('卓控台', {}, locale), brands[locale]);
    main.withLocale(locale, () => assert.deepEqual(main.windowArguments(), [`--app-language=${locale}`]));
    for (const key of ['设备列表', '偏好设置', '自动检查更新', 'AI 日志助手', '连接设备', '语言设置保存失败，请重试']) {
      assert.equal(rendererMessage(key, {}, locale), main.tr(key, {}, locale), `${locale}: ${key}`);
    }
  }
});

test('reviewed action and state labels retain their software meaning instead of dictionary homonyms', () => {
  const reviewed = {
    'ja-JP': { '去激活': 'ライセンスを有効化', '运行': '実行', '运行中': '実行中', '已禁用': '無効', '清空记录': '記録をクリア', '应用': 'アプリ', '任务中心': 'タスクセンター' },
    'ko-KR': { '去激活': '라이선스 활성화', '运行': '실행', '运行中': '실행 중', '已禁用': '비활성화됨', '清空记录': '기록 지우기', '应用': '앱', '任务中心': '작업 센터' },
  };
  for (const [locale, entries] of Object.entries(reviewed)) for (const [key, value] of Object.entries(entries)) {
    assert.equal(rendererMessage(key, {}, locale), value); assert.equal(main.tr(key, {}, locale), value);
  }
  assert.equal(rendererMessage('{0} 个', { 0: 3 }, 'ko-KR'), '3개');
});

test('saved locale and main-window ownership work for every language, without extra authorization surfaces', async () => {
  const settings = {}; const broadcasts = []; const handlers = new Map();
  const window = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: (...args) => broadcasts.push(args) } });
  const owner = window(), analyzer = window();
  const service = main.createLocalizationService({ readSettings: async () => settings, writeSettingsPatch: async patch => Object.assign(settings, patch),
    getMainWindow: () => owner, getWindows: () => [owner, analyzer] });
  service.register({ on: (channel, handler) => handlers.set(channel, handler), handle: (channel, handler) => handlers.set(channel, handler) });
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  for (const locale of locales) {
    const result = await handlers.get('language:set')(event(owner), { locale });
    assert.deepEqual(result, { success: true, locale });
    assert.equal(await service.initialize(), locale); assert.equal(settings.locale, locale);
    assert.equal((await handlers.get('language:set')(event(analyzer), { locale })).success, false);
    const initial = event(owner); handlers.get('language:initial')(initial); assert.deepEqual(initial.returnValue, { locale });
  }
  assert.equal(broadcasts.length, locales.length * 2);
  main.setLocale('zh-CN');
});

test('both sandbox-compatible preloads retain all supported locales and reject unknown argv', () => {
  for (const locale of [...locales, 'fr-FR']) {
    for (const file of ['electron/preload.cjs', 'electron/startup/preload.cjs']) {
      let api;
      vm.runInNewContext(source(file), { process: { argv: [`--app-language=${locale}`] }, require: name => {
        assert.equal(name, 'electron'); return { ipcRenderer: {}, contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } } };
      } });
      assert.equal(api.initialLanguage, locales.includes(locale) ? locale : 'zh-CN', file);
    }
  }
  for (const locale of locales) {
    let api;
    vm.runInNewContext(source('electron/preload.cjs'), { process: { argv: ['--app-language=en-US'] }, require: () => ({
      ipcRenderer: { sendSync: () => ({ locale }) }, contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
    }) });
    assert.equal(api.initialLanguage, locale);
  }
});

function startupContext(locale) {
  const timers = []; const foreign = { textContent: '用户日志 日本語 한국어' };
  const node = (attributes = {}) => ({ dataset: {}, hidden: false, textContent: '', getAttribute: key => attributes[key],
    setAttribute: (key, value) => { attributes[key] = value; }, removeAttribute() {}, addEventListener() {}, focus() {}, remove() {} });
  const nodes = Object.fromEntries(['app-startup', 'root', 'startup-status', 'startup-detail', 'startup-retry'].map(id => [id, node()]));
  const title = node({ 'data-i18n': '卓控台' }); const tagline = node({ 'data-i18n': '连接设备 · 专注调试' });
  nodes['app-startup'].querySelectorAll = () => [title, tagline]; nodes['app-startup'].querySelector = () => tagline;
  const document = { documentElement: { dataset: {} }, getElementById: id => nodes[id] };
  const window = { electronAPI: { initialLanguage: locale }, localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {}, location: { reload() {} } };
  const context = { window, document, performance: { mark() {} }, setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {} };
  return { context, nodes, title, tagline, foreign, timers };
}

test('first startup text, brand, status and slow/error states are localized before React in all five languages', () => {
  for (const locale of locales) {
    const h = startupContext(locale);
    for (const file of ['public/startup-preferences.js', 'public/startup.js']) vm.runInNewContext(source(file), h.context);
    assert.equal(h.context.document.documentElement.lang, locale); assert.equal(h.context.document.title, brands[locale]);
    assert.equal(h.title.textContent, brands[locale]);
    assert.equal(h.tagline.textContent, main.tr('连接设备 · 专注调试', {}, locale));
    assert.equal(h.nodes['startup-status'].textContent, main.tr('正在准备工作区', {}, locale));
    h.timers.find(timer => timer.ms === 6000).callback();
    assert.equal(h.nodes['startup-detail'].textContent, main.tr('启动比平时稍慢，可继续等待或重试。', {}, locale));
    h.context.window.__workbenchStartup.fail('用户日志 日本語 한국어');
    assert.equal(h.nodes['startup-status'].textContent, main.tr('启动未完成', {}, locale));
    assert.equal(h.nodes['startup-detail'].textContent, h.foreign.textContent);
  }
});

test('particle artwork renders the localized brand without changing the 4.4-second animation', () => {
  for (const locale of locales) {
    const drawn = []; let play;
    const pixels = new Uint8ClampedArray(460 * 280 * 4); pixels[3] = 255;
    const context2d = new Proxy({ fillText: text => drawn.push(text), getImageData: () => ({ data: pixels }), createRadialGradient: () => ({ addColorStop() {} }) },
      { get: (target, key) => target[key] || (() => {}) });
    const canvas = () => ({ getContext: () => context2d });
    const document = { documentElement: {}, getElementById: canvas, createElement: canvas };
    const window = { startupOverlay: { initialLanguage: locale, onPlay: callback => { play = callback; }, ready() {}, finished() {} }, addEventListener() {} };
    vm.runInNewContext(source('electron/startup/particles.js'), { window, document, innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Uint8ClampedArray });
    assert.equal(document.documentElement.lang, locale); assert.equal(document.title, main.tr('卓控台启动', {}, locale));
    play(); assert.deepEqual(drawn, [brands[locale]]);
  }
  assert.match(source('electron/startup/particles.js'), /durationMs = 4400/);
});

test('migration, native branding and AI output instruction respect locale while machine identifiers stay stable', () => {
  const { sanitizeFile } = require('../electron/lib/data-migration-policy.cjs');
  const { analysisMessages } = require('../electron/lib/analysis-language.cjs');
  const { LOGIN_ITEM_NAME } = require('../electron/lib/startup-settings-policy.cjs');
  for (const locale of locales) {
    assert.deepEqual(sanitizeFile('settings.json', { locale }), { locale });
    const original = [{ role: 'user', content: '原始命令 日本語 한국어' }, { role: 'assistant', content: '历史回答' }];
    const result = main.withLocale(locale, () => analysisMessages('System', original, '用户问题'));
    assert.deepEqual(result.slice(1, -1), original); assert.equal(result.at(-1).content, '用户问题');
    const expectedLanguage = { 'zh-CN': /简体中文/, 'zh-TW': /繁體中文/, 'en-US': /English/, 'ja-JP': /日本語/, 'ko-KR': /한국어/ }[locale];
    assert.match(result[0].content, expectedLanguage);
    assert.equal(LOGIN_ITEM_NAME, '卓控台');
  }
  const build = require('../electron-builder.json');
  assert.equal(build.appId, 'com.scrcpy.gui'); assert.equal(build.productName, '卓控台');
  assert.match(source('electron/main.cjs'), /title: tr\('卓控台'\)/);
  assert.match(source('electron/main.cjs'), /mainWindow\.setTitle\(tr\('卓控台', \{\}, locale\)\)/);
  for (const name of ['performance', 'task-center', 'ai-tools-router', 'ai-tools-sessions']) {
    const worker = source(`electron/lib/${name}-worker.cjs`);
    assert.match(worker, /setLocale\(normalizeLocale\((?:workerData\?|request)\.locale\)\)/);
    assert.doesNotMatch(worker, /locale === 'en-US'/);
  }
});

test('current and historical release notes, including an already-open version dialog, follow the selected language', async () => {
  const previous = getLocale();
  try {
    await setLanguage('zh-CN');
    const chinese = Object.fromEntries(Object.keys(CHANGELOGS).map(version => [version, getChangelog(version).items.map(item => item.text)]));
    const retained = { ...getChangelog('4.7.3') };
    for (const locale of locales) {
      await setLanguage(locale);
      for (const version of Object.keys(CHANGELOGS)) {
        const expected = chinese[version].map(key => rendererMessage(key, {}, locale));
        assert.deepEqual(getChangelog(version).items.map(item => item.text), expected, `${locale}: ${version}`);
      }
      assert.deepEqual(retained.items.map(item => item.text), chinese['4.7.3'].map(key => rendererMessage(key, {}, locale)));
    }
  } finally { await setLanguage(previous); }
});

test('long localized navigation and changelog controls keep readable single-line labels', () => {
  const app = source('src/App.jsx');
  assert.match(app, /locale === 'ja-JP' \? 'w-72' : 'w-56 lg:w-60'/);
  assert.ok(app.includes('[&>button>span]:whitespace-nowrap'));
  const end = app.indexOf('>{tr("知道了")}</button>'); assert.ok(end >= 0);
  const button = app.slice(app.lastIndexOf('<button', end), end);
  assert.ok(button.includes('shrink-0 whitespace-nowrap'));
});
