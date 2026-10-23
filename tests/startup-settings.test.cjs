const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupSettingsService, LOGIN_ITEM_NAME } = require('../electron/lib/startup-settings-service.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-startup-pref-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = []; let native = { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] };
  let readError = false; let writeError = false;
  const exe = 'C:\\Program Files\\fixture-app\\fixture-app.exe';
  const app = { isPackaged: true, getPath: name => name === 'exe' ? exe : directory,
    getLoginItemSettings: args => { calls.push(['get', args]); if (readError) throw Error('private OS read failure'); return structuredClone(native); },
    setLoginItemSettings: args => {
      calls.push(['set', structuredClone(args)]);
      if (writeError) throw Error('private OS write failure');
      native = { openAtLogin: args.openAtLogin, executableWillLaunchAtLogin: args.openAtLogin && args.enabled !== false,
        launchItems: args.openAtLogin ? [{ name: LOGIN_ITEM_NAME, path: exe, args: [], scope: 'user', enabled: args.enabled !== false }] : [] };
    },
  };
  const config = { directory, app, platform: 'win32', environment: {}, defaultApp: false, ...options };
  const service = createStartupSettingsService(config); t.after(() => service.dispose());
  return { directory, file: path.join(directory, 'startup-preferences.json'), service, app, config, calls, exe,
    native: value => { native = structuredClone(value); }, readError: value => { readError = value; }, writeError: value => { writeError = value; } };
}

test('construction is inert and concurrent first initialization enables exactly the fixed current executable once', async t => {
  const h = fixture(t); assert.deepEqual(h.calls, []); assert.equal(fs.existsSync(h.file), false);
  const [first, second] = await Promise.all([h.service.initialize(), h.service.get()]);
  assert.equal(first.enabled, true); assert.equal(second.mode, 'packaged'); assert.equal(second.initialized, true);
  const writes = h.calls.filter(([type]) => type === 'set'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1], { openAtLogin: true, enabled: true, path: h.exe, args: [], name: LOGIN_ITEM_NAME });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file)), { version: 1, enabled: true, initialized: true });
  const next = createStartupSettingsService(h.config); t.after(() => next.dispose()); await next.initialize();
  assert.equal(h.calls.filter(([type]) => type === 'set').length, 1);
});

test('external system disable is reported and never silently re-enabled by later starts', async t => {
  const h = fixture(t); await h.service.initialize();
  h.native({ openAtLogin: true, executableWillLaunchAtLogin: false, launchItems: [{ name: LOGIN_ITEM_NAME, path: h.exe, args: [], scope: 'user', enabled: false }] });
  const next = createStartupSettingsService(h.config); t.after(() => next.dispose());
  const result = await next.initialize(); assert.equal(result.enabled, false); assert.equal(result.preferredEnabled, true);
  assert.match(result.message, /系统/); assert.equal(h.calls.filter(([type]) => type === 'set').length, 1);
  const changed = await next.set({ enabled: true }); assert.equal(changed.enabled, true);
});

test('an existing disabled login item is preserved even before the new local initialization marker exists', async t => {
  const h = fixture(t);
  h.native({ openAtLogin: true, executableWillLaunchAtLogin: false, launchItems: [{ name: LOGIN_ITEM_NAME, path: h.exe, args: [], scope: 'user', enabled: false }] });
  assert.equal((await h.service.initialize()).enabled, false);
  assert.equal(h.calls.filter(([type]) => type === 'set').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).initialized, true);
});

test('development, QA, default Electron app and unsupported platforms never read or write OS login items', async t => {
  for (const options of [{ environment: { NODE_ENV: 'development' } }, { environment: { NODE_ENV: 'test' } },
    { environment: { AWB_DISABLE_OS_STARTUP: '1' } }, { environment: { AWB_QA: '1' } }, { defaultApp: true }, { platform: 'linux' }]) {
    const h = fixture(t, options);
    const initial = await h.service.initialize(); assert.equal(initial.enabled, true); assert.equal(initial.registered, null);
    const saved = await h.service.set({ enabled: false }); assert.equal(saved.enabled, false); assert.match(saved.message, /仅保存|不支持/);
    assert.equal((await h.service.get()).preferredEnabled, false); assert.deepEqual(h.calls, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file)), { version: 1, enabled: false, initialized: false });
  }
  const h = fixture(t); h.app.isPackaged = false;
  await h.service.initialize(); await h.service.set({ enabled: false }); assert.deepEqual(h.calls, []);
});

test('a saved development choice is applied on its first packaged run instead of forcing the default on', async t => {
  const h = fixture(t, { environment: { NODE_ENV: 'development' } }); await h.service.set({ enabled: false });
  const packaged = createStartupSettingsService({ ...h.config, environment: {} }); t.after(() => packaged.dispose());
  const result = await packaged.initialize(); assert.equal(result.enabled, false); assert.equal(result.initialized, true);
  assert.equal(h.calls.some(([kind, args]) => kind === 'set' && args.openAtLogin), false);
});

