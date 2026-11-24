const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { register } = require('../electron/lib/firmware-workspace.cjs');

async function setup(t, hostPlatform = 'win32') {
  const desktop = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-workspace-'));
  const userData = path.join(desktop, 'preferences');
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
    getMainWindow: () => main,
    electron: {
      app: { getPath: key => key === 'userData' ? userData : desktop },
      dialog: { showOpenDialog: async (target, settings) => {
        assert.equal(target, owner);
        calls.push(['dialog', settings]);
        return typeof nextDialog === 'function' ? nextDialog() : nextDialog;
      } },
      shell: { openExternal: async url => { calls.push(['help', url]); } },
    },
    tools: {
      status: async (platform, dir) => ({
        state: 'missing', installer: { available: dir === auto || dir === (platform === 'rk' ? rk : mtk) }, tool: { available: dir === auto }
      }),
      install: async (platform, dir, options) => {
        calls.push(['install', platform, dir, options]);
        return { ok: true, status: { state: 'installed' } };
      },
      open: async (platform, dir) => { calls.push(['open', platform, dir]); return { ok: true }; }
    },
    preflight: async (platform, file) => { calls.push(['preflight', platform, file]); return { ok: true, fileName: path.basename(file) }; },
  };
  const binding = { handle: (key, callback) => handlers.set(key, callback) };
  register(binding, options);
  const event = { sender, senderFrame: frame };
  return {
    auto, rk, mtk, event, calls,
    setDialog(value) { nextDialog = value; }, setOwner(value) { main = value; },
    reopen() { register(binding, options); },
    call: (name, platform, origin = event, ...args) => handlers.get(`firmware:${name}`)(origin, platform, ...args),
  };
}

test('native selection remembers distinct RK and MTK folders across registrations', async t => {
  const f = await setup(t);
  assert.equal((await f.call('status', 'rk')).toolRoot, f.auto);
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

test('firmware picker runs only read-only preflight on a native file and handles cancellation', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.call('chooseFile', 'rk'), { ok: false, cancelled: true });
  f.setDialog({ filePaths: ['D:/固件/flash.xml'] });
  const result = await f.call('chooseFile', 'mtk', f.event, 'renderer-path');
  assert.equal(result.filePath, 'D:/固件/flash.xml');
  assert.deepEqual(f.calls.at(-1), ['preflight', 'mtk', result.filePath]);
  assert.deepEqual(f.calls.at(-2)[1].filters[0].extensions, ['xml']);
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

test('vendor URL is fixed per platform and operations do not start on unsupported hosts', async t => {
  const f = await setup(t);
  await f.call('openVendorHelp', 'mtk', f.event, 'https://example.invalid');
  assert.match(f.calls[0][1], /^https:\/\/genio\.mediatek\.com\//);
  const unsupported = await setup(t, 'linux');
  assert.equal((await unsupported.call('installDriver', 'rk')).ok, false);
  assert.deepEqual(unsupported.calls, []);
});
