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
  module.exports.setLogcatProc({ running: true });
  const blocked = await handlers.get('logSession:load')({}, { id: saved.session.id });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /停止日志抓取/);
});
