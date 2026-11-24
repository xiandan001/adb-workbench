const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createFirmwareTools, describeDriver, inspectFile, inspectVendorFiles } = require('../electron/lib/firmware-tools.cjs');
const { installWindowsDriver, launchWindowsTool } = require('../electron/lib/firmware-tools-windows.cjs');

const rkPackage = { inf: 'rockusb.inf', published: 'oem41.inf', provider: 'Fuzhou Rockchip', signer: 'Windows publisher' };
const mtkPackage = { inf: 'cdc-acm.inf', published: 'oem16.inf', provider: 'MediaTek Inc.', signer: 'Windows publisher' };
const rkDevice = { hardwareId: 'VID_2207&PID_350A', name: 'Rockusb Device', problemCode: 0, driverInf: 'OEM41.INF' };
const mtkDevice = { hardwareId: 'VID_0E8D&PID_2000', name: 'MediaTek PreLoader USB VCOM', problemCode: 0, driverInf: 'oem16.inf' };
const empty = { devices: [], packages: [] };

test('each firmware driver distinguishes installed inventory from binding, mixed devices, and generic ADB', () => {
  for (const [platform, driver, device] of [['rk', rkPackage, rkDevice], ['mtk', mtkPackage, mtkDevice]]) {
    assert.equal(describeDriver(platform, null).state, 'unknown');
    assert.equal(describeDriver(platform, empty).state, 'missing');
    assert.equal(describeDriver(platform, { ...empty, packages: [driver] }).state, 'installed');
    assert.equal(describeDriver(platform, { devices: [device], packages: [driver] }).state, 'bound');
    assert.equal(describeDriver(platform, { devices: [{ ...device, problemCode: 28 }], packages: [driver] }).state, 'problem');
    assert.equal(describeDriver(platform, { devices: [{ ...device, problemCode: null }], packages: [driver] }).state, 'problem');
    assert.equal(describeDriver(platform, { devices: [device, { ...device, driverInf: 'winusb.inf' }], packages: [driver] }).state, 'problem');
  }
  assert.equal(describeDriver('mtk', { ...empty, packages: [{ ...mtkPackage, inf: 'android_winusb.inf' }] }).state, 'missing');
  assert.equal(describeDriver('mtk', { devices: [{ ...mtkDevice, hardwareId: 'VID_0E8D&PID_201D' }], packages: [mtkPackage] }).devices.length, 0);
  assert.equal(describeDriver('rk', { ...empty, packages: [{ ...rkPackage, signer: null }] }).state, 'missing');
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-firmware-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'DriverInstall.exe');
  const bytes = Buffer.from('Fixture driver payload');
  await fs.writeFile(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { dir, file, sha256, bytes };
}

test('file identity rejects mutated packages and missing entries', async t => {
  const { dir, file, sha256 } = await fixture(t);
  assert.deepEqual(await inspectFile(dir, 'DriverInstall.exe', sha256, fs), { path: file, sha256 });
  assert.deepEqual(await inspectFile(dir, 'missing.exe', sha256, fs), { code: 'missing-file' });
  await fs.appendFile(file, 'corruption');
  assert.deepEqual(await inspectFile(dir, 'DriverInstall.exe', sha256, fs), { code: 'untrusted-package' });
});

test('vendor inspection checks executable, DLL and Qt plugin identity without touching presets', async t => {
  const { dir, file, sha256, bytes } = await fixture(t);
  const dll = path.join(dir, 'flash.dll');
  const folder = path.join(dir, 'plugins', 'platforms');
  const plugin = path.join(folder, 'qwindows.dll');
  const files = { 'DriverInstall.exe': sha256, 'flash.dll': sha256, 'plugins/platforms/qwindows.dll': sha256 };
  const check = () => inspectVendorFiles(dir, 'DriverInstall.exe', files, fs);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(dll, bytes);
  await fs.writeFile(plugin, bytes);
  await fs.writeFile(path.join(dir, 'history.ini'), 'Writable vendor preference');
  assert.deepEqual(await check(), { path: file });

  await fs.unlink(plugin);
  assert.deepEqual(await check(), { code: 'missing-file' });
  await fs.writeFile(plugin, bytes);
  await fs.appendFile(dll, 'tampered');
  assert.deepEqual(await check(), { code: 'untrusted-package' });
  await fs.writeFile(dll, bytes);
  await fs.writeFile(path.join(folder, 'unknown.dll'), bytes);
  assert.deepEqual(await check(), { code: 'untrusted-package' });
  await fs.unlink(path.join(folder, 'unknown.dll'));
  await fs.mkdir(path.join(dir, 'plugins', 'unexpected'));
  assert.deepEqual(await check(), { code: 'untrusted-package' });
});

test('startup and both platforms share a cached inventory until an explicit refresh', async () => {
  let queryCount = 0;
  let release;
  const mock = createFirmwareTools({
    platform: 'win32', arch: 'x64', inspect: async () => ({ installer: {}, tool: {} }),
    query: () => ++queryCount === 1 ? new Promise(resolve => { release = resolve; }) : { ...empty, packages: [mtkPackage] },
  });
  const warming = mock.warmup();
  const rk = mock.status('rk', 'first-tools-folder');
  const mtk = mock.status('mtk', 'second-tools-folder');
  const overlappingRefresh = mock.status('rk', 'first-tools-folder', { refresh: true });
  await Promise.resolve();
  assert.equal(queryCount, 1);
  release({ ...empty, packages: [rkPackage] });
  await warming;
  assert.equal((await rk).state, 'installed');
  assert.equal((await mtk).state, 'missing');
  assert.equal((await overlappingRefresh).state, 'installed');
  assert.equal((await mock.status('rk', 'changed-tools-folder')).state, 'installed');
  assert.equal(queryCount, 1);
  assert.equal((await mock.status('mtk', 'second-tools-folder', { refresh: true })).state, 'installed');
  assert.equal((await mock.status('rk', 'first-tools-folder')).state, 'missing');
  assert.equal(queryCount, 2);
});

test('a failed startup inventory is retained until manual retry, and unsupported hosts do not probe', async () => {
  let attempts = 0;
  const options = {
    arch: 'x64', inspect: async () => ({ installer: {}, tool: {} }),
    query: async () => { if (++attempts === 1) throw new Error('Unavailable'); return empty; },
  };
  const unsupported = createFirmwareTools({ ...options, platform: 'linux' });
  assert.equal(await unsupported.warmup(), null);
  assert.equal((await unsupported.status('rk')).errorCode, 'unsupported-platform');
  assert.equal(attempts, 0);
  const mock = createFirmwareTools({ ...options, platform: 'win32' });
  await mock.warmup();
  assert.equal((await mock.status('rk')).state, 'unknown');
  assert.equal((await mock.status('mtk')).state, 'unknown');
  assert.equal(attempts, 1);
  assert.equal((await mock.status('mtk', '', { refresh: true })).state, 'missing');
  assert.equal(attempts, 2);
});

test('only explicit MTK consent may elevate and completion is followed by a fresh status', async t => {
  const { dir, file, sha256, bytes } = await fixture(t);
  let queryCount = 0;
  let elevations = 0;
  let stagedPath;
  const mock = createFirmwareTools({
    platform: 'win32', arch: 'x64', tempDirectory: dir,
    inspect: async () => ({ installer: { available: true, needsConfirmation: true }, tool: { available: true },
      paths: { files: [{ path: file, sha256 }], tool: file } }),
    query: async () => (++queryCount, { ...empty, packages: elevations ? [mtkPackage] : [] }),
    elevate: async (platform, files) => {
      elevations++;
      stagedPath = files[0].path;
      assert.equal(platform, 'mtk');
      assert.notEqual(stagedPath, file);
      assert.equal(files[0].sha256, sha256);
      assert.deepEqual(await fs.readFile(stagedPath), bytes);
      return { ok: true, code: 'installer-exited', exitCode: 0 };
    },
  });
  assert.equal((await mock.status('mtk', dir)).state, 'missing');
  assert.deepEqual(await mock.install('mtk', dir), { ok: false, code: 'confirmation-required' });
  assert.equal(elevations, 0);
  const result = await mock.install('mtk', dir, { confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'installed');
  assert.equal(queryCount, 2);
  await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });
});

