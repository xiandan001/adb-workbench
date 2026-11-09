const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseBundleList, parseBundleDetail, selectLaunchAbility } = require('../electron/lib/harmony-bundles.cjs');
const { createHarmonyApps, applicationResult } = require('../electron/lib/harmony-apps.cjs');

const bundle = (abilities = [{ name: 'ActualPage', type: 1, exported: true }]) => ({
  name: 'com.fixture.app', versionName: '2.1', versionCode: 21, uid: 10001,
  applicationInfo: { bundleName: 'com.fixture.app', isSystemApp: false, enabled: true },
  reqPermissions: ['ohos.permission.INTERNET'],
  hapModuleInfos: [{ name: 'feature', mainElementName: 'ActualPage', abilityInfos: abilities }]
});
const output = value => 'com.fixture.app:\n' + JSON.stringify(value, null, 2) + '\n';

test('native bm JSON lists preserve real metadata and unknown values, not Android fake fields', () => {
  const packages = parseBundleList('All bundles:\n["com.fixture.two","com.fixture.one","com.fixture.two"]\n');
  assert.deepEqual(packages.map(item => item.packageName), ['com.fixture.one', 'com.fixture.two']);
  assert.equal(packages[0].platform, 'harmony');
  assert.equal(packages[0].system, null);
  assert.equal(packages[0].enabled, null);
  assert.equal(packages[0].path, '');
  assert.deepEqual(parseBundleList('All bundles:\n[]'), []);
  assert.throws(() => parseBundleList('error: bundle service unavailable'));
  assert.throws(() => parseBundleList('["com.valid.app", "x;rm -rf /"]'));
});

test('bundle detail resolves actual module/Ability and does not assume EntryAbility or permission grants', () => {
  const info = parseBundleDetail(output(bundle()), 'com.fixture.app');
  assert.deepEqual(selectLaunchAbility(info), { abilityName: 'ActualPage', moduleName: 'feature' });
  assert.equal(info.permissions[0].granted, null);
  assert.equal(info.versionCode, '21');
  assert.throws(() => parseBundleDetail(output(bundle()), 'com.other.app'), /不一致/);
  const hidden = parseBundleDetail(output(bundle([{ name: 'ActualPage', type: 1, exported: false }])), 'com.fixture.app');
  assert.throws(() => selectLaunchAbility(hidden), /不能猜测/);
  const service = parseBundleDetail(output(bundle([{ name: 'ActualPage', type: 2, exported: true }])), 'com.fixture.app');
  assert.throws(() => selectLaunchAbility(service), /不能猜测/);
});

test('ambiguous Ability entries require an explicit real selection; fabricated names cannot launch', () => {
  const value = bundle([{ name: 'PageA', type: 'page', exported: true }, { name: 'PageB', type: 1, exported: true }]);
  const detail = parseBundleDetail(output(value), 'com.fixture.app');
  assert.throws(() => selectLaunchAbility(detail), /多个/);
  assert.deepEqual(selectLaunchAbility(detail, { abilityName: 'PageB', moduleName: 'feature' }), { abilityName: 'PageB', moduleName: 'feature' });
  assert.throws(() => selectLaunchAbility(detail, { abilityName: 'EntryAbility' }), /不能猜测/);
});

test('duplicate Ability metadata cannot undo an explicit non-exported state', () => {
  const value = bundle();
  value.abilityInfos = [{ name: 'ActualPage', moduleName: 'feature', type: 1, exported: false }];
  assert.throws(() => selectLaunchAbility(parseBundleDetail(output(value), 'com.fixture.app')), /不能猜测/);
});

test('native helpers preserve worker binding and launch only resolved Ability', async () => {
  const calls = [];
  const apps = createHarmonyApps({ resolve: id => ({ id, targetKey: id.slice(4), transport: 'hdc', status: 'device', generation: 0 }), runHdc: async (id, args, options) => {
    calls.push({ id, args, options });
    return { ok: true, stdout: args[1] === 'bm' ? output(bundle()) : 'start ability successfully.' };
  } });
  const binding = { command: 'C:\\fixture\\hdc.exe', deviceRef: { id: 'hdc:A', targetKey: 'A', transport: 'hdc', status: 'device' }, signal: new AbortController().signal };
  const result = await apps.launchPackage('hdc:A', 'com.fixture.app', binding);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1].args, ['shell', 'aa', 'start', '-b', 'com.fixture.app', '-a', 'ActualPage', '-m', 'feature']);
  for (const call of calls) {
    assert.equal(call.id, 'hdc:A');
    assert.equal(call.options.command, binding.command);
    assert.equal(call.options.deviceRef, binding.deviceRef);
    assert.equal(call.options.signal, binding.signal);
    assert.ok(!call.args.includes('monkey'));
  }
});

test('main-process launch never applies an old Ability to a replacement connection', async () => {
  let generation = 1;
  const calls = [];
  const apps = createHarmonyApps({
    resolve: id => ({ id, targetKey: id.slice(4), transport: 'hdc', status: 'device', generation }),
    runHdc: async (_id, args, options) => {
      options.assertCurrent?.(); calls.push(args);
      generation++;
      return { ok: true, stdout: output(bundle()) };
    }
  });
  const result = await apps.launchPackage('hdc:A', 'com.fixture.app');
  assert.equal(result.ok, false); assert.equal(result.code, 'DEVICE_CHANGED'); assert.match(result.error, /设备连接/);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'bm');
});

