const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { register } = require('../electron/lib/firmware-workspace.cjs');

async function setup(t, hostPlatform = 'win32', extra = {}) {
  const desktop = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-workspace-'));
  const userData = path.join(desktop, 'preferences');
  const resources = path.join(desktop, 'resources');
  const auto = path.join(desktop, 'work', 'utils', '烧录');
  const rk = path.join(desktop, 'only-rk');
  const mtk = path.join(desktop, 'only-mtk');
  await Promise.all([auto, rk, mtk].map(dir => fs.mkdir(dir, { recursive: true })));
  t.after(() => fs.rm(desktop, { recursive: true, force: true }));
  const handlers = new Map();
  const frame = {};
  const sender = { mainFrame: frame };
  const owner = { isDestroyed: () => false, webContents: sender };
  const calls = [];
  let nextDialog = { canceled: true };
  let main = owner;
  const options = {
    hostPlatform,
    resourcesPath: resources,
    direct: extra.direct,
    installRkDirectTool: extra.installRkDirectTool,
    getMainWindow: () => main,
    inspectSignedDriver: async (platform, directory) => directory === (platform === 'rk' ? rk : mtk) ? [{}] : [],
    electron: {
      app: { isPackaged: extra.packaged === true, getPath: key => key === 'userData' ? userData : desktop },
      dialog: { showOpenDialog: async (target, settings) => {
        assert.equal(target, owner);
        calls.push(['dialog', settings]);
        return typeof nextDialog === 'function' ? nextDialog() : nextDialog;
      } },
    },
    tools: {
      warmup: async () => { calls.push(['warmup']); },
      status: async (platform, dir, options) => {
        calls.push(['status', platform, dir, options]);
        const available = dir === auto || dir === (platform === 'rk' ? rk : mtk);
        return { state: 'missing', installer: { available: available || Boolean(options?.driverDirectory) }, tool: { available } };
      },
      install: async (platform, dir, options) => {
        calls.push(['install', platform, dir, options]);
        return { ok: true, status: { state: 'installed' } };
      },
      open: async (platform, dir) => { calls.push(['open', platform, dir]); return { ok: true }; }
    },
    preflight: async (platform, file) => {
      calls.push(['preflight', platform, file]);
      return extra.preflight ? extra.preflight(platform, file) : { ok: true, fileName: path.basename(file) };
    },
  };
  const binding = { handle: (key, callback) => handlers.set(key, callback) };
  const workspace = register(binding, options);
  const event = { sender, senderFrame: frame };
  return {
    auto, rk, mtk, event, calls, userData, resources,
    warmup: workspace.warmup,
    setDialog(value) { nextDialog = value; }, setOwner(value) { main = value; },
    reopen() { register(binding, options); },
    call: (name, platform, origin = event, ...args) => handlers.get(`firmware:${name}`)(origin, platform, ...args),
  };
}

test('both platforms start unconfigured even when the old desktop folder exists', async t => {
  const f = await setup(t);
  for (const platform of ['rk', 'mtk']) {
    const status = await f.call('status', platform);
    assert.equal(status.toolRoot, '');
    assert.equal(status.state, 'missing');
    assert.equal(status.installer.available, false);
    assert.equal(status.tool.available, false);
  }
  assert.deepEqual(await f.call('chooseTools', 'rk'), { ok: false, cancelled: true });
  f.reopen();
  assert.equal((await f.call('status', 'rk')).toolRoot, '');
});

const directToolReady = root => ({ ok: true, tool: { version: 'fixture', cwd: root } });
const directToolMissing = { ok: false, code: 'missing-fixture' };

test('reopening remembers each platform file but issues a new receipt only after rechecking it', async t => {
  const f = await setup(t, 'win32', { preflight: async (_platform, file) => ({
    ok: Boolean(await fs.stat(file).catch(() => null)), fileName: path.basename(file),
  }) });
  const selected = {};
  for (const [platform, fileName] of [['rk', 'update.img'], ['mtk', 'flash.xml']]) {
    assert.equal((await f.call('restoreFile', platform)).empty, true);
    const file = path.join(f[platform], fileName);
    await fs.writeFile(file, 'fixture');
    f.setDialog({ filePaths: [file] });
    selected[platform] = await f.call('chooseFile', platform);
    assert.ok(selected[platform].firmwareId);
  }
  f.reopen();
  for (const platform of ['rk', 'mtk']) {
    const prior = await f.call('restoreFile', platform);
    assert.equal(prior.filePath, selected[platform].filePath);
    assert.ok(prior.firmwareId && prior.firmwareId !== selected[platform].firmwareId);
  }
  assert.equal(f.calls.filter(([type]) => type === 'dialog').length, 2);
  await fs.unlink(selected.rk.filePath);
  f.reopen();
  const missing = await f.call('restoreFile', 'rk');
  assert.equal(missing.ok, false);
  assert.equal(missing.firmwareId, undefined);
  assert.equal((await f.call('restoreFile', 'mtk')).ok, true);
});