test('a post-installation probe supersedes an in-flight startup probe', async t => {
  const { dir, file, sha256 } = await fixture(t);
  let queryCount = 0;
  let release;
  const mock = createFirmwareTools({
    platform: 'win32', arch: 'x64', tempDirectory: dir,
    inspect: async () => ({ installer: { available: true }, tool: {}, paths: { files: [{ path: file, sha256 }] } }),
    query: () => ++queryCount === 1 ? new Promise(resolve => { release = resolve; }) : { ...empty, packages: [rkPackage] },
    elevate: async () => ({ ok: true, code: 'installer-exited' }),
  });
  const warming = mock.warmup();
  const result = await mock.install('rk', dir);
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'installed');
  assert.equal(queryCount, 2);
  release(empty);
  await warming;
  assert.equal((await mock.status('rk', dir)).state, 'installed');
  assert.equal(queryCount, 2);
});

test('driver cancellation, unreported install and failure do not claim success', async t => {
  const { dir, file, sha256 } = await fixture(t);
  let response = { ok: false, code: 'uac-cancelled' };
  const mock = createFirmwareTools({
    platform: 'win32', arch: 'x64', tempDirectory: dir, query: async () => empty,
    inspect: async () => ({ installer: { available: true, needsConfirmation: false }, tool: { available: false },
      paths: { files: [{ path: file, sha256 }] } }),
    elevate: async () => response,
  });
  const cancelled = await mock.install('rk', dir);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status.state, 'missing');
  response = { ok: false, code: 'install-failed', exitCode: 13 };
  assert.equal((await mock.install('rk', dir)).ok, false);
  response = { ok: true, code: 'installer-exited', exitCode: 0 };
  assert.equal((await mock.install('rk', dir)).code, 'install-not-detected');
});

