const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../electron/lib/updater.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fakeClock() {
  let now = 0; let sequence = 0; const timers = new Map();
  return { now: () => now, timers,
    schedule(callback, delay) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    cancel: id => timers.delete(id), jump: delay => { now += delay; },
    async advance(delay) {
      const end = now + delay;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await tick();
      }
      now = end; await tick();
    },
  };
}
function harness({ development = false, clock, launch = async () => ({ ok: true, code: 'READY', installerPid: 5252 }) } = {}) {
  const handlers = new Map(); const events = []; const calls = { checks: 0, downloads: 0, wakes: 0, disposals: 0, quits: 0, pollers: 0, launches: 0 };
  const app = new EventEmitter(); app.quit = () => calls.quits++;
  const powerMonitor = new EventEmitter(); const updater = new EventEmitter();
  const main = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: (_channel, event) => events.push(structuredClone(event)) } };
  const analyzer = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send() {} } };
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  let generation = 0; let enabled = false; let disposed = false; let options;
  let poller = {
    setEnabled(value) { if (enabled !== value) generation++; enabled = value; },
    wake() { calls.wakes++; }, dispose() { if (!disposed) { disposed = true; generation++; calls.disposals++; } },
    snapshot: () => ({ enabled, disposed }),
  };
  let check = async () => ({ updateInfo: { version: '4.7.2' }, isUpdateAvailable: false });
  let download = async () => { updater.emit('update-downloaded', { version: '4.7.3' }); return ['fixture-update.exe']; };
  updater.checkForUpdates = () => { calls.checks++; return check(); };
  updater.downloadUpdate = () => { calls.downloads++; return download(); };
  updater.quitAndInstall = () => {};
  updater.installerPath = 'C:\\Updater\\fixture.exe';
  updater.downloadedUpdateHelper = { downloadedFileInfo: { sha512: 'fixture-digest' } };
  const retryDelays = []; const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout,console){\n${source}\n})`, { filename: 'updater-service-fixture.cjs' });
  load(name => {
    if (name === 'electron') return { app, powerMonitor };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === './app-context.cjs') return { isDev: development, getMainWindow: () => main, getLogAnalyzerWindow: () => analyzer };
    if (name === './version.cjs') return { getAppVersion: () => '4.7.2', compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }) };
    if (name === './android-tool-cleanup.cjs') return { cleanupAndroidToolProcesses: async () => ({ ok: true }) };
    if (name === './update-installer-launch.cjs') return { launchUpdateInstaller: value => { calls.launches++; return launch(value); } };
    if (name === './feedback.cjs') return { record() {} };
    if (name === './localization.cjs') return require('../electron/lib/localization.cjs');
    if (name === './update-poller.cjs') return { createUpdatePoller(value) {
      calls.pollers++; options = value;
      if (clock) poller = require('../electron/lib/update-poller.cjs').createUpdatePoller({ ...value, ...clock });
      return poller;
    } };
    if (name === 'node:util') return require(name);
    if (name === 'node:path') return require(name);
    throw new Error(`Unexpected test dependency: ${name}`);
  }, module, module.exports, (callback, ms) => { retryDelays.push(ms); queueMicrotask(callback); return retryDelays.length; }, () => {}, { log() {}, warn() {}, error() {} });
  module.exports.register({ handle: (name, callback) => handlers.set(name, callback) });
  return { app, powerMonitor, updater, calls, events, retryDelays, main, analyzer, event,
    invoke: (name, value, owner = event(main)) => handlers.get(`updater:${name}`)(owner, value),
    setCheck: value => { check = value; }, setDownload: value => { download = value; },
    auto: () => { const epoch = generation; return options.run(() => enabled && !disposed && epoch === generation); },
    canRun: () => options.canRun(), poller: () => poller.snapshot(), api: module.exports };
}
const available = { updateInfo: { version: '4.7.3' }, isUpdateAvailable: true };

test('real poller and updater compose through configure IPC, two-hour intervals, resume, ready state and shutdown', async () => {
  const clock = fakeClock(); const h = harness({ clock });
  await h.invoke('configure-auto', { enabled: true });
  assert.equal(clock.timers.size, 1); assert.equal(h.poller().nextDueAt, 3000);
  await clock.advance(2999); assert.equal(h.calls.checks, 0);
  await clock.advance(1); assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 0);
  assert.equal((await h.invoke('status')).notAvailable, true);
  assert.ok(h.events.some(event => event.eventName === 'state' && event.payload.notAvailable === true && event.payload.checking === false && event.payload.currentVersion === '4.7.2'));
  await clock.advance(7200000); assert.equal(h.calls.checks, 2); assert.equal(clock.timers.size, 1);
  await h.invoke('configure-auto', { enabled: false }); assert.equal(clock.timers.size, 0);
  await clock.advance(7200000 * 3); assert.equal(h.calls.checks, 2);
  await h.invoke('configure-auto', { enabled: true });
  h.app.emit('before-quit', { preventDefault() {} }); assert.equal(h.poller().disposed, false);
  clock.jump(7200000 * 3);
  h.powerMonitor.emit('resume'); h.powerMonitor.emit('resume'); h.powerMonitor.emit('resume'); await tick();
  assert.equal(h.calls.checks, 3); assert.equal(clock.timers.size, 1); assert.equal(h.poller().nextDueAt, clock.now() + 7200000);
  h.setCheck(async () => available);
  await clock.advance(7200000); assert.equal(h.calls.checks, 4); assert.equal(h.calls.downloads, 1);
  assert.equal((await h.invoke('status')).downloaded, true);
  await clock.advance(7200000 * 4); assert.equal(h.calls.checks, 4); assert.equal(h.calls.downloads, 1);
  h.app.emit('will-quit'); assert.equal(clock.timers.size, 0); assert.equal(h.poller().disposed, true);
  assert.equal(h.powerMonitor.listenerCount('resume'), 0);
  await clock.advance(7200000); h.powerMonitor.emit('resume'); await tick();
  assert.equal(h.calls.checks, 4); assert.equal(h.calls.downloads, 1);
});

test('real poller re-enable catches up after an old check without downloading its invalidated result', async () => {
  const clock = fakeClock(); const h = harness({ clock }); const old = deferred();
  h.setCheck(() => h.calls.checks === 1 ? old.promise : Promise.resolve({ updateInfo: { version: '4.7.2' }, isUpdateAvailable: false }));
  await h.invoke('configure-auto', { enabled: true }); await clock.advance(3000); assert.equal(h.calls.checks, 1);
  await h.invoke('configure-auto', { enabled: false }); await h.invoke('configure-auto', { enabled: true });
  await clock.advance(3000); assert.equal(h.calls.checks, 1);
  old.resolve(available); await tick();
  assert.equal(h.calls.checks, 2); assert.equal(h.calls.downloads, 0);
  assert.equal((await h.invoke('status')).notAvailable, true); assert.equal(clock.timers.size, 1);
  h.app.emit('will-quit'); assert.equal(clock.timers.size, 0);
});

test('manual and automatic checks plus a queued download share one native check and one download', async () => {
  const h = harness(); const pending = deferred(); h.setCheck(() => pending.promise);
  await h.invoke('configure-auto', { enabled: true });
  const manual = h.invoke('check'); const automatic = h.auto(); const download = h.invoke('download');
  await tick(); assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 0);
  pending.resolve(available); assert.equal((await manual).available, true);
  await Promise.all([automatic, download]); assert.equal(h.calls.downloads, 1);
  const status = await h.invoke('status'); assert.equal(status.downloaded, true); assert.equal(status.notAvailable, false);
  assert.ok(h.events.some(event => event.eventName === 'state' && event.payload.downloaded));
});

test('a check during download waits for its shared result without a cycle or a second native check', async () => {
  const h = harness(); h.setCheck(async () => available); await h.invoke('check');
  const pending = deferred(); h.setDownload(() => pending.promise);
  const download = h.invoke('download'); await tick();
  const check = h.invoke('check'); const duplicate = h.invoke('download');
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 1);
  h.updater.emit('update-downloaded', available.updateInfo); pending.resolve(['fixture-update.exe']);
  await Promise.all([download, duplicate]); const result = await check;
  assert.equal(result.available, true); assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 1);
});

test('ready updates pause automatic checks and redundant downloads while manual checks refresh without losing readiness', async () => {
  const h = harness(); h.setCheck(async () => available); await h.invoke('check'); await h.invoke('download');
  await h.invoke('configure-auto', { enabled: true }); await h.auto(); await h.invoke('check'); await h.invoke('download');
  h.updater.emit('checking-for-update'); h.updater.emit('update-not-available', { version: '4.7.2' });
  h.updater.emit('download-progress', { percent: 10 });
  const status = await h.invoke('status');
  assert.equal(h.calls.checks, 2); assert.equal(h.calls.downloads, 1); assert.equal(status.downloaded, true);
  assert.equal(status.checking, false); assert.equal(status.available, true); assert.equal(status.info.version, '4.7.3');
  assert.equal(h.canRun(), false);
});

test('manual ready refresh shares one check and downloads only the confirmed newer candidate after that check settles', async () => {
  const h = harness(); const old = { version: '4.7.23' }, newer = { version: '4.7.24' };
  h.updater.emit('update-downloaded', old);
  const checking = deferred(), downloading = deferred(); let checkSettled = false;
  h.setCheck(() => checking.promise.finally(() => { checkSettled = true; }));
  h.setDownload(() => { assert.equal(checkSettled, true); return downloading.promise; });
  const refresh = h.invoke('check'), duplicate = h.invoke('check'), download = h.invoke('download');
  assert.equal(duplicate, refresh); assert.equal(download, refresh);
  assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), false);
  assert.equal((await h.invoke('install')).success, false);
  assert.equal((await h.api.beginUpdateInstall()).ok, false);
  assert.equal(h.api.quitAndInstallPreparedUpdate(), false);
  await tick(); let state = await h.invoke('status');
  assert.equal(state.refreshing, true); assert.equal(state.checking, true); assert.equal(state.downloaded, true); assert.equal(state.info.version, old.version);
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 0); assert.equal(h.calls.quits, 0); assert.equal(h.calls.launches, 0);
  h.updater.emit('update-available', newer);
  checking.resolve({ updateInfo: newer, isUpdateAvailable: true }); await tick();
  state = await h.invoke('status');
  assert.equal(state.refreshing, true); assert.equal(state.downloaded, false); assert.equal(state.downloading, true); assert.equal(state.info.version, newer.version);
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 1);
  assert.equal((await h.invoke('install')).success, false);
  assert.equal(h.invoke('check'), refresh); assert.equal(h.invoke('download'), refresh);
  h.updater.emit('update-downloaded', newer); downloading.resolve(['fixture-latest.exe']);
  const result = await refresh; await Promise.all([duplicate, download]);
  assert.equal(result.success, true); assert.equal(result.available, true); assert.equal(result.info.version, newer.version);
  state = await h.invoke('status');
  assert.equal(state.downloaded, true); assert.equal(state.refreshing, false); assert.equal(state.downloading, false);
  assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), true);
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 1);
});

test('same, lower and unavailable newer candidates preserve the old ready package after a real manual check', async () => {
  for (const result of [{ updateInfo: { version: '4.7.23' }, isUpdateAvailable: true },
    { updateInfo: { version: '4.7.22' }, isUpdateAvailable: true },
    { updateInfo: { version: '4.7.24' }, isUpdateAvailable: false }, null]) {
    const h = harness(); h.updater.emit('update-downloaded', { version: '4.7.23' });
    h.setCheck(async () => result);
    const response = await h.invoke('check'), state = await h.invoke('status');
    assert.equal(response.success, true); assert.equal(response.info.version, '4.7.23');
    assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 0);
    assert.equal(state.downloaded, true); assert.equal(state.info.version, '4.7.23');
    assert.equal(state.checking, false); assert.equal(state.refreshing, false); assert.equal(state.error, null);
    assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), true);
  }
});

test('actual vendor checks preserve the downloaded helper path and digest for an acknowledged old-package install', async () => {
  const { AppUpdater } = require('electron-updater/out/AppUpdater');
  const { BaseUpdater } = require('electron-updater/out/BaseUpdater');
  const { DownloadedUpdateHelper } = require('electron-updater/out/DownloadedUpdateHelper');
  const semver = require('node:module').createRequire(require.resolve('electron-updater/out/AppUpdater'))('semver');
  for (const [version, eligible, networkFailure] of [['4.7.23', true, false], ['4.7.22', true, false],
    ['4.7.24', false, false], ['4.7.24', true, true]]) {
    const launches = []; const h = harness({ launch: async input => { launches.push(input); return { ok: true, code: 'READY', installerPid: 5252 }; } });
    const helper = new DownloadedUpdateHelper('C:\\OwnedFixtureCacheNeverAccessed');
    helper._file = 'C:\\OwnedFixtureCacheNeverAccessed\\pending\\setup-4.7.23.exe';
    helper._downloadedFileInfo = { fileName: 'setup-4.7.23.exe', sha512: 'verified-old-fixture-digest' };
    helper.clear = async () => assert.fail('a check that retains readiness must not clear the valid cached package');
    h.updater.downloadedUpdateHelper = helper;
    Object.defineProperty(h.updater, 'installerPath', { get: Object.getOwnPropertyDescriptor(BaseUpdater.prototype, 'installerPath').get });
    Object.assign(h.updater, { _logger: { info() {}, warn() {}, debug() {} }, currentVersion: semver.parse('4.7.2'),
      allowDowngrade: false, isUpdateSupported: () => true, isUserWithinRollout: () => eligible,
      isUpdaterActive: () => true, isUpdateAvailable: AppUpdater.prototype.isUpdateAvailable,
      doCheckForUpdates: AppUpdater.prototype.doCheckForUpdates, onUpdateAvailable: AppUpdater.prototype.onUpdateAvailable,
      getUpdateInfoAndProvider: async () => {
        if (networkFailure) throw new Error('PRIVATE_VENDOR_CHECK_FAILURE');
        return { info: { version, files: [{ url: 'fixture-not-requested.exe' }] }, provider: {} };
      },
    });
    h.setCheck(() => AppUpdater.prototype.checkForUpdates.call(h.updater));
    h.updater.emit('update-downloaded', { version: '4.7.23' });
    assert.equal((await h.invoke('check')).success, !networkFailure);
    assert.equal(h.updater.downloadedUpdateHelper, helper); assert.equal(h.updater.installerPath, helper._file);
    assert.equal(helper.downloadedFileInfo.sha512, 'verified-old-fixture-digest');
    assert.equal((await h.invoke('status')).downloaded, true); assert.equal(h.calls.downloads, 0);
    assert.equal((await h.api.beginUpdateInstall()).ok, true);
    assert.equal(launches[0].installerPath, helper._file); assert.equal(launches[0].sha512, helper.downloadedFileInfo.sha512);
  }
});

test('failed ready checks retain the old package and release refresh locks for a successful newer retry', async () => {
  const h = harness(); h.updater.emit('update-downloaded', { version: '4.7.23' });
  h.setCheck(async () => { throw new Error('PRIVATE_REFRESH_FAILURE'); });
  const failure = await h.invoke('check'); let state = await h.invoke('status');
  assert.equal(failure.success, false); assert.doesNotMatch(failure.error, /PRIVATE/);
  assert.equal(state.downloaded, true); assert.equal(state.info.version, '4.7.23'); assert.equal(state.refreshing, false);
  assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), true); assert.equal(h.calls.downloads, 0);
  h.setCheck(async () => ({ updateInfo: { version: '4.7.24' }, isUpdateAvailable: true }));
  h.setDownload(async () => { h.updater.emit('update-downloaded', { version: '4.7.24' }); return ['fixture-latest.exe']; });
  const retried = await h.invoke('check'); state = await h.invoke('status');
  assert.equal(retried.success, true); assert.equal(retried.info.version, '4.7.24');
  assert.equal(state.downloaded, true); assert.equal(state.refreshing, false); assert.equal(state.error, null);
  assert.equal(h.calls.checks, 2); assert.equal(h.calls.downloads, 1);
});

test('ready-refresh retries remain single-flight with automatic checks and keep the old package locked until completion', async () => {
  const h = harness(), finalCheck = deferred(); h.updater.emit('update-downloaded', { version: '4.7.23' });
  h.setCheck(() => {
    assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), false);
    if (h.calls.checks < 3) {
      const error = Object.assign(new Error('PRIVATE_TRANSIENT_FAILURE'), { code: 'ETIMEDOUT' });
      h.updater.emit('error', error); throw error;
    }
    return finalCheck.promise;
  });
  h.setDownload(async () => { h.updater.emit('update-downloaded', { version: '4.7.24' }); return ['fixture-latest.exe']; });
  const manual = h.invoke('check'); await tick();
  const automatic = h.auto(), download = h.invoke('download');
  assert.equal(h.calls.checks, 3); assert.equal(h.calls.downloads, 0); assert.equal(h.invoke('check'), manual);
  const pending = await h.invoke('status'); assert.equal(pending.refreshing, true); assert.equal(pending.downloaded, true);
  assert.equal(pending.info.version, '4.7.23'); assert.equal((await h.invoke('install')).success, false);
  finalCheck.resolve({ updateInfo: { version: '4.7.24' }, isUpdateAvailable: true });
  const results = await Promise.all([manual, automatic, download]);
  assert.ok(results.every(result => result.success && result.info.version === '4.7.24'));
  assert.deepEqual(h.retryDelays, [2000, 5000]); assert.equal(h.calls.downloads, 1);
  assert.equal((await h.invoke('status')).refreshing, false);
});

test('latest-download failure never reinstates the older ready state and explicit download can retry the newer candidate', async () => {
  const h = harness(); h.updater.emit('update-downloaded', { version: '4.7.23' });
  h.setCheck(async () => ({ updateInfo: { version: '4.7.24' }, isUpdateAvailable: true }));
  h.setDownload(async () => { throw new Error('PRIVATE_LATEST_DOWNLOAD_FAILURE'); });
  const result = await h.invoke('check'); let state = await h.invoke('status');
  assert.equal(result.success, false); assert.equal(state.downloaded, false); assert.equal(state.info.version, '4.7.24');
  assert.equal(state.refreshing, false); assert.equal(state.downloading, false); assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), false);
  assert.equal((await h.invoke('install')).success, false);
  h.setDownload(async () => { h.updater.emit('update-downloaded', { version: '4.7.24' }); return ['fixture-latest.exe']; });
  assert.equal((await h.invoke('download')).success, true); state = await h.invoke('status');
  assert.equal(state.downloaded, true); assert.equal(state.info.version, '4.7.24');
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.downloads, 2);
});

test('a ready event before the old download promise settles cannot create a refresh/check/download cycle', async () => {
  const h = harness(); h.setCheck(async () => available); await h.invoke('check');
  const oldDownload = deferred(); h.setDownload(() => oldDownload.promise);
  const first = h.invoke('download'); await tick(); h.updater.emit('update-downloaded', available.updateInfo);
  h.setCheck(async () => ({ updateInfo: { version: '4.7.24' }, isUpdateAvailable: true }));
  const refresh = h.invoke('check'); await tick();
  assert.equal(h.calls.checks, 1); assert.equal(h.api.shouldInstallDownloadedUpdateOnQuit(), false);
  h.setDownload(async () => { h.updater.emit('update-downloaded', { version: '4.7.24' }); return ['fixture-latest.exe']; });
  oldDownload.resolve(['fixture-old.exe']); await first;
  const result = await refresh;
  assert.equal(result.success, true); assert.equal(result.info.version, '4.7.24');
  assert.equal(h.calls.checks, 2); assert.equal(h.calls.downloads, 2);
});

test('manual checks and downloads cannot mutate an active installer handoff or quitting updater', async () => {
  const launching = deferred(); const h = harness({ launch: () => launching.promise });
  h.updater.emit('update-downloaded', { version: '4.7.23' });
  const handoff = h.api.beginUpdateInstall(); await tick();
  assert.equal((await h.invoke('check')).success, false); assert.equal((await h.invoke('download')).success, false);
  assert.equal(h.calls.checks, 0); assert.equal(h.calls.downloads, 0);
  launching.resolve({ ok: true, code: 'READY', installerPid: 5252 }); await handoff;
  assert.equal((await h.invoke('check')).success, false); assert.equal((await h.invoke('download')).success, false);
  assert.equal(h.api.quitAndInstallPreparedUpdate(), true);
  assert.equal((await h.invoke('check')).success, false);
  const closed = harness(); closed.updater.emit('update-downloaded', { version: '4.7.23' }); closed.app.emit('will-quit');
  assert.equal((await closed.invoke('check')).success, false); assert.equal(closed.calls.checks, 0);
});

test('disabling during an automatic check invalidates only its future download; manual download remains available', async () => {
  const h = harness(); const pending = deferred(); h.setCheck(() => pending.promise);
  await h.invoke('configure-auto', { enabled: true }); const automatic = h.auto(); await tick();
  assert.deepEqual(await h.invoke('configure-auto', { enabled: false }), { success: true, enabled: false });
  pending.resolve(available); await automatic; assert.equal(h.calls.downloads, 0);
  assert.equal((await h.invoke('status')).available, true);
  await h.invoke('download'); assert.equal(h.calls.downloads, 1);
});

test('disabling after automatic download starts does not cancel or discard the pending update', async () => {
  const h = harness(); h.setCheck(async () => available); const pending = deferred(); h.setDownload(() => pending.promise);
  await h.invoke('configure-auto', { enabled: true }); const automatic = h.auto(); await tick();
  assert.equal(h.calls.downloads, 1); await h.invoke('configure-auto', { enabled: false });
  assert.equal((await h.invoke('status')).downloading, true);
  h.updater.emit('update-downloaded', available.updateInfo); pending.resolve(['fixture-update.exe']); await automatic;
  assert.equal((await h.invoke('status')).downloaded, true);
});

test('configure-auto accepts only the current main frame and one boolean field', async () => {
  const h = harness(); const foreign = { sender: {}, senderFrame: {} }; const subframe = { sender: h.main.webContents, senderFrame: {} };
  for (const event of [foreign, subframe, h.event(h.analyzer)]) assert.equal((await h.invoke('configure-auto', { enabled: true }, event)).success, false);
  let getterRead = false;
  for (const value of [null, true, {}, { enabled: 1 }, { enabled: 'true' }, { enabled: true, extra: 1 }, { get enabled() { getterRead = true; return true; } }, new Proxy({ enabled: true }, {})]) {
    assert.equal((await h.invoke('configure-auto', value)).success, false);
  }
  assert.equal(getterRead, false); assert.equal(h.poller().enabled, false);
  const stale = h.event(h.main); h.main.webContents.mainFrame = {};
  assert.equal((await h.invoke('configure-auto', { enabled: true }, stale)).success, false);
  assert.deepEqual(await h.invoke('configure-auto', { enabled: true }), { success: true, enabled: true });
  assert.equal(h.calls.pollers, 1); assert.deepEqual(await h.invoke('configure-auto', { enabled: true }), { success: true, enabled: true });
});

test('resume wakes the scheduler, canceled quits keep it alive, and only will-quit disposes it', async () => {
  const h = harness(); await h.invoke('configure-auto', { enabled: true });
  h.powerMonitor.emit('resume'); assert.equal(h.calls.wakes, 1);
  h.app.emit('before-quit', { preventDefault() {} }); assert.equal(h.calls.disposals, 0);
  h.app.emit('will-quit'); assert.equal(h.calls.disposals, 1);
  h.powerMonitor.emit('resume'); assert.equal(h.calls.wakes, 1);
  assert.equal((await h.invoke('configure-auto', { enabled: true })).success, false);
});

test('development mode never sends native update traffic, even with enabled automatic updates', async () => {
  const h = harness({ development: true }); await h.invoke('configure-auto', { enabled: true });
  assert.equal(h.canRun(), false); await h.auto();
  assert.equal((await h.invoke('check')).success, false); assert.equal((await h.invoke('download')).success, false);
  assert.equal(h.calls.checks, 0); assert.equal(h.calls.downloads, 0);
});

test('the entire retry chain is single-flight and retains the existing retry delays', async () => {
  const h = harness(); h.setCheck(async () => { if (h.calls.checks < 3) throw Object.assign(new Error('fixture'), { code: 'ETIMEDOUT' }); return available; });
  const replies = await Promise.all([h.invoke('check'), h.invoke('check'), h.invoke('check')]);
  assert.ok(replies.every(reply => reply.success && reply.available)); assert.equal(h.calls.checks, 3);
  assert.deepEqual(h.retryDelays, [2000, 5000]); assert.equal(h.events.filter(event => event.eventName === 'retry').length, 2);
});

test('download retries are shared, preserve native events and finish in the ready state', async () => {
  const h = harness(); h.setCheck(async () => available); await h.invoke('check');
  h.setDownload(async () => {
    if (h.calls.downloads < 3) {
      const error = Object.assign(new Error('fixture temporary failure'), { statusCode: 503 });
      h.updater.emit('error', error); throw error;
    }
    h.updater.emit('download-progress', { percent: 100, transferred: 123, total: 123, bytesPerSecond: 50 });
    h.updater.emit('update-downloaded', available.updateInfo); return ['fixture-update.exe'];
  });
  const results = await Promise.all([h.invoke('download'), h.invoke('download')]);
  assert.ok(results.every(result => result.success)); assert.equal(h.calls.downloads, 3);
  assert.deepEqual(h.retryDelays, [2000, 5000]);
  assert.equal(h.events.filter(event => event.eventName === 'update-downloaded').length, 1);
  assert.equal(h.events.filter(event => event.eventName === 'download-progress').length, 1);
  const status = await h.invoke('status'); assert.equal(status.downloaded, true); assert.equal(status.downloading, false); assert.equal(status.error, null);
});

test('a download queued behind a no-update or failed check never calls the native downloader', async () => {
  for (const fail of [false, true]) {
    const h = harness(); const pending = deferred(); h.setCheck(() => pending.promise);
    const check = h.invoke('check'); const download = h.invoke('download'); await tick();
    if (fail) pending.reject(new Error('fixture failed check'));
    else pending.resolve({ updateInfo: { version: '4.7.2' }, isUpdateAvailable: false });
    await check; assert.equal((await download).success, false); assert.equal(h.calls.downloads, 0);
    assert.equal((await h.invoke('status')).downloading, false);
  }
});

test('equal versions and native unsupported/rollout results never trigger automatic download', async () => {
  for (const result of [{ updateInfo: { version: '4.7.2' }, isUpdateAvailable: true }, { ...available, isUpdateAvailable: false }, null]) {
    const h = harness(); h.setCheck(async () => result); await h.invoke('configure-auto', { enabled: true }); await h.auto();
    assert.equal(h.calls.downloads, 0); const status = await h.invoke('status'); assert.equal(status.available, false); assert.equal(status.notAvailable, true);
  }
});

test('failed operations release the shared flight and broadcast a sanitized complete state', async () => {
  const h = harness(); h.setCheck(async () => { throw new Error('PRIVATE_FIXTURE_TOKEN'); });
  const failed = await h.invoke('check'); assert.equal(failed.success, false); assert.doesNotMatch(failed.error, /PRIVATE/);
  const status = await h.invoke('status'); assert.equal(status.checking, false); assert.equal(status.error, failed.error);
  assert.ok(h.events.some(event => event.eventName === 'state' && event.payload.error === failed.error));
  h.setCheck(async () => available); assert.equal((await h.invoke('check')).available, true); assert.equal(h.calls.checks, 2);
});

test('preload exposes only a typed configure-auto method with the exact boolean payload', () => {
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => calls.push(args) },
  }) });
  api.configureAutoUpdates(true); assert.equal(calls[0][0], 'updater:configure-auto');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { enabled: true });
});
