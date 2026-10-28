const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { createReproductionStore } = require('../electron/lib/reproduction-store.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-repro-ipc-'));
  const store = createReproductionStore(path.join(directory, 'sessions'));
  const state = { active: false, unsaved: false, stopped: 0, exports: [], handoffs: [], events: [], reads: 0,
    answer: { canceled: true }, failExport: false, stopResult: { ok: true } };
  const service = { store, onChange() {}, async list() { state.reads++; return store.list(); }, load: id => store.load(id),
    hasActive: () => state.active, hasUnpersisted: () => state.unsaved,
    async stopCurrent() { state.stopped++; if (state.stopResult.ok) { state.active = false; state.unsaved = false; } return state.stopResult; } };
  const sender = { mainFrame: {} }, owner = { webContents: sender, isDestroyed: () => false };
  const filename = path.join(__dirname, '../electron/lib/reproduction.cjs'), originalRequire = createRequire(filename);
  const module = { exports: {} }, handlers = new Map();
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, Buffer, require(name) {
    if (name === 'electron') return { app: { getPath: () => directory }, dialog: { showSaveDialog: async () => state.answer } };
    if (name === './app-context.cjs') return { getMainWindow: () => owner, broadcastToAllWindows() {} };
    if (name === './reproduction-session.cjs') return { createReproductionService: () => service };
    if (name === './reproduction-sources.cjs') return { createSourceSnapshots: () => ({}), listSources: () => ({ serial: [], ssh: [] }) };
    if (name === './workbench-activity.cjs') return { begin: args => { state.events.push(args); return args.id; }, update() {}, finish: (id, value) => state.events.push({ id, ...value }) };
    if (name === './ai-analysis-handoff.cjs') return { createInternal: async value => { state.handoffs.push(value); return { handoffId: 'fixture-handoff' }; } };
    if (name === './artifact-export.cjs') return { isWithin: originalRequire(name).isWithin, exportArtifact: async (artifact, destination) => {
      const names = await fs.readdir(artifact.rootPath);
      state.exports.push({ artifact, destination, names, log: await fs.readFile(path.join(artifact.rootPath, 'device.log'), 'utf8') });
      await fs.writeFile(destination, 'fixture staged archive');
      if (state.failExport) throw new Error('fixture export failed');
      return { count: names.length };
    } };
    if (['./serial.cjs', './ssh.cjs', './screen-recording.cjs'].includes(name)) return {};
    return originalRequire(name);
  } }, { filename });
  module.exports.register({ handle: (name, callback) => handlers.set(name, callback) });
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('awb-repro-ipc-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const invoke = (method, args, event = { sender, senderFrame: sender.mainFrame }) => handlers.get(`reproduction:${method}`)(event, args);
  const seed = async (status = 'completed') => {
    const value = { schemaVersion: 1, id: randomUUID(), title: 'Synthetic reproduction', deviceId: 'QA-ONLY', startedAt: Date.now(), status,
      files: [{ name: 'device.log', label: 'Fixture log', bytes: 16, truncated: false }], markers: [], warnings: [] };
    await store.create(value); await fs.writeFile(await store.filePath(value.id, 'device.log'), 'fixture evidence');
    return value;
  };
  return { directory, store, state, service, owner, sender, invoke, seed, api: module.exports };
}

test('reproduction IPC rejects other windows and child frames before inspecting any requested files', async t => {
  const h = await fixture(t), before = h.state.reads;
  for (const method of ['list', 'sources', 'start', 'mark', 'stop', 'retrySave', 'open', 'read', 'analyze', 'export']) {
    assert.equal((await h.invoke(method, { id: '../private' }, { sender: h.sender, senderFrame: {} })).ok, false);
    assert.equal((await h.invoke(method, {}, { sender: {}, senderFrame: h.sender.mainFrame })).ok, false);
  }
  assert.equal(h.state.reads, before); assert.equal(h.state.exports.length, 0); assert.equal(h.state.handoffs.length, 0);
});

test('reproduction text preview is bounded, requires a declared file and cannot read a video or traversed path', async t => {
  const h = await fixture(t), session = await h.seed();
  await fs.writeFile(await h.store.filePath(session.id, 'device.log'), 'x'.repeat(100 * 1024));
  const preview = await h.invoke('read', { id: session.id, name: 'device.log' });
  assert.equal(preview.ok, true); assert.equal(preview.truncated, true); assert.equal(Buffer.byteLength(preview.text), 64 * 1024);
  for (const name of ['../secret', 'video.mp4', 'markers.json', 'manifest.json']) assert.equal((await h.invoke('read', { id: session.id, name })).ok, false);
  assert.equal((await h.invoke('open', { id: '../outside' })).ok, false);
});

