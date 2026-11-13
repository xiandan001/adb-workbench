const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { probeActiveInstaller, runUnlessInstalling, readGuardLocale, launchInstallerWaitHost } = require('../electron/lib/installer-startup-guard.cjs');

test('normal startup and other platforms take the no-process fast path', () => {
  const run = () => assert.fail('no helper may run without a marker');
  assert.deepEqual(probeActiveInstaller({ platform: 'linux', run, io: {} }), { ok: true, active: false });
  assert.deepEqual(probeActiveInstaller({ platform: 'win32', environment: {}, io: { existsSync: () => false }, run }), { ok: true, active: false });
});

test('only the fixed named-mutex probe is executed with bounded hidden data-only invocation', () => {
  const calls = [];
  const result = probeActiveInstaller({ platform: 'win32', environment: { ProgramData: 'C:\\ProgramData', SystemRoot: 'C:\\Windows' },
    io: { existsSync: value => !value.includes('Sysnative') }, run: (...args) => { calls.push(args); return '{"ok":true,"active":true}'; } });
  assert.deepEqual(result, { ok: true, active: true }); assert.equal(calls.length, 1);
  const [exe, args, options] = calls[0];
  assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(!args.includes('-Command')); assert.match(args.at(-1), /installer-active\.ps1$/);
  assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
});

test('stale marker does not block startup, and malformed/inaccessible probes cannot permit ordinary initialization', () => {
  const common = { platform: 'win32', environment: {}, io: { existsSync: () => true } };
  assert.deepEqual(probeActiveInstaller({ ...common, run: () => '{"ok":true,"active":false}' }), { ok: true, active: false });
  for (const output of ['', '{}', '{"ok":true,"active":0}', '{"ok":false,"active":false}', 'not json']) {
    assert.deepEqual(probeActiveInstaller({ ...common, run: () => output }), { ok: false, active: true });
  }
  assert.deepEqual(probeActiveInstaller({ ...common, run: () => { throw Error('private install path'); } }), { ok: false, active: true });
});

test('active and unknown states transfer to an independent prompt then exit; inactive resumes the original callback once', async () => {
  for (const state of [{ ok: true, active: true }, { ok: false, active: true }]) {
    let shown = 0, quits = 0;
    assert.equal(runUnlessInstalling({ app: { quit: () => { quits++; } } }, () => assert.fail('normal app must remain unloaded'), {
      probe: () => state, showWait: (_context, actual) => { shown++; assert.deepEqual(actual, state); },
    }), true);
    assert.equal(shown, 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(quits, 1);
  }
  let starts = 0;
  assert.equal(runUnlessInstalling({}, () => { starts++; }, { probe: () => ({ ok: true, active: false }), showWait: () => assert.fail('no popup') }), false);
  assert.equal(starts, 1);
});

test('independent prompt is copied outside the installation tree with no shell, profile or Electron window', async () => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'veylo-wait-host-test-'));
  try {
    const resources = path.join(root, 'installation/resources'), temporary = path.join(root, 'temporary'), appData = path.join(root, 'profile');
    fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(temporary); fs.mkdirSync(path.join(appData, 'adb-workbench'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'adb-workbench/settings.json'), JSON.stringify({ locale: 'ja-JP' }));
    const bytes = Buffer.from('MZ-owned-test-only-not-an-executable');
    fs.writeFileSync(path.join(resources, 'installer-wait.exe'), bytes);
    const target = path.join(root, 'installation/卓控台.exe'); fs.writeFileSync(target, bytes);
    let actual; let detached = 0;
    const result = await launchInstallerWaitHost({ app: { getPath: name => { assert.equal(name, 'appData'); return appData; }, setPath: () => assert.fail('must not initialize Chromium') } },
      { ok: true, active: true }, { resourcesPath: resources, temporaryDirectory: temporary, executablePath: target,
        startProcess: (executable, args, options) => {
          actual = { executable, args, options }; const child = new EventEmitter(); child.unref = () => { detached++; };
          queueMicrotask(() => child.emit('spawn')); return child;
        } });
    assert.equal(result.started, true); assert.equal(detached, 1);
    assert.ok(actual.executable.startsWith(temporary + path.sep)); assert.ok(!actual.executable.startsWith(resources));
    assert.deepEqual(fs.readFileSync(actual.executable), bytes);
    assert.equal(actual.args[0], '--locale=ja-JP'); assert.equal(Buffer.from(actual.args[1].slice('--target='.length), 'base64').toString('utf8'), target);
    assert.deepEqual(actual.options, { detached: true, stdio: 'ignore', windowsHide: false });
    assert.throws(() => launchInstallerWaitHost({ app: {} }, {}, { resourcesPath: resources,
      temporaryDirectory: path.join(root, 'installation'), executablePath: target, startProcess: () => assert.fail('must not spawn from install tree') }), /INSTALL_WAIT_TEMP_INVALID/);
  } finally {
    const relative = path.relative(parent, fs.realpathSync.native(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(root, { recursive: true });
  }
});

test('guard locale is bounded, read-only and accepts only the five supported saved locales', () => {
  const app = { getPath: () => 'C:\\UserAppData' };
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'invalid']) {
    const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readFileSync: () => JSON.stringify({ locale }) };
    assert.equal(readGuardLocale(app, io), locale === 'invalid' ? 'en-US' : locale);
  }
  assert.equal(readGuardLocale(app, { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1024 * 1024 + 1 }) }), 'en-US');
});

test('host-copy and asynchronous spawn failures stay inside the controlled blocked-start path', async () => {
  for (const showWait of [() => { throw Error('EACCES private temporary path'); }, () => Promise.reject(Error('window unavailable'))]) {
    let quits = 0;
    assert.equal(runUnlessInstalling({ app: { quit: () => { quits++; } } }, () => assert.fail('normal initialization must stay blocked'), {
      probe: () => ({ ok: true, active: true }), showWait,
    }), true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(quits, 1);
  }
});

test('real main entry gates before profile migration and all device, updater, model and normal-window imports', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const requests = [];
  vm.runInNewContext(source, { require(name) {
    requests.push(name);
    if (name === 'electron') return { app: {}, BrowserWindow: class {} };
    if (name === 'path' || name === 'fs') return require(name);
    if (name === './lib/installer-startup-guard.cjs') return { runUnlessInstalling: (_context, callback) => assert.equal(typeof callback, 'function') };
    assert.fail('normal service loaded during installation: ' + name);
  } });
  assert.deepEqual(requests, ['electron', 'path', 'fs', './lib/installer-startup-guard.cjs']);
});

test('probe resource only opens/disposes the fixed mutex and never acquires ownership or stops a process', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/assets/installer-active.ps1'), 'utf8');
  assert.match(source, /Mutex\]::OpenExisting\('Global\\Veylo\.adb-workbench\.Install\.v1'/);
  assert.match(source, /MutexRights\]::Synchronize/); assert.match(source, /\.Dispose\(\)/);
  assert.doesNotMatch(source, /WaitOne|WaitForSingleObject|Stop-Process|Start-Process|kill-server/);
  assert.ok(!source.includes('\r')); assert.ok([...source].every(character => character.charCodeAt(0) < 128));
});
