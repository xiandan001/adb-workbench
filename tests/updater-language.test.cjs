const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../electron/lib/updater.cjs'), 'utf8');
function fixture({ locale = 'zh-CN', platform = 'win32', isDev = false, pid = 4242, execPath = 'C:\\Veylo\\卓控台.exe', cleanup = async () => ({ ok: true }), launch = async () => ({ ok: true, code: 'READY', installerPid: 5252 }) } = {}) {
  const app = new EventEmitter(), updater = new EventEmitter(), powerMonitor = new EventEmitter();
  const environment = {}; const calls = []; const launches = []; const records = []; let changed; let disposed = false;
  app.quit = () => calls.push({ quit: true });
  updater.installerPath = 'C:\\Updater\\setup.exe'; updater.downloadedUpdateHelper = { downloadedFileInfo: { sha512: 'fixture-digest' } };
  updater.quitAndInstall = (...args) => calls.push({ args, locale: environment.VEYLO_UPDATE_LANGUAGE,
    pid: environment.VEYLO_UPDATE_PID, execPath: environment.VEYLO_UPDATE_EXE });
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,process){${source}\n})`);
  load(name => {
    if (name === 'electron') return { app, powerMonitor };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === './localization.cjs') return { tr: value => value, getLocale: () => locale,
      onLocaleChanged: callback => { changed = callback; return () => { disposed = true; }; } };
    if (name === './app-context.cjs') return { isDev, getMainWindow: () => null, getLogAnalyzerWindow: () => null };
    if (name === './version.cjs') return { getAppVersion: () => '4.7.6', compareVersions: () => 0 };
    if (name === './android-tool-cleanup.cjs') return { cleanupAndroidToolProcesses: cleanup };
    if (name === './update-poller.cjs') return { createUpdatePoller: () => assert.fail('Unexpected poller in locale-only fixture') };
    if (name === './update-installer-launch.cjs') return { launchUpdateInstaller: value => { launches.push(value); return launch(value); } };
    if (name === './feedback.cjs') return { record: value => records.push(value) };
    if (name === 'node:util') return require(name);
    if (name === 'node:path') return path.win32;
    throw new Error(`Unexpected test dependency: ${name}`);
  }, module, module.exports, { platform, arch: 'x64', env: environment, pid, execPath });
  return { app, updater, environment, calls, launches, records, api: module.exports, setLocale: changed,
    ready: () => updater.emit('update-downloaded', { version: '4.7.7' }), disposed: () => disposed };
}

test('Windows install hands off the latest locale and may quit only after actual installer readiness', async () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    const f = fixture({ locale: 'en-US' }); f.ready(); f.setLocale(locale);
    assert.equal(f.api.quitAndInstallPreparedUpdate(), false);
    assert.equal((await f.api.beginUpdateInstall()).ok, true);
    assert.equal(f.api.quitAndInstallPreparedUpdate(), true);
    assert.deepEqual(f.calls, [{ quit: true }]);
    assert.equal(f.updater.autoInstallOnAppQuit, false);
    assert.deepEqual(f.launches, [{ installerPath: 'C:\\Updater\\setup.exe', parentPid: 4242, locale, sha512: 'fixture-digest' }]);
  }
});

test('automatic quit prepares language before an already registered native quit installer handler', () => {
  const f = fixture({ locale: 'en-US' });
  f.app.on('quit', () => f.calls.push({ automaticLocale: f.environment.VEYLO_UPDATE_LANGUAGE,
    pid: f.environment.VEYLO_UPDATE_PID, execPath: f.environment.VEYLO_UPDATE_EXE }));
  f.ready(); f.setLocale('zh-CN'); f.app.emit('quit', {}, 0);
  assert.deepEqual(f.calls, [{ automaticLocale: 'zh-CN', pid: '4242', execPath: 'C:\\Veylo\\卓控台.exe' }]); assert.equal(f.disposed(), true);
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
    f.app.emit('quit'); assert.equal(f.environment.VEYLO_UPDATE_LANGUAGE, undefined);
    assert.equal(f.environment.VEYLO_UPDATE_PID, '4242');
  }
});

test('invalid identity and development or non-Windows installs clear stale process handoff data', () => {
  for (const options of [{ pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: NaN }, { execPath: 'Veylo.exe' }, { execPath: null }, { platform: 'linux' }, { isDev: true }]) {
    const f = fixture(options); Object.assign(f.environment, { VEYLO_UPDATE_PID: 'stale', VEYLO_UPDATE_EXE: 'stale' });
    f.ready(); f.app.emit('quit');
    assert.equal(f.environment.VEYLO_UPDATE_PID, undefined);
    assert.equal(f.environment.VEYLO_UPDATE_EXE, undefined);
  }
});

test('late launch failures, cancellation and timeouts keep the app alive and reset a retryable flight', async () => {
  for (const code of ['UAC_CANCELLED', 'START_FAILED', 'INSTALLER_EXITED', 'READY_TIMEOUT', 'HELPER_TIMEOUT', 'PROTOCOL_ERROR']) {
    let release; let attempt = 0;
    const f = fixture({ launch: () => ++attempt === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, code: 'READY', installerPid: 5252 }) });
    f.ready(); const first = f.api.beginUpdateInstall();
    const duplicate = f.api.beginUpdateInstall(); assert.equal(duplicate, first);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.launches.length, 1); assert.deepEqual(f.calls, []);
    assert.equal(f.api.quitAndInstallPreparedUpdate(), false); assert.equal(f.api.isQuitAndInstallInProgress(), false);
    release({ ok: false, code }); assert.equal((await first).ok, false);
    assert.deepEqual(f.calls, []); assert.equal(f.api.isQuitAndInstallInProgress(), false);
    assert.ok(f.records.some(value => value.installPhase === 'failed' && value.installCode === code));
    assert.equal((await f.api.beginUpdateInstall()).ok, true); assert.equal(f.launches.length, 2);
    assert.equal(f.api.quitAndInstallPreparedUpdate(), true); assert.deepEqual(f.calls, [{ quit: true }]);
  }
});

test('corrupted or missing update packages invalidate only the updater cache and permit redownload', async () => {
  for (const code of ['CHECKSUM_MISMATCH', 'INVALID_INSTALLER']) {
    let cleared = 0; const f = fixture({ launch: async () => ({ ok: false, code }) });
    f.updater.downloadedUpdateHelper.clear = async () => { cleared++; };
    f.ready(); assert.equal((await f.api.beginUpdateInstall()).ok, false);
    assert.equal(cleared, 1); assert.equal(f.api.shouldInstallDownloadedUpdateOnQuit(), false);
    assert.deepEqual(f.calls, []);
  }
});

test('update preparation includes only bundled tools and records success only after confirmed cleanup', async () => {
  const options = []; let success = false;
  const f = fixture({ cleanup: async value => { options.push(value); return { ok: success }; } });
  await assert.rejects(f.api.prepareForUpdateInstall(), /UPDATE_TOOL_CLEANUP_FAILED/);
  success = true; await f.api.prepareForUpdateInstall(); await f.api.prepareForUpdateInstall();
  assert.equal(options.length, 2);
  for (const value of options) assert.deepEqual(value, { includeScrcpy: true, includeFastboot: true, includeHdc: true });
});