test('an explicit new choice wins over slow restore and an invalid choice is never remembered', async t => {
  let hold, pending;
  const f = await setup(t, 'win32', { async preflight(_platform, file) {
    if (hold && file.endsWith('first.img')) { pending(); await hold; }
    return { ok: !file.endsWith('invalid.img'), fileName: path.basename(file) };
  } });
  for (const name of ['first.img', 'invalid.img']) {
    f.setDialog({ filePaths: [path.join(f.rk, name)] });
    assert.equal(Boolean((await f.call('chooseFile', 'rk')).firmwareId), name === 'first.img');
  }
  f.reopen();
  let unblock;
  hold = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { pending = resolve; });
  const restoring = f.call('restoreFile', 'rk');
  await started;
  f.setDialog({ filePaths: [path.join(f.rk, 'new.img')] });
  assert.equal((await f.call('chooseFile', 'rk')).fileName, 'new.img');
  unblock();
  assert.equal((await restoring).cancelled, true);
  f.reopen();
  assert.equal((await f.call('restoreFile', 'rk')).fileName, 'new.img');
});

test('direct tool status reuses verified bundled and previously saved locations without a chooser', async t => {
  const checks = [];
  const verified = new Set();
  const f = await setup(t, 'win32', { packaged: true,
    direct: { backend: { async inspect(platform, root) {
      checks.push([platform, root]);
      return verified.has(root) ? directToolReady(root) : directToolMissing;
    } } },
    installRkDirectTool: async () => assert.fail('status does not download'),
  });
  const bundle = path.join(f.resources, 'firmware-direct-tools', 'rk');
  await fs.mkdir(bundle, { recursive: true });
  verified.add(bundle);
  assert.equal((await f.call('direct:state', 'rk')).toolReady, true);
  assert.equal((await f.call('direct:state', 'rk')).toolReady, true);
  assert.deepEqual(checks, [['rk', bundle]]);
  f.setDialog({ filePaths: [f.mtk] });
  await f.call('chooseTools', 'mtk');
  verified.add(f.mtk);
  assert.equal((await f.call('direct:state', 'mtk')).toolReady, true);
  assert.equal((await f.call('direct:prepare-tool', 'mtk')).toolReady, true);
  assert.equal(f.calls.filter(([type]) => type === 'dialog').length, 1);
});

test('RK setup downloads only on the explicit request, caches verified files, and never falls back to a picker', async t => {
  const f = await setup(t, 'win32', {
    direct: { backend: { async inspect(platform, root) {
      return platform === 'rk' && installed === root ? directToolReady(root) : directToolMissing;
    } } },
    async installRkDirectTool(destination, { signal }) {
      downloads.push(destination);
      assert.equal(signal.aborted, false);
      if (downloads.length === 1) return false;
      await fs.mkdir(destination, { recursive: true });
      installed = destination;
      return true;
    },
  });
  let installed;
  const downloads = [];
  assert.equal((await f.call('direct:state', 'rk')).toolReady, false);
  assert.deepEqual(downloads, []);
  const spoofed = { sender: f.event.sender, senderFrame: {} };
  assert.equal((await f.call('direct:prepare-tool', 'rk', spoofed)).ok, false);
  assert.deepEqual(downloads, []);
  assert.deepEqual(await f.call('direct:prepare-tool', 'rk'), { ok: false, code: 'flash-tool-unavailable' });
  assert.equal(f.calls.some(([type]) => type === 'dialog'), false);
  assert.equal((await f.call('direct:prepare-tool', 'rk')).toolReady, true);
  assert.deepEqual(downloads, Array(2).fill(path.join(f.userData, 'firmware-direct-tools', 'rk-2.46')));
  f.reopen();
  assert.equal((await f.call('direct:state', 'rk')).toolReady, true);
  assert.equal(f.calls.length, 0);
});

test('only explicitly selected verified local direct directories are persisted across launches', async t => {
  const verified = new Set();
  const f = await setup(t, 'win32', {
    direct: { backend: { inspect: async (_platform, root) => verified.has(root) ? directToolReady(root) : directToolMissing } },
    installRkDirectTool: async () => assert.fail('offline configuration must not download'),
  });
  for (const platform of ['rk', 'mtk']) {
    f.setDialog({ filePaths: [f[platform]] });
    const options = platform === 'rk' ? { local: true } : undefined;
    assert.equal((await f.call('direct:prepare-tool', platform, f.event, options)).ok, false);
    verified.add(f[platform]);
    assert.equal((await f.call('direct:prepare-tool', platform, f.event, options)).toolReady, true);
  }
  f.reopen();
  assert.equal((await f.call('direct:state', 'rk')).toolReady, true);
  assert.equal((await f.call('direct:state', 'mtk')).toolReady, true);
  assert.equal(f.calls.filter(([type]) => type === 'dialog').length, 4);
});

