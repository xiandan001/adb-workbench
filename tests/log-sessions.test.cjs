const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createSessionStore, normalizeSession, register } = require('../electron/lib/log-sessions.cjs');

function fixture() {
  return {
    name: '日志会话', source: 'file', sourceLabel: 'fixture.log', deviceId: 'device-1',
    filter: { pkg: 'com.example', minLevel: 'E', text: 'failure' }, buffers: ['main', 'crash'],
    entries: [{ id: 'log1', raw: '原始 failure 日志', source: 'file', ts: 1000, pkg: 'com.example' }],
    evidence: [{ id: 'log1', raw: '原始 failure 日志', ref: 'L1', deviceId: 'device-1' }],
    aiTurns: [{ header: '分析', content: '日志事实 [L1]', reasoning: '', evidenceRefs: ['L1'] }],
    truncated: true
  };
}

function tempStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-log-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createSessionStore(directory) };
}

test('session round-trip preserves raw logs, filters, sources, AI references and explicit limited scope', async t => {
  const { store } = tempStore(t);
  const saved = await store.save(fixture());
  const restored = await store.read(saved.id);
  assert.equal(restored.entries[0].raw, '原始 failure 日志');
  assert.equal(restored.evidence[0].ref, 'L1');
  assert.deepEqual(restored.aiTurns[0].evidenceRefs, ['L1']);
  assert.deepEqual(restored.filter, fixture().filter);
  assert.equal(restored.sourceLabel, 'fixture.log');
  assert.equal(restored.readOnlyAi, true);
  assert.equal(restored.truncated, true);
  assert.equal(restored.savedScope, 'loaded-entries');
  const listing = await store.list();
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].entryCount, 1);
  assert.deepEqual(listing.errors, []);
});

test('saving enforces limits and rejects missing evidence instead of truncating', () => {
  assert.throws(() => normalizeSession({ ...fixture(), entries: Array(50001).fill(fixture().entries[0]) }), /50,000/);
  assert.throws(() => normalizeSession({ ...fixture(), aiTurns: Array(501).fill(fixture().aiTurns[0]) }), /500/);
  assert.throws(() => normalizeSession({ ...fixture(), evidence: [] }), /缺少对应原始证据/);
  assert.throws(() => normalizeSession({ ...fixture(), evidence: [fixture().evidence[0], fixture().evidence[0]] }), /重复/);
});