test('analysis creates only an explicit frozen handoff and never submits active or unsaved evidence', async t => {
  const h = await fixture(t), session = await h.seed('recording');
  assert.equal((await h.invoke('analyze', { id: session.id })).ok, false);
  session.status = 'completed'; await h.store.save(session);
  const originalLoad = h.service.load; h.service.load = async id => ({ ...await originalLoad(id), unsaved: true });
  assert.equal((await h.invoke('analyze', { id: session.id })).ok, false); assert.equal(h.state.handoffs.length, 0);
  h.service.load = originalLoad;
  const result = await h.invoke('analyze', { id: session.id });
  assert.equal(result.ok, true); assert.equal(result.handoffId, 'fixture-handoff');
  assert.equal(h.state.handoffs[0].deviceId, session.deviceId); assert.match(h.state.handoffs[0].text, /fixture evidence/);
  assert.equal(h.state.handoffs[0].origin, 'reproduction'); assert.equal(h.state.exports.length, 0);
});

test('export stages only declared evidence and atomically replaces the explicitly selected destination', async t => {
  const h = await fixture(t), session = await h.seed();
  const sourceDirectory = await h.store.checkedDirectory(session.id);
  await fs.writeFile(path.join(sourceDirectory, 'not-selected-private.txt'), 'excluded');
  const destination = path.join(h.directory, 'chosen.zip'); await fs.writeFile(destination, 'previous archive');
  assert.equal((await h.invoke('export', { id: session.id })).cancelled, true);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous archive');
  h.state.answer = { canceled: false, filePath: destination };
  const result = await h.invoke('export', { id: session.id });
  assert.equal(result.ok, true); assert.equal(result.path, destination);
  assert.deepEqual(h.state.exports[0].names.sort(), ['device.log', 'manifest.json']);
  assert.equal(h.state.exports[0].log, 'fixture evidence');
  assert.equal(await fs.readFile(destination, 'utf8'), 'fixture staged archive');
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'not-selected-private.txt'), 'utf8'), 'excluded');
  await assert.rejects(fs.stat(h.state.exports[0].artifact.rootPath), { code: 'ENOENT' });
  assert.equal((await fs.readdir(h.directory)).some(name => name.startsWith('.reproduction-')), false);
});

test('failed export preserves an old destination and rejects source-store destinations and hard links', async t => {
  const h = await fixture(t), session = await h.seed(), destination = path.join(h.directory, 'old.zip');
  await fs.writeFile(destination, 'original archive'); h.state.failExport = true;
  h.state.answer = { canceled: false, filePath: destination };
  assert.equal((await h.invoke('export', { id: session.id })).ok, false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original archive');
  await assert.rejects(fs.stat(h.state.exports[0].artifact.rootPath), { code: 'ENOENT' });
  h.state.answer.filePath = path.join(await h.store.checkedDirectory(session.id), 'overwrite.zip');
  assert.equal((await h.invoke('export', { id: session.id })).ok, false);
  const link = path.join(h.directory, 'linked.zip'); await fs.link(destination, link); h.state.answer.filePath = link;
  assert.equal((await h.invoke('export', { id: session.id })).ok, false);
  assert.equal(h.state.exports.length, 1); assert.equal(await fs.readFile(destination, 'utf8'), 'original archive');
});

test('quit confirms owned capture, respects cancel and refuses to discard unsaved terminal metadata', async t => {
  const h = await fixture(t);
  assert.equal(await h.api.confirmQuit(() => { throw new Error('no prompt without active capture'); }), true);
  h.state.active = true;
  assert.equal(await h.api.confirmQuit(async () => ({ response: 0 })), false); assert.equal(h.state.stopped, 0);
  assert.equal(await h.api.confirmQuit(async () => ({ response: 1 })), true); assert.equal(h.state.stopped, 1);
  h.state.unsaved = true; h.state.stopResult = { ok: false, error: 'fixture disk full' };
  assert.equal(h.api.hasActive(), true);
  await assert.rejects(h.api.confirmQuit(async () => ({ response: 1 })), /fixture disk full/);
  assert.equal(h.api.hasActive(), true);
});
