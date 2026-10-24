const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const localization = require('../electron/lib/localization.cjs');
const settingsSource = fs.readFileSync(path.join(__dirname, '../electron/lib/settings.cjs'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-first-language-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsModule = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${settingsSource}\n})`)(name => {
    if (name === 'electron') return { app: { getPath: () => root } };
    if (name.startsWith('./')) return require(path.join(__dirname, '../electron/lib', name));
    if (name === '../locales/locale-config.json') return require('../electron/locales/locale-config.json');
    return require(name);
  }, settingsModule, settingsModule.exports);
  const settings = settingsModule.exports;
  const events = []; const main = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false, send: (channel, value) => events.push({ channel, value }) } };
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  function service(overrides = {}) {
    const handlers = new Map();
    const api = localization.createLocalizationService({ readSettings: settings.readSettings, writeSettingsPatch: settings.writeSettingsPatch,
      hasExistingProfile: settings.hasExistingLanguageProfile, getSystemLocales: () => ['ja-JP'],
      getMainWindow: () => main, getWindows: () => [main], ...overrides });
    api.register({ on: (name, callback) => handlers.set(name, callback), handle: (name, callback) => handlers.set(name, callback) });
    return { ...api, get: () => handlers.get('language:get')(event), choose: locale => handlers.get('language:set')(event, { locale }), handlers };
  }
  t.after(() => localization.setLocale('zh-CN'));
  return { root, settings, service, events, main, event };
}

test('a genuinely new profile durably marks selection pending before a window and keeps it after browser storage appears', async t => {
  const f = fixture(t); const first = f.service();
  assert.equal(f.settings.hasExistingLanguageProfile(), false);
  await first.initialize();
  assert.deepEqual(first.get(), { success: true, locale: 'ja-JP', languageSelectionPending: true });
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json')));
  assert.equal(saved.locale, 'ja-JP'); assert.equal(saved.languageSelectionPending, true);
  fs.mkdirSync(path.join(f.root, 'Local Storage'));
  const restarted = f.service({ getSystemLocales: () => ['en-US'] }); await restarted.initialize();
  assert.equal(restarted.get().locale, 'ja-JP'); assert.equal(restarted.get().languageSelectionPending, true);
  assert.deepEqual(f.events, []);
});

test('legacy settings or browser profiles never prompt or get rewritten during language initialization', async t => {
  for (const kind of ['settings', 'browser', 'saved-locale']) {
    const f = fixture(t);
    if (kind === 'browser') fs.mkdirSync(path.join(f.root, 'Local Storage'));
    else fs.writeFileSync(path.join(f.root, 'settings.json'), JSON.stringify(kind === 'saved-locale' ? { locale: 'ko-KR', screenshotPath: 'untouched' } : { screenshotPath: 'untouched' }));
    const before = fs.existsSync(path.join(f.root, 'settings.json')) ? fs.readFileSync(path.join(f.root, 'settings.json')) : null;
    const api = f.service(); await api.initialize();
    assert.equal(api.get().languageSelectionPending, undefined);
    assert.equal(api.get().locale, kind === 'saved-locale' ? 'ko-KR' : 'zh-CN');
    if (before) assert.ok(fs.readFileSync(path.join(f.root, 'settings.json')).equals(before));
    else assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
  }
});

test('same-locale confirmation clears pending atomically and survives restart without changing other settings', async t => {
  const f = fixture(t); const api = f.service(); await api.initialize();
  await f.settings.writeSettingsPatch({ screenshotPath: 'keep-this-path' });
  const result = await api.choose('ja-JP');
  assert.deepEqual(result, { success: true, locale: 'ja-JP', languageSelectionPending: false });
  assert.equal((await f.settings.readSettings()).languageSelectionPending, false);
  assert.equal((await f.settings.readSettings()).screenshotPath, 'keep-this-path');
  assert.deepEqual(f.events.at(-1), { channel: 'language:changed', value: { locale: 'ja-JP', languageSelectionPending: false } });
  const restarted = f.service(); await restarted.initialize(); assert.equal(restarted.get().languageSelectionPending, false);
  assert.ok(fs.readdirSync(f.root).every(name => !name.startsWith('.settings-')));
});

test('failed initial persistence blocks startup before browser storage can misclassify the profile', async t => {
  const f = fixture(t);
  const api = f.service({ writeSettingsPatch: async () => { throw new Error('private-path fixture failure'); } });
  await assert.rejects(api.initialize(), error => error.code === 'LANGUAGE_FIRST_RUN_INIT_FAILED' && !error.message.includes('private-path'));
  assert.equal(fs.existsSync(path.join(f.root, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'Local Storage')), false);
  assert.deepEqual(f.events, []);
});

test('failed selection and foreign windows cannot clear a pending first choice', async t => {
  const f = fixture(t); const initial = f.service(); await initial.initialize();
  const api = f.service({ writeSettingsPatch: async () => { throw new Error('fixture disk full'); } }); await api.initialize();
  assert.equal((await api.choose('en-US')).success, false); assert.equal(api.get().languageSelectionPending, true);
  assert.equal(api.get().locale, 'ja-JP');
  assert.equal((await api.handlers.get('language:set')({ sender: {}, senderFrame: {} }, { locale: 'en-US' })).success, false);
  assert.equal((await f.settings.readSettings()).languageSelectionPending, true);
});

test('generic settings IPC cannot modify locale or pending; unrelated writes preserve the marker', async t => {
  const f = fixture(t); await f.service().initialize();
  const handlers = new Map(); f.settings.register({ handle: (name, callback) => handlers.set(name, callback) });
  const patch = handlers.get('settings:savePatch');
  for (const input of [{ locale: 'en-US' }, { languageSelectionPending: false }, { languageSelectionPending: true, screenshotPath: 'blocked' }]) {
    assert.equal((await patch(f.event, input)).success, false);
  }
  assert.equal((await patch(f.event, { screenshotPath: 'allowed' })).success, true);
  const state = await f.settings.readSettings(); assert.equal(state.languageSelectionPending, true); assert.equal(state.screenshotPath, 'allowed');
  const { sanitizeFile } = require('../electron/lib/data-migration-policy.cjs');
  assert.equal(Object.hasOwn(sanitizeFile('settings.json', state), 'languageSelectionPending'), false);
});

test('system-language matching uses supported families without changing old persisted choices', () => {
  for (const [input, expected] of [['zh-Hant-HK', 'zh-TW'], ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-CN', 'zh-CN'],
    ['en-GB', 'en-US'], ['ja-JP', 'ja-JP'], ['ko-KR', 'ko-KR'], ['fr-FR', 'zh-CN']]) assert.equal(localization.matchSystemLocale([input]), expected);
  assert.equal(localization.matchSystemLocale(['fr-FR', 'ko-KR']), 'ko-KR');
  assert.equal(localization.matchSystemLocale([]), 'zh-CN');
});