test('native selection remembers distinct RK and MTK folders across registrations', async t => {
  const f = await setup(t);
  f.setDialog({ filePaths: [f.rk] });
  assert.equal((await f.call('chooseTools', 'rk')).toolRoot, f.rk);
  f.setDialog({ filePaths: [f.mtk] });
  assert.equal((await f.call('chooseTools', 'mtk')).toolRoot, f.mtk);
  f.reopen();
  assert.equal((await f.call('status', 'rk')).toolRoot, f.rk);
  assert.equal((await f.call('status', 'mtk')).toolRoot, f.mtk);
  assert.equal((await f.call('installDriver', 'rk')).status.state, 'installed');
  assert.deepEqual(f.calls.at(-1), ['install', 'rk', f.rk, { confirmed: true }]);
  assert.equal((await f.call('openTool', 'mtk', f.event, 'untrusted-path-or-argument')).ok, true);
  assert.deepEqual(f.calls.at(-1), ['open', 'mtk', f.mtk]);
});

test('startup warms the inventory and only the explicit refresh bit forces a fresh status', async t => {
  const f = await setup(t);
  await f.warmup();
  await f.call('status', 'rk');
  await f.call('status', 'mtk', f.event, 'path');
  await f.call('status', 'rk', f.event, true);
  assert.deepEqual(f.calls, [
    ['warmup'], ['status', 'rk', '', { refresh: false }],
    ['status', 'mtk', '', { refresh: false }], ['status', 'rk', '', { refresh: true }],
  ]);
});

test('a signed driver selection is independent of vendor tools and remembered per platform', async t => {
  const f = await setup(t);
  f.setDialog({ filePaths: [path.join(f.rk, 'rockusb.inf')] });
  assert.equal((await f.call('installDriver', 'rk')).ok, true);
  assert.deepEqual(f.calls.at(-1), ['install', 'rk', '', { confirmed: true, driverDirectory: f.rk }]);
  f.reopen();
  f.setDialog({ canceled: true });
  assert.equal((await f.call('installDriver', 'rk')).ok, true);
  assert.deepEqual(f.calls.at(-1), ['install', 'rk', '', { confirmed: true, driverDirectory: f.rk }]);
  assert.deepEqual(await f.call('installDriver', 'mtk'), { ok: false, cancelled: true });
  f.setDialog({ filePaths: [path.join(f.mtk, 'invalid.inf')] });
  const result = await f.call('installDriver', 'mtk');
  assert.equal(result.ok, false);
  assert.match(result.error, /驱动包校验失败/);
  assert.equal(f.calls.filter(([type]) => type === 'install').length, 2);
});

test('firmware picker runs only read-only preflight on a native file and handles cancellation', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.call('chooseFile', 'rk'), { ok: false, cancelled: true });
  f.setDialog({ filePaths: ['D:/固件/flash.xml'] });
  const result = await f.call('chooseFile', 'mtk', f.event, 'renderer-path');
  assert.equal(result.filePath, 'D:/固件/flash.xml');
  assert.deepEqual(f.calls.at(-1), ['preflight', 'mtk', result.filePath]);
  assert.deepEqual(f.calls.at(-2)[1].filters[0].extensions, ['xml']);
});

test('a cancelled picker keeps the receipt but a newly selected invalid file revokes it', async t => {
  const sha256 = 'a'.repeat(64);
  let contentReads = 0;
  const f = await setup(t, 'win32', {
    preflight: async (_platform, file) => ({
      ok: !file.endsWith('invalid.xml'), fileName: path.basename(file),
    }),
    direct: {
      profiles: [{ platform: 'mtk', mode: 'download-only', chip: 'MT8189', firmwareSha256: sha256 }],
      firmware: { prepareDirectFirmware: async () => { contentReads++; return { chip: 'MT8189', sha256 }; } },
    },
  });
  f.setDialog({ filePaths: [path.join(f.mtk, 'valid.xml')] });
  const { firmwareId } = await f.call('chooseFile', 'mtk');
  assert.ok(firmwareId);
  f.setDialog({ canceled: true });
  assert.deepEqual(await f.call('chooseFile', 'mtk'), { ok: false, cancelled: true });
  const validate = () => f.call('direct:validate-file', 'mtk', f.event, { firmwareId });
  assert.deepEqual(await validate(), { ok: true, modes: ['download-only'] });
  f.setDialog({ filePaths: [path.join(f.mtk, 'invalid.xml')] });
  assert.equal((await f.call('chooseFile', 'mtk')).ok, false);
  assert.equal((await validate()).cancelled, true);
  assert.equal(contentReads, 1);
});

test('only the main frame can use firmware controls, and a main window replaced during a picker is rejected', async t => {
  const f = await setup(t);
  assert.equal((await f.call('installDriver', 'mtk', { ...f.event, senderFrame: {} })).ok, false);
  assert.equal((await f.call('openTool', 'constructor')).ok, false);
  assert.deepEqual(f.calls, []);
  f.setDialog(() => { f.setOwner(null); return { filePaths: [f.rk] }; });
  assert.deepEqual(await f.call('chooseTools', 'rk'), { ok: false, cancelled: true });
  assert.equal((await f.call('status', 'rk')).ok, false);
});

test('firmware operations and startup warmup do not start on unsupported hosts', async t => {
  const unsupported = await setup(t, 'linux');
  await unsupported.warmup();
  assert.equal((await unsupported.call('installDriver', 'rk')).ok, false);
  assert.deepEqual(unsupported.calls, []);
});