test('markers survive session round-trip and legacy sessions remain readable without markers', async t => {
  const { directory, store } = tempStore(t);
  const marker = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', note: '开始黑屏', createdAt: 12345,
    entry: { id: 'previous-log', raw: '已滚出窗口的原始日志', ts: 1000, deviceId: 'old-device', source: 'realtime' },
    context: [{ id: 'previous-context', raw: '问题附近原文', ts: 999, deviceId: 'old-device' }] };
  const saved = await store.save({ ...fixture(), markers: [marker] });
  assert.deepEqual((await store.read(saved.id)).markers, [marker]);
  assert.equal((await store.list()).sessions[0].markerCount, 1);
  const file = path.join(directory, `${saved.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.markers;
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
  assert.deepEqual((await store.read(saved.id)).markers, []);
  assert.throws(() => normalizeSession({ ...fixture(), markers: Array(501).fill(marker) }), /500/);
  assert.throws(() => normalizeSession({ ...fixture(), markers: [{ ...marker, context: Array(12).fill(marker.entry) }] }), /11/);
  assert.throws(() => normalizeSession({ ...fixture(), markers: [marker, marker] }), /重复/);
});

test('normal history lists use metadata, legacy and damaged caches rebuild only once', async t => {
  const { directory, store } = tempStore(t);
  const saved = await store.save(fixture());
  const source = path.join(directory, `${saved.id}.json`);
  const metadata = path.join(directory, '.metadata', `${saved.id}.json`);
  const originalRead = fs.promises.readFile;
  let fullReads = 0;
  t.mock.method(fs.promises, 'readFile', async function (file, ...args) {
    if (String(file) === source) fullReads += 1;
    return originalRead.call(this, file, ...args);
  });
  await createSessionStore(directory).list();
  assert.equal(fullReads, 0);
  fs.unlinkSync(metadata);
  await store.list();
  await createSessionStore(directory).list();
  assert.equal(fullReads, 1);
  fs.writeFileSync(metadata, '{broken', 'utf8');
  await store.list();
  await store.list();
  assert.equal(fullReads, 2);
});

test('rename preserves original data, timestamp and updates metadata; recycle delete requires confirmation', async t => {
  const { directory, store } = tempStore(t);
  const saved = await store.save(fixture());
  const before = await store.read(saved.id);
  const renamed = await store.rename(saved.id, '新的中文名称');
  assert.equal(renamed.name, '新的中文名称');
  assert.equal(renamed.savedAt, saved.savedAt);
  assert.deepEqual((await store.read(saved.id)).entries, before.entries);
  assert.deepEqual((await store.read(saved.id)).aiTurns, before.aiTurns);
  assert.equal((await store.list()).sessions[0].name, '新的中文名称');
  await assert.rejects(store.rename(saved.id, ''), /名称/);
  await assert.rejects(store.rename('../../outside', 'name'), /ID/);
  await assert.rejects(store.trash(saved.id, false), /确认/);
  await assert.rejects(store.trash(saved.id, true), /不支持回收站/);
  const trashed = [];
  const recycleStore = createSessionStore(directory, { trashItem: async file => {
    trashed.push(file);
    fs.renameSync(file, `${file}.recycled`);
  } });
  await assert.rejects(recycleStore.trash('../outside', true), /ID/);
  await recycleStore.trash(saved.id, true);
  assert.deepEqual(trashed, [path.join(directory, `${saved.id}.json`)]);
  assert.equal((await recycleStore.list()).sessions.length, 0);
  assert.equal(fs.existsSync(`${trashed[0]}.recycled`), true);
});

test('failed recycle request leaves the session and metadata intact', async t => {
  const { directory, store } = tempStore(t);
  const saved = await store.save(fixture());
  const recycleStore = createSessionStore(directory, { trashItem: async () => { throw new Error('recycle unavailable'); } });
  await assert.rejects(recycleStore.trash(saved.id, true), /recycle unavailable/);
  assert.equal((await recycleStore.list()).sessions.length, 1);
  assert.equal((await recycleStore.read(saved.id)).name, fixture().name);
});

test('rename refuses a name that would exceed the size limit before changing the original', async t => {
  const { directory } = tempStore(t);
  const sourcePath = path.join(__dirname, '../electron/lib/log-sessions.cjs');
  const module = { exports: {} };
  // Exercise the exact production byte guard with a small cap instead of allocating a 64 MB fixture.
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8').replace('64 * 1024 * 1024', '2048'), {
    module, exports: module.exports, require, Buffer
  }, { filename: sourcePath });
  const store = module.exports.createSessionStore(directory);
  const input = { ...fixture(), name: 'a' };
  const normalized = { ...module.exports.normalizeSession(input), id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', savedAt: new Date().toISOString() };
  input.entries[0].raw += 'x'.repeat(2048 - Buffer.byteLength(JSON.stringify(normalized), 'utf8'));
  const saved = await store.save(input);
  const file = path.join(directory, `${saved.id}.json`);
  const before = fs.readFileSync(file);
  assert.equal(before.length, 2048);
  await assert.rejects(store.rename(saved.id, '新'.repeat(80)), /64 MB/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await store.read(saved.id)).name, 'a');
});

test('metadata junction cannot supply a false summary or cause external deletion', async t => {
  const { directory, store } = tempStore(t);
  const saved = await store.save(fixture());
  const metadataDirectory = path.join(directory, '.metadata');
  const outside = path.join(directory, 'unrelated-data');
  fs.mkdirSync(outside);
  const metadata = JSON.parse(fs.readFileSync(path.join(metadataDirectory, `${saved.id}.json`), 'utf8'));
  metadata.session.name = 'outside fake';
  const outsideFile = path.join(outside, `${saved.id}.json`);
  fs.writeFileSync(outsideFile, JSON.stringify(metadata), 'utf8');
  fs.renameSync(metadataDirectory, path.join(directory, 'original-cache'));
  try { fs.symlinkSync(outside, metadataDirectory, 'junction'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('junction creation unavailable'); return; } throw error; }
  assert.equal((await store.list()).sessions[0].name, fixture().name);
  assert.equal(JSON.parse(fs.readFileSync(outsideFile, 'utf8')).session.name, 'outside fake');
  const recycleStore = createSessionStore(directory, { trashItem: async file => fs.renameSync(file, `${file}.recycled`) });
  await recycleStore.trash(saved.id, true);
  assert.equal(fs.existsSync(outsideFile), true);
});

test('store rejects path traversal and lists corrupt files as errors', async t => {
  const { directory, store } = tempStore(t);
  await assert.rejects(store.read('../../outside'), /ID 无效/);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(directory, `${id}.json`), '{invalid', 'utf8');
  const listing = await store.list();
  assert.equal(listing.sessions.length, 0);
  assert.equal(listing.errors[0].id, id);
});

test('session IPC loads only through explicit request and invokes only local restore hook', async t => {
  const { directory } = tempStore(t);
  const handlers = new Map();
  const calls = [];
  register({ handle: (channel, action) => handlers.set(channel, action) }, { getDirectory: () => directory, restore: data => calls.push(data.id) });
  assert.deepEqual(calls, []);
  const saved = await handlers.get('logSession:save')({}, fixture());
  assert.equal(saved.ok, true);
  assert.deepEqual(calls, []);
  const loaded = await handlers.get('logSession:load')({}, { id: saved.session.id });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.readOnlyAi, true);
  assert.deepEqual(calls, [saved.session.id]);
});

test('logger context changes never start capture or AI; session restore uses local store only', async t => {
  const { directory } = tempStore(t);
  const handlers = new Map();
  const events = [];
  let aiClears = 0;
  let currentWindow = {
    isDestroyed: () => false, focus() {},
    webContents: { isLoading: () => false, send: (channel, payload) => events.push({ channel, payload }) }
  };
  const ctx = {
    isDev: false, getLogAnalyzerWindow: () => currentWindow, setLogAnalyzerWindow: value => { currentWindow = value; },
    broadcastToAllWindows: () => {}, getMainWindow: () => null
  };
  const module = { exports: {} };
  const sourcePath = path.join(__dirname, '../electron/lib/log-analyzer.cjs');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(sourcePath), console, Buffer, setTimeout, clearTimeout,
    require: name => {
      if (name === 'electron') return { app: { getPath: () => directory } };
      if (name === './app-context.cjs') return ctx;
      if (name === './adb-runtime.cjs') return { runAdb: () => { throw new Error('No ADB allowed'); }, spawnAdb: () => { throw new Error('No ADB allowed'); } };
      if (name === './ai-analyze.cjs') return { hasActiveAiRequest: () => false, clearAiConversation: () => { aiClears += 1; } };
      if (name === './log-sessions.cjs') return require('../electron/lib/log-sessions.cjs');
      if (name === './log-capture-buffer.cjs') return require('../electron/lib/log-capture-buffer.cjs');
      return require(name);
    }
  }, { filename: sourcePath });
  module.exports.register({ handle: (channel, action) => handlers.set(channel, action) });
  await handlers.get('logAnalyzer:open')({}, { deviceId: 'device-1', packageName: 'com.example' });
  const context = await handlers.get('logAnalyzer:getContext')();
  assert.equal(context.deviceId, 'device-1');
  assert.equal(events[0].channel, 'logAnalyzer:context');
  await handlers.get('logAnalyzer:open')({}, { deviceId: 'device-2' });
  const nextContext = await handlers.get('logAnalyzer:getContext')();
  assert.equal(nextContext.deviceId, 'device-2');
  assert.equal(nextContext.packageName, '');
  const saved = await handlers.get('logSession:save')({}, fixture());
  const loaded = await handlers.get('logSession:load')({}, { id: saved.session.id });
  assert.equal(loaded.ok, true);
  assert.equal(aiClears, 1);
  assert.equal(module.exports.getLogcatProc(), null);
  assert.equal(module.exports.getLogStore().file[0].raw, fixture().entries[0].raw);
  const savedRealtime = await handlers.get('logSession:save')({}, { ...fixture(), source: 'realtime' });
  const loadedRealtime = await handlers.get('logSession:load')({}, { id: savedRealtime.session.id });
  assert.equal(loadedRealtime.ok, true);
  assert.equal(module.exports.getLogStore().realtime[0].raw, fixture().entries[0].raw);
  assert.equal(module.exports.getLogStoreBytes().realtime, Buffer.byteLength(fixture().entries[0].raw));
  module.exports.setLogcatProc({ running: true });
  const blocked = await handlers.get('logSession:load')({}, { id: saved.session.id });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /停止日志抓取/);
});