test('unsupported enable and failed clean are not reported as successful mutations', async () => {
  const calls = [];
  const apps = createHarmonyApps({ resolve: id => ({ id, targetKey: id.slice(4), transport: 'hdc', status: 'device', generation: 0 }), runHdc: async (id, args) => {
    calls.push(args);
    if (args[2] === 'help') return { ok: true, stdout: args[1] === 'bm' ? 'install install bundle\nuninstall uninstall bundle\nclean clean data\n' : 'start start ability\nforce-stop stop process\n' };
    return { ok: true, stdout: 'error: permission denied', code: 0 };
  } });
  assert.equal((await apps.runPackageAction('hdc:A', 'com.fixture.app', 'enable')).code, 'DEVICE_UNSUPPORTED');
  assert.ok(!calls.some(args => args.includes('enable')));
  const clean = await apps.runPackageAction('hdc:A', 'com.fixture.app', 'clearData');
  assert.equal(clean.ok, false);
  assert.match(clean.error, /permission denied/);
  assert.deepEqual(calls.at(-1), ['shell', 'bm', 'clean', '-d', '-n', 'com.fixture.app']);
  assert.equal(applicationResult({ ok: true, stdout: '[Fail]install denied' }).ok, false);
});

test('Harmony installation accepts only existing HAP/HSP, preserves spaces, and does not grant/downgrade', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-harmony-apps-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const localPath = path.join(directory, 'fixture package.hap');
  fs.writeFileSync(localPath, 'signed-package-fixture');
  const calls = [];
  const apps = createHarmonyApps({ resolve: id => ({ id, targetKey: id.slice(4), transport: 'hdc', status: 'device', generation: 0 }), runHdc: async (id, args) => { calls.push({ id, args }); return { ok: true, stdout: 'install bundle successfully.' }; } });
  assert.equal((await apps.installPackage('hdc:A', localPath)).ok, true);
  assert.deepEqual(calls[0], { id: 'hdc:A', args: ['install', '-r', localPath] });
  assert.equal((await apps.installPackage('hdc:A', localPath.replace('.hap', '.apk'))).ok, false);
  assert.equal((await apps.installPackage('hdc:A', 'relative.hap')).ok, false);
  assert.equal((await apps.installPackage('hdc:A', directory + '.hsp')).ok, false);
  assert.equal(calls.length, 1);
});

test('package IPC dispatch is native and renderer arguments cannot replace trusted transport options', async () => {
  const calls = [];
  const helper = Object.fromEntries(['listPackages', 'getPackageDetail', 'getCapabilities', 'launchPackage', 'runPackageAction', 'installPackage'].map(name => [name, async (...args) => {
    calls.push([name, args]);
    return name === 'listPackages' ? [] : name === 'getCapabilities' ? { export: { supported: false } } : { ok: true };
  }]));
  const filename = path.join(__dirname, '../electron/lib/package-manager.cjs');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console,
    require: name => {
      if (name === 'electron') return { app: { getPath: () => os.tmpdir() } };
      if (name === './vip.cjs') return { getStatusAsync: async () => ({ activated: true }) };
      if (name === './harmony-apps.cjs') return helper;
      if (name === './adb-runtime.cjs') return { runAdb: async args => { calls.push(['adb', args]); return { ok: true, stdout: '' }; } };
      if (name.startsWith('./')) return require(path.join(path.dirname(filename), name));
      return require(name);
    }
  }, { filename });
  const handlers = new Map();
  module.exports.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  assert.equal((await handlers.get('package:list')({}, { deviceId: 'hdc:A' })).ok, true);
  const launch = await handlers.get('package:launch')({}, { deviceId: 'hdc:A', packageName: 'com.fixture.app', abilityName: 'ActualPage', moduleName: 'feature', command: 'evil.exe', deviceRef: { id: 'hdc:B' } });
  assert.equal(launch.ok, true);
  const options = calls.find(([name]) => name === 'launchPackage')[1][2];
  assert.equal(options.command, undefined);
  assert.equal(options.deviceRef, undefined);
  assert.equal(options.abilityName, 'ActualPage');
  assert.equal((await handlers.get('package:exportApk')({}, { deviceId: 'hdc:A', packageName: 'com.fixture.app', localPath: 'C:\\out.apk' })).code, 'DEVICE_UNSUPPORTED');
  await handlers.get('package:forceStop')({}, { deviceId: 'hdc:A', packageName: 'com.fixture.app', command: 'evil.exe' });
  const actionOptions = calls.find(([name]) => name === 'runPackageAction')[1][3];
  assert.equal(actionOptions.command, undefined);
  assert.equal(actionOptions.deviceRef, undefined);
  assert.ok(!calls.some(([name]) => name === 'adb'));
  await handlers.get('package:launch')({}, { deviceId: 'android-A', packageName: 'com.fixture.app' });
  assert.ok(calls.some(([name, args]) => name === 'adb' && args.includes('monkey')));
});
