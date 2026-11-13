const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFixtureSuite, bounded, delay } = require('./helpers/update-processes-fixture.cjs');

const toolFiles = ['scrcpy-win64/adb.exe', 'scrcpy-win64/scrcpy.exe', 'scrcpy-win64/fastboot.exe', 'hdc/hdc.exe'];

describe('shared update process script with isolated Windows native children', { skip: process.platform !== 'win32' }, () => {
  let suite;
  before(() => { suite = createFixtureSuite(); });
  after(async () => { if (suite) await suite.dispose(); });

  function installation(label) {
    const directory = path.join(label, "installed app's 设备");
    const app = suite.copy(path.join(directory, 'Veylo.exe'));
    const tools = toolFiles.map(file => suite.copy(path.join(directory, file)));
    return { root: path.dirname(app), app, tools };
  }
  function installerEnvironment(install, parent, expected = install.app) {
    return { VEYLO_INSTALLER_ROOT: install.root, VEYLO_INSTALLER_APP_EXE: install.app,
      VEYLO_UPDATE_PID: String(parent.pid), VEYLO_UPDATE_EXE: expected };
  }
  async function assertStopped(children) {
    await Promise.all(children.map(child => bounded(child.done, 3000, `owned PID ${child.pid} did not stop`)));
    assert.ok(children.every(child => !child.isAlive()));
  }

  test('StopTools stops only exact bundled executables, preserving external and adjacent same-name children', async () => {
    const install = installation('exact-paths');
    const owned = await Promise.all(install.tools.map(executable => suite.start(executable)));
    const external = await Promise.all([
      suite.copy('external-sdk/scrcpy-win64/adb.exe'), suite.copy('external-sdk/hdc/hdc.exe'),
      suite.copy(path.join('exact-paths', "installed app's 设备-backup", 'scrcpy-win64/adb.exe')),
      suite.copy(path.join('exact-paths', "installed app's 设备-backup", 'hdc/hdc.exe')),
    ].map(executable => suite.start(executable)));
    const result = await suite.invoke('StopTools', { targets: install.tools, timeoutMs: 3000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.ok, true);
    assert.deepEqual([...result.result.stopped].sort((a, b) => a - b), owned.map(child => child.pid).sort((a, b) => a - b));
    await assertStopped(owned);
    assert.ok(external.every(child => child.isAlive()), 'same filename outside the exact allow-list must survive');
  });

  test('actual 8.3 launch aliases match the canonical long executable path when aliases exist', async t => {
    const install = installation('short-path-alias');
    const short = suite.shortPath(install.tools[3]);
    if (short.toLowerCase() === install.tools[3].toLowerCase() || !short.includes('~')) {
      t.skip('this temporary volume does not supply an actual 8.3 alias');
      return;
    }
    const child = await suite.start(short);
    const result = await suite.invoke('StopTools', { targets: [install.tools[3]], timeoutMs: 3000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.result.stopped, [child.pid]);
    await assertStopped([child]);
  });

  test('PrepareInstall rejects a live PID with the wrong image without waiting or killing it or tools', async () => {
    const install = installation('identity-mismatch');
    const foreign = await suite.start(suite.copy('identity-mismatch/foreign/Veylo.exe'), { gate: 'foreign-parent.release' });
    const tool = await suite.start(install.tools[0]);
    const result = await suite.invoke('PrepareInstall', { timeoutMs: 7000 }, installerEnvironment(install, foreign));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.result.ok, false);
    assert.equal(result.result.parent, 'identity-mismatch');
    assert.ok(foreign.isAlive(), 'identity mismatch must not kill another process');
    assert.ok(tool.isAlive(), 'invalid parent identity must not proceed to tool cleanup');
  });

  test('PrepareInstall continues after an already-exited verified parent and stops bundled ADB/HDC', async () => {
    const install = installation('exited-parent');
    const parent = await suite.start(install.app, { gate: 'exited-parent.release' });
    parent.release();
    assert.equal((await bounded(parent.done, 3000, 'parent did not exit naturally')).code, 0);
    const tools = await Promise.all([install.tools[0], install.tools[3]].map(executable => suite.start(executable)));
    const result = await suite.invoke('PrepareInstall', { timeoutMs: 3000 }, installerEnvironment(install, parent));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.ok, true);
    await assertStopped(tools);
  });

  test('PrepareInstall waits for natural old-app exit before stopping any bundled tools', async () => {
    const install = installation('delayed-parent');
    const parent = await suite.start(install.app, { gate: 'delayed-parent.release' });
    const tools = await Promise.all(install.tools.map(executable => suite.start(executable)));
    const pending = suite.invoke('PrepareInstall', { timeoutMs: 15000 }, installerEnvironment(install, parent), { observeParentWait: true });
    let finished = false;
    pending.finally(() => { finished = true; }).catch(() => {});
    await pending.parentWait;
    await delay(200);
    assert.equal(finished, false, 'installer preparation must remain pending while the verified parent is alive');
    assert.ok(parent.isAlive(), 'installer preparation must never force-close the old main app');
    assert.ok(tools.every(child => child.isAlive()), 'tool cleanup must wait until natural old-app exit');
    parent.release();
    assert.equal((await bounded(parent.done, 3000, 'parent did not exit naturally')).code, 0);
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.parent, 'exited', 'the script must actually observe and wait on the live parent');
    await assertStopped(tools);
  });

  test('verified parent timeout is nonzero and leaves main app and bundled tools alive', async () => {
    const install = installation('parent-timeout');
    const parent = await suite.start(install.app, { gate: 'timed-out-parent.release' });
    const tools = await Promise.all([install.tools[0], install.tools[3]].map(executable => suite.start(executable)));
    const result = await suite.invoke('PrepareInstall', { timeoutMs: 300 }, installerEnvironment(install, parent));
    assert.equal(result.code, 3, result.stderr);
    assert.equal(result.result.ok, false);
    assert.equal(result.result.parent, 'timeout');
    assert.ok(parent.isAlive(), 'timeout must preserve the old main app and quit-cancellation protection');
    assert.ok(tools.every(child => child.isAlive()), 'timeout must not pretend the install was prepared');
  });

  test('manual installation waits for every exact main image without an updater PID and preserves other installations', async () => {
    const install = installation('manual-install');
    const mains = await Promise.all([0, 1].map(index => suite.start(install.app, { gate: `manual-main-${index}.release` })));
    const foreign = await suite.start(suite.copy('manual-install/other/Veylo.exe'), { gate: 'manual-foreign.release' });
    const tool = await suite.start(install.tools[0]);
    const pending = suite.invoke('PrepareInstall', { timeoutMs: 15000 }, {
      VEYLO_INSTALLER_ROOT: install.root, VEYLO_INSTALLER_APP_EXE: install.app,
    }, { observeParentWait: true });
    let finished = false;
    pending.finally(() => { finished = true; }).catch(() => {});
    await pending.parentWait;
    await delay(200);
    assert.ok(mains.every(child => child.isAlive()) && tool.isAlive());
    assert.equal(finished, false);
    mains[0].release();
    await bounded(mains[0].done, 3000, 'first manual main did not exit');
    await delay(200);
    assert.equal(finished, false, 'a second exact main instance must still block installation');
    mains[1].release();
    assert.equal((await bounded(mains[1].done, 3000, 'second manual main did not exit')).code, 0);
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.parent, 'not-requested');
    assert.equal(result.result.applications, 'exited');
    await assertStopped([tool]);
    assert.ok(foreign.isAlive(), 'another installation must not be waited on or terminated');
  });

  test('manual-install timeout leaves a same-image main and bundled tools untouched', async () => {
    const install = installation('manual-timeout');
    const main = await suite.start(install.app, { gate: 'manual-timeout.release' });
    const tool = await suite.start(install.tools[3]);
    const result = await suite.invoke('PrepareInstall', { timeoutMs: 300 }, {
      VEYLO_INSTALLER_ROOT: install.root, VEYLO_INSTALLER_APP_EXE: install.app,
    });
    assert.equal(result.code, 3, result.stderr);
    assert.equal(result.result.applications, 'timeout');
    assert.ok(main.isAlive() && tool.isAlive(), 'manual installation must not force close the app or clean tools on failure');
  });

  test('an external waiting host remains alive and cannot block replacement after the main app exits', async () => {
    const install = installation('external-waiting-host');
    const main = await suite.start(install.app, { gate: 'external-host-main.release' });
    const tool = await suite.start(install.tools[0]);
    const host = await suite.start(suite.copy('external-wait-host/VeyloInstallWait.exe'), { gate: 'external-host.release' });
    const pending = suite.invoke('PrepareInstall', { timeoutMs: 15000 }, installerEnvironment(install, main), { observeParentWait: true });
    let finished = false;
    pending.finally(() => { finished = true; }).catch(() => {});
    await pending.parentWait;
    await delay(200);
    assert.equal(finished, false);
    assert.ok(main.isAlive() && tool.isAlive() && host.isAlive());
    main.release();
    assert.equal((await bounded(main.done, 3000, 'main did not exit naturally')).code, 0);
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.parent, 'exited');
    await assertStopped([tool]);
    assert.ok(host.isAlive(), 'the external waiting UI host must not be waited on or stopped');
  });
});