test('invalid values cannot inject executable, arguments, registry names or overwrite a valid preference', async t => {
  const h = fixture(t); await h.service.initialize(); const before = fs.readFileSync(h.file); const count = h.calls.length;
  for (const input of [true, null, {}, { enabled: 'true' }, { enabled: true, path: 'C:\\untrusted.exe' }, { enabled: false, args: ['--unsafe'] }, { enabled: true, name: 'other-app' }]) {
    await assert.rejects(h.service.set(input), { code: 'STARTUP_SETTINGS_ARGUMENT' });
  }
  assert.equal(h.calls.length, count); assert.ok(fs.readFileSync(h.file).equals(before));
});

test('corrupt preference files fail closed without touching OS state or replacing user data', async t => {
  for (const content of ['broken', '{"version":2,"enabled":true,"initialized":true}', '{"version":1,"enabled":true,"initialized":true,"args":["unsafe"]}']) {
    const h = fixture(t); fs.writeFileSync(h.file, content);
    await assert.rejects(h.service.initialize(), { code: 'STARTUP_SETTINGS_READ' });
    assert.equal(fs.readFileSync(h.file, 'utf8'), content); assert.deepEqual(h.calls, []);
  }
});

test('preference write failure occurs before native mutation and preserves the original state', async t => {
  const h = fixture(t); await h.service.initialize(); const before = fs.readFileSync(h.file); const setCount = h.calls.filter(([kind]) => kind === 'set').length;
  const io = Object.create(fs); io.renameSync = () => { throw Error('fixture disk failure'); };
  const service = createStartupSettingsService({ ...h.config, filesystem: io }); t.after(() => service.dispose());
  await assert.rejects(service.set({ enabled: false }), { code: 'STARTUP_SETTINGS_SAVE' });
  assert.ok(fs.readFileSync(h.file).equals(before)); assert.equal(h.calls.filter(([kind]) => kind === 'set').length, setCount);
});

test('native update failure is sanitized, restores the saved preference and cannot report successful enablement', async t => {
  const h = fixture(t); await h.service.initialize(); const before = fs.readFileSync(h.file);
  h.writeError(true);
  await assert.rejects(h.service.set({ enabled: false }), error => /^STARTUP_/.test(error.code) && !error.message.includes('private'));
  assert.ok(fs.readFileSync(h.file).equals(before));
  h.writeError(false); assert.equal((await h.service.get()).enabled, true);
  h.readError(true); await assert.rejects(h.service.get(), { code: 'STARTUP_NATIVE_READ' });
});

test('a failed first registration retains a one-time marker and is not retried silently on the next launch', async t => {
  const h = fixture(t); h.writeError(true);
  await assert.rejects(h.service.initialize(), error => /^STARTUP_/.test(error.code));
  assert.equal(JSON.parse(fs.readFileSync(h.file)).initialized, true);
  h.writeError(false); const before = h.calls.filter(([kind]) => kind === 'set').length;
  const restarted = createStartupSettingsService(h.config); t.after(() => restarted.dispose());
  assert.equal((await restarted.initialize()).enabled, false);
  assert.equal(h.calls.filter(([kind]) => kind === 'set').length, before);
});

test('local startup intent is excluded from portable files and browser preference migration', () => {
  const policy = require('../electron/lib/data-migration-policy.cjs');
  assert.equal(policy.isAllowedFile('startup-preferences.json'), false);
  assert.equal(policy.PORTABLE_PREF_KEYS.some(key => /login|autostart|startup-settings/.test(key)), false);
});

test('packaged executables inside the private QA output directory are excluded from OS changes', async t => {
  const h = fixture(t); h.app.getPath = name => name === 'exe' ? 'C:\\fixture\\.superpowers\\win-unpacked\\app.exe' : h.directory;
  assert.equal((await h.service.get()).mode, 'development'); await h.service.set({ enabled: false }); assert.deepEqual(h.calls, []);
});

test('macOS uses only its main application login setting and reports missing/approval states without a false enabled result', async t => {
  const h = fixture(t, { platform: 'darwin' }); let mac = { openAtLogin: false, status: 'not-registered' };
  h.app.getLoginItemSettings = args => { h.calls.push(['get', args]); return { ...mac }; };
  h.app.setLoginItemSettings = args => { h.calls.push(['set', args]); mac = { openAtLogin: args.openAtLogin, status: args.openAtLogin ? 'enabled' : 'not-registered' }; };
  assert.equal((await h.service.initialize()).enabled, true);
  assert.deepEqual(h.calls.find(([kind]) => kind === 'set')[1], { openAtLogin: true });
  mac = { openAtLogin: true, status: 'not-found' };
  assert.equal((await h.service.get()).enabled, false);
  h.app.setLoginItemSettings = args => { h.calls.push(['set', args]); mac = { openAtLogin: false, status: 'requires-approval' }; };
  await assert.rejects(h.service.set({ enabled: true }), { code: 'STARTUP_APPROVAL_REQUIRED' });
  const read = await h.service.get(); assert.equal(read.enabled, false); assert.match(read.message, /批准/);
  assert.equal(read.preferredEnabled, true); assert.equal(read.initialized, true);
});

