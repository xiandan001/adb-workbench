const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const archive = require('../electron/lib/data-migration-archive.cjs');
const codec = require('../electron/lib/data-migration-v2.cjs');
const PASSWORD = 'fixture-password';
const validPayload = () => ({ schemaVersion: 1, appVersion: '4.6.1', createdAt: '2026-10-23T00:00:00.000Z', preferences: {}, files: [] });

function harness(t, restartError = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-migration-ipc-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('adb-migration-ipc-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const backup = path.join(root, 'fixture.adbbackup'); fs.writeFileSync(backup, 'fixture');
  const sender = { mainFrame: {} };
  const handlers = new Map();
  const timers = [];
  const calls = [];
  const aiService = { exportState: async () => ({ version: 1, fixture: 'PRIVATE_AI_KEY' }),
    getExportSummary: () => ({ ai: { providers: { count: 1 } }, includesAiSessions: true }),
    previewImport: async () => ({ writes: [], guards: [], summary: { providers: { added: 1, skipped: 0 } }, warnings: [] }) };
  const ai = { reserved: false, createMigrationService: () => aiService, reserveForMigration: async () => { ai.reserved = true; return () => { ai.reserved = false; }; } };
  const serial = { needsQuitConfirmation: () => false };
  const ssh = { needsQuitConfirmation: () => false };
  ssh.reserveForMigration = () => {
    if (ssh.needsQuitConfirmation()) throw new Error('请先断开 SSH');
    ssh.reserved = true;
    return () => { ssh.reserved = false; };
  };
  serial.reserveForMigration = () => {
    if (serial.needsQuitConfirmation()) throw new Error('请先断开串口');
    serial.reserved = true;
    return () => { serial.reserved = false; };
  };
  const dialog = {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [backup] }),
    showErrorBox() {}
  };
  const core = {
    readArchive: () => ({ payload: validPayload(), summary: { fileCount: 0, totalBytes: 5 } }),
    createArchive: async () => Buffer.from('fixture'),
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
      if (name === './data-migration-archive.cjs') return archive;
      if (name === './data-migration-v2.cjs') return { ...codec, encode: (value, password) => codec.encode(JSON.parse(JSON.stringify(value)), password) };
      if (name === './ai-tools-file-safety.cjs') return require('../electron/lib/ai-tools-file-safety.cjs');
      if (name === './ai-tools.cjs') return ai;
      if (name === './screen-recording.cjs') return { listUnresolved: () => [] };
      if (name === './serial.cjs') return serial;
      if (name === './ssh.cjs') return ssh;
      return require(name);
    }
  });
  module.exports.register({ handle: (name, action) => handlers.set(name, (event, args) => {
    if (event.sender === sender && !Object.hasOwn(event, 'senderFrame')) event.senderFrame = sender.mainFrame;
    return action(event, args);
  }) }, { restart: () => {
    if (restartError) throw new Error(restartError);
    calls.push({ restart: true });
  } });
  return { root, data, backup, sender, handlers, timers, calls, dialog, core, serial, ssh, ai, aiService, api: module.exports };
}

test('migration is restricted to main window and cancellation does not create data', async t => {
  const h = harness(t);
  assert.equal((await h.handlers.get('migration:preview')({ sender: {} })).ok, false);
  assert.equal((await h.handlers.get('migration:export')({ sender: h.sender }, { password: PASSWORD })).cancelled, true);
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
  assert.equal((await h.handlers.get('migration:export')(event, { password: PASSWORD })).cancelled, true);
});

test('corrupt backup fails before preview token or pending writes', async t => {
  const h = harness(t);
  h.core.readArchive = () => { throw new Error('corrupt archive'); };
  const result = await h.handlers.get('migration:preview')({ sender: h.sender });
  assert.equal(result.ok, false); assert.equal(result.token, undefined);
  assert.equal(h.calls.length, 0);
});

test('active or unsaved serial data blocks migration before staging without closing it', async t => {
  const h = harness(t); const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  h.serial.needsQuitConfirmation = () => true;
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true, preferences: {} });
  assert.equal(result.ok, false); assert.match(result.error, /串口/);
  assert.equal(h.calls.length, 0);
  h.serial.needsQuitConfirmation = () => false;
  assert.equal((await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true, preferences: {} })).ok, true);
});

