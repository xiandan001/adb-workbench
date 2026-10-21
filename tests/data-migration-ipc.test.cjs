const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function harness(t, restartError = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-migration-ipc-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('adb-migration-ipc-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const backup = path.join(root, 'fixture.adbbackup'); fs.writeFileSync(backup, 'fixture');
  const sender = {};
  const handlers = new Map();
  const timers = [];
  const calls = [];
  const dialog = {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [backup] }),
    showErrorBox() {}
  };
  const core = {
    readArchive: () => ({ payload: { files: [] }, summary: { fileCount: 0, totalBytes: 5 } }),
    stageImport: async (_directory, payload, prefs) => { calls.push({ payload, prefs }); return { id: 'pending' }; },
    finalizeStartupImport: async (_directory, id) => { calls.push({ ack: id }); },
    applyPendingImport: async () => ({ id: 'boot', status: 'applied', preferences: { currentTheme: 'tech' }, recoveryPath: 'recovery' }),
    hasPendingImport: () => true
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/lib/data-migration.cjs'), 'utf8'), {
    module, console, setTimeout: callback => { timers.push(callback); },
    require: name => {
      if (name === 'electron') return { app: { getPath: value => value === 'userData' ? data : root, getVersion: () => '4.3.2' }, dialog, BrowserWindow: { fromWebContents: () => ({}) } };
      if (name === './app-context.cjs') return { getMainWindow: () => ({ webContents: sender }) };
      if (name === './data-migration-core.cjs') return core;
      return require(name);
    }
  });
  module.exports.register({ handle: (name, action) => handlers.set(name, action) }, { restart: () => {
    if (restartError) throw new Error(restartError);
    calls.push({ restart: true });
  } });
  return { root, data, backup, sender, handlers, timers, calls, dialog, core, api: module.exports };
}

test('migration is restricted to main window and cancellation does not create data', async t => {
  const h = harness(t);
  assert.equal((await h.handlers.get('migration:preview')({ sender: {} })).ok, false);
  assert.equal((await h.handlers.get('migration:export')({ sender: h.sender }, {})).cancelled, true);
  assert.equal(h.calls.length, 0);
});

test('import requires current preview token and explicit confirmation; staging precedes restart', async t => {
  const h = harness(t);
  const event = { sender: h.sender };
  assert.equal((await h.handlers.get('migration:import')(event, { token: 'fake', confirmed: true })).ok, false);
  const preview = await h.handlers.get('migration:preview')(event);
  assert.equal(preview.summary.bytes, 5);
  assert.equal((await h.handlers.get('migration:import')(event, { token: preview.token })).ok, false);
  assert.equal(h.calls.length, 0);
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true, preferences: {} });
  assert.equal(result.restarting, true);
  assert.equal(h.calls.length, 2);
  assert.equal(fs.readdirSync(h.data).length, 0);
  assert.equal((await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true })).ok, false);
  assert.equal(h.calls[1].restart, true);
});

test('restart scheduling failure returns an error and releases the migration UI lock', async t => {
  const h = harness(t, 'cannot relaunch');
  const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true, preferences: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /手动关闭并重新打开/);
  assert.equal(result.restarting, undefined);
  assert.equal((await h.handlers.get('migration:export')(event, {})).cancelled, true);
});

test('corrupt backup fails before preview token or pending writes', async t => {
  const h = harness(t);
  h.core.readArchive = () => { throw new Error('corrupt archive'); };
  const result = await h.handlers.get('migration:preview')({ sender: h.sender });
  assert.equal(result.ok, false); assert.equal(result.token, undefined);
  assert.equal(h.calls.length, 0);
});

test('startup acknowledgement validates identity and keeps visible recovery result', async t => {
  const h = harness(t); await h.api.prepareStartup();
  const event = { sender: h.sender };
  assert.equal((await h.handlers.get('migration:bootstrap')(event)).status, 'applied');
  assert.equal((await h.handlers.get('migration:acknowledge')(event, { id: 'foreign' })).ok, false);
  const result = await h.handlers.get('migration:acknowledge')(event, { id: 'boot' });
  assert.equal(result.status, 'completed');
  assert.equal((await h.handlers.get('migration:bootstrap')(event)).preferences, undefined);
  assert.equal(result.recoveryPath, 'recovery');
});