test('vendor launch accepts only validated executable path, no firmware arguments', async t => {
  const { dir, file } = await fixture(t);
  const calls = [];
  let available = true;
  const mock = createFirmwareTools({
    platform: 'win32', arch: 'x64',
    inspect: async () => ({ tool: { available, code: 'untrusted-package' }, paths: { tool: file } }),
    launch: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(await mock.open('rk', dir), { ok: true });
  available = false;
  assert.deepEqual(await mock.open('mtk', dir), { ok: false, code: 'untrusted-package' });
  assert.deepEqual(await mock.open('unknown', dir), { ok: false, code: 'unsupported-platform' });
  assert.deepEqual(calls, [[file]]);
});

test('vendor launch only uses the graphical Windows fallback before process start and never passes firmware arguments', async () => {
  const executable = path.resolve('local tools', 'SPFlashToolV6.exe');
  const cases = [
    { spawnError: 'EINVAL', shell: { ok: true } },
    { spawnError: 'UNKNOWN', shell: { ok: false, code: 'tool-access-denied' }, failure: 'tool-access-denied' },
    { spawnError: 'ENOENT', failure: 'tool-unavailable' },
    { spawnError: 'EACCES', failure: 'tool-access-denied' },
    { exitCode: 13, failure: 'tool-exited-early' },
    { exitCode: 0 },
    {},
  ];
  for (const sample of cases) {
    let fallbackCalls = 0;
    let unrefCalls = 0;
    const spawnProcess = (file, args, options) => {
      assert.equal(file, executable);
      assert.deepEqual(args, []);
      assert.equal(options.cwd, path.dirname(executable));
      assert.equal(options.windowsHide, false);
      const child = new EventEmitter();
      child.unref = () => { unrefCalls++; };
      queueMicrotask(() => {
        if (sample.spawnError) child.emit('error', Object.assign(Error('private launch details'), { code: sample.spawnError }));
        else {
          child.emit('spawn');
          if (Number.isInteger(sample.exitCode)) child.emit('exit', sample.exitCode, null);
        }
      });
      return child;
    };
    const runPowerShell = async script => {
      fallbackCalls++;
      const encoded = /\$data = '([^']+)'/.exec(script)?.[1];
      assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), executable);
      assert.match(script, /-WorkingDirectory \$workingDirectory -Verb Open/);
      assert.doesNotMatch(script, /RunAs|ArgumentList|WaitForExit\(\)/);
      return sample.shell;
    };
    const result = launchWindowsTool(executable, { spawnProcess, runPowerShell, startupMs: 5 });
    if (sample.failure) await assert.rejects(result, { code: sample.failure });
    else await result;
    assert.equal(fallbackCalls, sample.shell ? 1 : 0);
    assert.equal(unrefCalls, !sample.spawnError && !Number.isInteger(sample.exitCode) ? 1 : 0);
  }
});

test('the Windows helper rejects an altered installer before requesting elevated execution', { skip: process.platform !== 'win32' }, async t => {
  const { file, sha256 } = await fixture(t);
  await fs.appendFile(file, 'different from the trusted bytes');
  assert.deepEqual(await installWindowsDriver('mtk', [{ path: file, sha256 }]), { ok: false, code: 'untrusted-package' });
});