test('failed migration staging releases the serial connection reservation', async t => {
  const h = harness(t); const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  h.core.stageImport = async () => { assert.equal(h.serial.reserved, true); throw new Error('disk full'); };
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true, preferences: {} });
  assert.equal(result.ok, false); assert.equal(h.serial.reserved, false);
  assert.equal(h.ssh.reserved, false);
  assert.equal(h.ai.reserved, false);
  assert.equal(h.calls.length, 0);
});

test('SSH activity blocks import and releases serial reservation without staging', async t => {
  const h = harness(t); const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  h.ssh.needsQuitConfirmation = () => true;
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true });
  assert.equal(result.ok, false); assert.match(result.error, /SSH/);
  assert.equal(h.serial.reserved, false); assert.equal(h.calls.length, 0);
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

test('encrypted backup selects once, wrong password keeps a bounded retry lease and exposes no AI secrets', async t => {
  const h = harness(t); const event = { sender: h.sender }; let selections = 0;
  fs.writeFileSync(h.backup, await codec.encode({ payload: validPayload(), ai: { version: 1, secret: 'PRIVATE_AI_KEY' } }, PASSWORD));
  h.dialog.showOpenDialog = async () => { selections++; return { canceled: false, filePaths: [h.backup] }; };
  const selected = await h.handlers.get('migration:preview')(event, {});
  assert.equal(selected.ok, true); assert.equal(selected.passwordRequired, true); assert.ok(selected.selectionToken); assert.equal(selected.token, undefined);
  const wrong = await h.handlers.get('migration:preview')(event, { selectionToken: selected.selectionToken, password: 'wrong-pass' });
  assert.equal(wrong.ok, false); assert.equal(h.calls.length, 0);
  const opened = await h.handlers.get('migration:preview')(event, { selectionToken: selected.selectionToken, password: PASSWORD });
  assert.equal(opened.ok, true); assert.equal(opened.summary.encrypted, true); assert.equal(opened.summary.ai.providers.added, 1); assert.equal(selections, 1);
  assert.ok(!JSON.stringify(opened).includes('PRIVATE_AI_KEY')); assert.equal(h.calls.length, 0);
  assert.equal((await h.handlers.get('migration:import')(event, { token: opened.token, confirmed: true, preferences: {} })).restarting, true);
  assert.equal(h.ai.reserved, true);
});

test('source changes and dead frames during password selection cannot stage data', async t => {
  const h = harness(t); const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  fs.writeFileSync(h.backup, 'changed fixture');
  assert.equal((await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true })).ok, false);
  assert.equal(h.calls.length, 0);
  h.dialog.showOpenDialog = async () => { event.senderFrame = null; return { canceled: false, filePaths: [h.backup] }; };
  assert.equal((await h.handlers.get('migration:preview')(event)).ok, false);
});

test('new exports require a password and include AI inside authenticated ciphertext only', async t => {
  const h = harness(t); const event = { sender: h.sender }; const target = path.join(h.root, 'new.adbbackup');
  h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  assert.equal((await h.handlers.get('migration:export')(event, {})).ok, false); assert.ok(!fs.existsSync(target));
  const result = await h.handlers.get('migration:export')(event, { password: PASSWORD, preferences: {}, includeAiSessions: true });
  assert.equal(result.ok, true, result.error); assert.equal(result.summary.encrypted, true); assert.equal(result.summary.ai.providers.count, 1);
  const bytes = fs.readFileSync(target); assert.equal(codec.isEncrypted(bytes), true); assert.ok(!bytes.includes(Buffer.from('PRIVATE_AI_KEY')));
  assert.equal((await codec.decode(bytes, PASSWORD)).ai.fixture, 'PRIVATE_AI_KEY');
});

test('AI reservation failure releases other reservations and never schedules restart', async t => {
  const h = harness(t); const event = { sender: h.sender };
  const preview = await h.handlers.get('migration:preview')(event);
  h.ai.reserveForMigration = async () => { throw new Error('AI busy'); };
  const result = await h.handlers.get('migration:import')(event, { token: preview.token, confirmed: true });
  assert.equal(result.ok, false); assert.equal(h.serial.reserved, false); assert.equal(h.ssh.reserved, false); assert.equal(h.calls.length, 0);
});
