const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const localization = require('../electron/lib/localization.cjs');
const settingsSource = fs.readFileSync(path.join(__dirname, '../electron/lib/settings.cjs'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-installer-language-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); localization.setLocale('zh-CN'); });
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${settingsSource}\n})`)(name => {
    if (name === 'electron') return { app: { getPath: () => root } };
    if (name.startsWith('./')) return require(path.join(__dirname, '../electron/lib', name));
    if (name === '../locales/locale-config.json') return require('../electron/locales/locale-config.json');
    return require(name);
  }, module, module.exports);
  const settings = module.exports;
  const main = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false, send: () => {} } };
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  let receiptReads = 0;
  const service = (locale = 'en-US', overrides = {}) => {
    const handlers = new Map();
    const api = localization.createLocalizationService({ readSettings: settings.readSettings,
      writeSettingsPatch: settings.writeSettingsPatch, hasExistingProfile: settings.hasExistingLanguageProfile,
      getSystemLocales: () => ['ja-JP'], getInstallerLanguage: async () => { receiptReads++; return locale; },
      getMainWindow: () => main, getWindows: () => [main], ...overrides });
    api.register({ on: (name, callback) => handlers.set(name, callback), handle: (name, callback) => handlers.set(name, callback) });
    return { ...api, get: () => handlers.get('language:get')(event), choose: value => handlers.get('language:set')(event, { locale: value }) };
  };
  return { root, settings, service, get receiptReads() { return receiptReads; } };
}

test('a fresh profile inherits each installer language durably and skips duplicate first-use selection', async t => {
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    const f = fixture(t); const api = f.service(locale);
    assert.equal(await api.initialize(), locale);
    assert.deepEqual(api.get(), { success: true, locale, languageSelectionPending: false });
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'));
    assert.equal(saved.locale, locale); assert.equal(saved.languageSelectionPending, false);
    assert.equal(f.receiptReads, 1);
    fs.mkdirSync(path.join(f.root, 'Local Storage'));
    const restarted = f.service('en-US'); await restarted.initialize();
    assert.equal(restarted.get().locale, locale); assert.equal(restarted.get().languageSelectionPending, false);
    assert.equal(f.receiptReads, 1);
  }
});

test('upgrades preserve existing preferences, legacy profiles and an unfinished prior language choice', async t => {
  for (const prior of [{ locale: 'zh-TW', screenshotPath: 'untouched' }, { locale: 'ja-JP', languageSelectionPending: true },
    { screenshotPath: 'legacy settings' }, { locale: 'ko-KR', languageSelectionPending: false }]) {
    const f = fixture(t);
    const file = path.join(f.root, 'settings.json'); fs.writeFileSync(file, JSON.stringify(prior));
    const before = fs.readFileSync(file);
    const api = f.service('en-US'); await api.initialize();
    assert.equal(api.get().locale, prior.locale || 'zh-CN');
    assert.equal(api.get().languageSelectionPending, prior.languageSelectionPending);
    assert.ok(fs.readFileSync(file).equals(before)); assert.equal(f.receiptReads, 0);
  }
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'Local Storage'));
  await f.service().initialize(); assert.equal(f.receiptReads, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
});

test('a saved locale wins even if the profile detector sees no browser data', async t => {
  const f = fixture(t);
  const api = f.service('en-US', { hasExistingProfile: () => false, readSettings: async () => ({ locale: 'ko-KR' }) });
  await api.initialize(); assert.equal(api.get().locale, 'ko-KR'); assert.equal(f.receiptReads, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
});

test('missing, invalid or unreadable installer choices preserve the existing first-run language picker', async t => {
  for (const getInstallerLanguage of [async () => null, async () => 'fr-FR', async () => { throw new Error('fixture registry unavailable'); }]) {
    const f = fixture(t); const api = f.service(null, { getInstallerLanguage });
    await api.initialize();
    assert.deepEqual(api.get(), { success: true, locale: 'ja-JP', languageSelectionPending: true });
    assert.equal((await f.settings.readSettings()).languageSelectionPending, true);
    assert.equal((await api.choose('en-US')).success, true);
    assert.equal((await f.settings.readSettings()).languageSelectionPending, false);
  }
});

test('the installer choice is not exposed until durable settings persistence completes', async t => {
  const f = fixture(t); localization.setLocale('zh-CN');
  let releaseWrite;
  const pending = new Promise(resolve => { releaseWrite = resolve; });
  const api = f.service('en-US', { writeSettingsPatch: async patch => { await pending; return f.settings.writeSettingsPatch(patch); } });
  const initializing = api.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(localization.getLocale(), 'zh-CN'); assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
  releaseWrite(); await initializing;
  assert.equal(localization.getLocale(), 'en-US');
  assert.equal((await f.settings.readSettings()).languageSelectionPending, false);
});

test('failed installer-choice persistence blocks first startup and permits a clean retry', async t => {
  const f = fixture(t); localization.setLocale('zh-CN');
  const api = f.service('ko-KR', { writeSettingsPatch: async () => { throw new Error('private fixture failure'); } });
  await assert.rejects(api.initialize(), error => error.code === 'LANGUAGE_FIRST_RUN_INIT_FAILED' && !error.message.includes('private'));
  assert.equal(localization.getLocale(), 'zh-CN'); assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
  const retry = f.service('ko-KR'); await retry.initialize();
  assert.deepEqual(retry.get(), { success: true, locale: 'ko-KR', languageSelectionPending: false });
});
