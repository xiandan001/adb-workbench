const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupSettingsService } = require('../electron/lib/startup-settings-service.cjs');
const { createStartupSettingsController } = require('../electron/lib/startup-settings.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-startup-ipc-'));
  const app = { isPackaged: false, getPath: () => directory,
    getLoginItemSettings() { throw Error('OS read must not run'); }, setLoginItemSettings() { throw Error('OS write must not run'); } };
  const service = createStartupSettingsService({ app, directory, platform: 'win32', environment: {}, defaultApp: false });
  const frame = {}; const contents = { mainFrame: frame, isDestroyed: () => false };
  const owner = { webContents: contents, isDestroyed: () => false }; const handlers = new Map();
  const controller = createStartupSettingsController({ service, getOwner: () => owner }); controller.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  t.after(() => { controller.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const event = { sender: contents, senderFrame: frame };
  return { directory, service, owner, controller, event, call: (method, args, source = event) => handlers.get(`startup-settings:${method}`)(source, args) };
}

test('only the current main window main frame can read or change startup preferences', async t => {
  const h = fixture(t);
  for (const event of [{ sender: {} }, { sender: h.event.sender }, { sender: h.event.sender, senderFrame: {} }]) {
    for (const method of ['get', 'set']) {
      const result = await h.call(method, method === 'set' ? { enabled: false } : undefined, event);
      assert.equal(result.success, false); assert.equal(result.error.code, 'STARTUP_SETTINGS_OWNER'); assert.equal(result.result, undefined);
    }
  }
  assert.equal(fs.existsSync(path.join(h.directory, 'startup-preferences.json')), false);
  const initial = await h.call('get'); assert.equal(initial.success, true); assert.equal(initial.result.enabled, true);
  const saved = await h.call('set', { enabled: false }); assert.equal(saved.result.enabled, false); assert.equal(saved.result.registered, null);
});

test('IPC rejects arbitrary commands and revalidates owner/frame before a queued operation writes', async t => {
  const h = fixture(t);
  assert.equal((await h.call('get', { enabled: false })).error.code, 'STARTUP_SETTINGS_ARGUMENT');
  assert.equal((await h.call('set', { enabled: false, path: 'C:\\other.exe' })).error.code, 'STARTUP_SETTINGS_ARGUMENT');
  const pending = h.call('set', { enabled: false }); h.owner.webContents.mainFrame = {};
  assert.equal((await pending).error.code, 'STARTUP_SETTINGS_OWNER');
  assert.equal(fs.existsSync(path.join(h.directory, 'startup-preferences.json')), false);
});

test('disposing stops queued changes without changing the persistent startup intention', async t => {
  const h = fixture(t); await h.call('set', { enabled: true });
  const pending = h.call('set', { enabled: false }); h.controller.dispose();
  const result = await pending; assert.equal(result.success, false); assert.equal(result.error.code, 'STARTUP_SETTINGS_DISPOSED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory, 'startup-preferences.json'))).enabled, true);
});

test('authorization failures cannot return cached settings, even if the owner lookup throws', async () => {
  let calls = 0; const handlers = new Map();
  const controller = createStartupSettingsController({ getOwner() { throw Error('private owner detail'); },
    service: { get() { calls++; }, snapshot: () => ({ enabled: true, preferredEnabled: true }), dispose() {} } });
  controller.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  const result = await handlers.get('startup-settings:get')({});
  assert.equal(result.success, false); assert.equal(result.result, undefined); assert.equal(result.error.code, 'STARTUP_SETTINGS_OWNER');
  assert.ok(!result.error.message.includes('private')); assert.equal(calls, 0);
});

test('preload exposes only the two bounded startup setting operations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  assert.match(source, /startupSettingsGet: \(\) => ipcRenderer\.invoke\('startup-settings:get'\)/);
  assert.match(source, /startupSettingsSet: value => ipcRenderer\.invoke\('startup-settings:set', value\)/);
  assert.doesNotMatch(source, /setLoginItemSettings|getLoginItemSettings/);
});
