const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../electron/lib/updater.cjs'), 'utf8');
function fixture({ locale = 'zh-CN', platform = 'win32', isDev = false } = {}) {
  const app = new EventEmitter(), updater = new EventEmitter(), powerMonitor = new EventEmitter();
  const environment = {}; const calls = []; let changed; let disposed = false;
  updater.quitAndInstall = (...args) => calls.push({ args, locale: environment.VEYLO_UPDATE_LANGUAGE });
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,process){${source}\n})`);
  load(name => {
    if (name === 'electron') return { app, powerMonitor };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === './localization.cjs') return { tr: value => value, getLocale: () => locale,
      onLocaleChanged: callback => { changed = callback; return () => { disposed = true; }; } };
    if (name === './app-context.cjs') return { isDev, getMainWindow: () => null, getLogAnalyzerWindow: () => null };
    if (name === './version.cjs') return { getAppVersion: () => '4.7.6', compareVersions: () => 0 };
    if (name === './android-tool-cleanup.cjs') return { cleanupAndroidToolProcesses: async () => {} };
    if (name === './update-poller.cjs') return { createUpdatePoller: () => assert.fail('Unexpected poller in locale-only fixture') };
    if (name === 'node:util') return require(name);
    throw new Error(`Unexpected test dependency: ${name}`);
  }, module, module.exports, { platform, arch: 'x64', env: environment });
  return { app, updater, environment, calls, api: module.exports, setLocale: changed,
    ready: () => updater.emit('update-downloaded', { version: '4.7.7' }), disposed: () => disposed };
}

test('explicit update install hands off the latest supported app language without changing native arguments', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    const f = fixture({ locale: 'en-US' }); f.ready(); f.setLocale(locale);
    assert.equal(f.api.quitAndInstallPreparedUpdate(), true);
    assert.deepEqual(f.calls, [{ args: [], locale }]);
    assert.deepEqual(f.environment, { VEYLO_UPDATE_LANGUAGE: locale });
  }
});

test('automatic quit prepares language before an already registered native quit installer handler', () => {
  const f = fixture({ locale: 'en-US' });
  f.app.on('quit', () => f.calls.push({ automaticLocale: f.environment.VEYLO_UPDATE_LANGUAGE }));
  f.ready(); f.setLocale('zh-CN'); f.app.emit('quit', {}, 0);
  assert.deepEqual(f.calls, [{ automaticLocale: 'zh-CN' }]); assert.equal(f.disposed(), true);
});

test('non-update quits, development and other platforms do not create a language handoff', () => {
  const fresh = fixture(); assert.equal(fresh.api.quitAndInstallPreparedUpdate(), false); fresh.app.emit('quit', {}, 0);
  assert.deepEqual(fresh.environment, {}); assert.deepEqual(fresh.calls, []);
  for (const options of [{ platform: 'darwin' }, { platform: 'linux' }, { isDev: true }]) {
    const f = fixture(options); f.ready(); f.api.quitAndInstallPreparedUpdate(); f.app.emit('quit', {}, 0);
    assert.deepEqual(f.environment, {});
  }
});

test('invalid or stale transfer values cannot become installer locale data', () => {
  for (const locale of ['EN-US', 'en', 'fr-FR', 'zh-CN --command', '', null]) {
    const f = fixture(); f.environment.VEYLO_UPDATE_LANGUAGE = 'stale'; f.ready(); f.setLocale(locale);
    f.api.quitAndInstallPreparedUpdate(); assert.deepEqual(f.environment, {});
  }
});