test('a native error after partial application compensates the owned startup item and exact saved bytes', async t => {
  const h = fixture(t); await h.service.initialize(); const original = fs.readFileSync(h.file); const apply = h.app.setLoginItemSettings;
  h.app.setLoginItemSettings = args => { apply(args); if (!args.openAtLogin) throw Error('private partial failure'); };
  await assert.rejects(h.service.set({ enabled: false }), { code: 'STARTUP_NATIVE_UPDATE' });
  assert.equal((await h.service.get()).enabled, true); assert.ok(fs.readFileSync(h.file).equals(original));
});

test('compensation never overwrites an external local preference change made during OS update', async t => {
  const h = fixture(t); await h.service.initialize(); const apply = h.app.setLoginItemSettings;
  const external = '{"version":1,"enabled":false,"initialized":false}\n';
  h.app.setLoginItemSettings = args => { apply(args); if (!args.openAtLogin) fs.writeFileSync(h.file, external); };
  await assert.rejects(h.service.set({ enabled: false }), { code: 'STARTUP_COMPENSATION_FAILED' });
  assert.equal(fs.readFileSync(h.file, 'utf8'), external); assert.equal(h.service.snapshot(), undefined);
});

test('same-name foreign startup entries are neither deleted nor replaced on explicit changes', async t => {
  for (const enabled of [true, false]) {
    for (const collision of ['arguments', 'path']) {
      const h = fixture(t);
      const entries = [{ name: LOGIN_ITEM_NAME, path: collision === 'path' ? 'C:\\another-app.exe' : h.exe,
        args: collision === 'arguments' ? ['--foreign-mode'] : [], scope: 'user', enabled: !enabled }];
      const original = structuredClone(entries);
      h.app.getLoginItemSettings = () => ({ openAtLogin: false,
        executableWillLaunchAtLogin: entries.some(row => row.path === h.exe && row.enabled), launchItems: structuredClone(entries) });
      h.app.setLoginItemSettings = args => {
        h.calls.push(['set', args]);
        const index = entries.findIndex(row => row.name === args.name && row.scope === 'user');
        if (index !== -1) entries.splice(index, 1);
        if (args.openAtLogin) entries.push({ name: args.name, path: args.path, args: args.args, scope: 'user', enabled: args.enabled });
      };
      const saved = '{"version":1,"enabled":false,"initialized":true}\n'; fs.writeFileSync(h.file, saved);
      await assert.rejects(h.service.set({ enabled }), { code: 'STARTUP_NATIVE_CONFLICT' });
      assert.deepEqual(entries, original); assert.equal(h.calls.length, 0); assert.equal(fs.readFileSync(h.file, 'utf8'), saved);
    }
  }
});

test('an effective startup entry under another name cannot be disabled by deleting our absent entry', async t => {
  const h = fixture(t); const entry = { name: 'another-registration', path: h.exe, args: [], scope: 'user', enabled: true };
  h.native({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [entry] });
  await h.service.initialize(); const saved = fs.readFileSync(h.file);
  await assert.rejects(h.service.set({ enabled: false }), { code: 'STARTUP_NATIVE_CONFLICT' });
  assert.equal(h.calls.filter(([kind]) => kind === 'set').length, 0); assert.ok(fs.readFileSync(h.file).equals(saved));
});

test('explicit macOS disable unregisters pending approval even when effective enablement is already false', async t => {
  for (const openAtLogin of [true, false]) {
    const h = fixture(t, { platform: 'darwin' }); let mac = { openAtLogin, status: 'requires-approval' };
    h.app.getLoginItemSettings = () => ({ ...mac });
    h.app.setLoginItemSettings = args => { h.calls.push(['set', args]); mac = { openAtLogin: args.openAtLogin, status: 'not-registered' }; };
    await h.service.initialize(); const result = await h.service.set({ enabled: false });
    assert.equal(result.enabled, false); assert.equal(result.registered, false);
    assert.deepEqual(h.calls, [['set', { openAtLogin: false }]]);
  }
});

test('compensation does not overwrite a foreign same-name entry that appeared during the native update', async t => {
  const h = fixture(t); await h.service.initialize(); const saved = fs.readFileSync(h.file); const before = h.calls.length;
  const foreign = { name: LOGIN_ITEM_NAME, path: h.exe, args: ['--external'], scope: 'user', enabled: true };
  h.app.setLoginItemSettings = args => {
    h.calls.push(['set', args]); h.native({ openAtLogin: false, executableWillLaunchAtLogin: true, launchItems: [foreign] });
    throw Error('fixture externally replaced entry');
  };
  await assert.rejects(h.service.set({ enabled: false }), { code: 'STARTUP_COMPENSATION_FAILED' });
  assert.equal(h.calls.slice(before).filter(([kind]) => kind === 'set').length, 1);
  assert.ok(fs.readFileSync(h.file).equals(saved)); assert.equal(h.service.snapshot(), undefined);
});
