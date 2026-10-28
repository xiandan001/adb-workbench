const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createReproductionService, normalizeSelection } = require('../electron/lib/reproduction-session.cjs');
const { createReproductionStore } = require('../electron/lib/reproduction-store.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startRecordingLog } = require('../electron/lib/recording-log.cjs');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-repro-test-'));
  const calls = []; let wall = 10000, tick = 0;
  const service = createReproductionService({ directory: path.join(root, 'sessions'),
    recording: { start: async () => { calls.push('video:start'); return { success: true, session: { id: 'owned-video', startedAt: wall } }; },
      stopOwned: async args => { calls.push(['video:stop', args.id]); const filename = path.join(root, 'owned.mp4'); await fs.writeFile(filename, 'synthetic video'); return { success: true, path: filename, session: { durationMs: 2500 } }; } },
    startLog: async () => { calls.push('log:start'); return { info: () => ({ bytes: 3 }), stop: async () => { calls.push('log:stop'); return { bytes: 3 }; } }; },
    samplePerformance: async () => { calls.push('performance'); return { cpu: 12 }; },
    sourceSnapshots: async () => ({ cursors: {}, items: [] }), verifyDevice: async id => { calls.push(['verify', id]); },
    now: () => wall, monotonic: () => tick, setTimer: () => ({ unref() {} }), clearTimer: () => {}, ...overrides });
  t.after(async () => { try { await service.cleanup(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  return { root, service, calls, advance: ms => { wall += ms; tick += ms; }, jumpWall: ms => { wall += ms; } };
}
const args = selection => ({ title: 'Fixture reproduction', deviceId: 'fixture-A', durationMs: 60000, selection });

test('empty/forged source selections never start device or model work', async t => {
  const h = await fixture(t);
  assert.equal((await h.service.start(args({}))).ok, false); assert.deepEqual(h.calls, []);
  assert.throws(() => normalizeSelection({ shell: 'danger' }));
  assert.throws(() => normalizeSelection({ serial: [{ workspace: 'terminal', sessionId: 'one', filePath: '../secret' }] }));
});

test('only checked sources start, duplicate starts reject and stop uses exact owned recording', async t => {
  const h = await fixture(t);
  const started = await h.service.start(args({ video: true })); assert.equal(started.ok, true);
  assert.equal((await h.service.start(args({ logs: true }))).ok, false);
  assert.ok(!h.calls.includes('log:start')); assert.ok(!h.calls.includes('performance'));
  const finished = await h.service.stop({ id: started.session.id }); assert.equal(finished.ok, true);
  assert.deepEqual(h.calls.at(-1), ['video:stop', 'owned-video']);
  assert.equal(finished.session.files[0].name, 'video.mp4');
  assert.equal(finished.session.status, 'completed');
});

test('markers retain monotonic offsets even if the host clock moves backwards', async t => {
  const h = await fixture(t); const { session } = await h.service.start(args({ performance: true }));
  h.advance(2500); h.jumpWall(-10000);
  const result = await h.service.mark({ id: session.id, note: 'Observed issue' });
  assert.equal(result.marker.offsetMs, 2500); assert.equal(result.marker.videoOffsetMs, null);
  assert.equal((await h.service.stop({ id: 'wrong-session' })).ok, false);
  assert.equal(h.service.hasActive(), true);
  await h.service.stop({ id: session.id });
});

test('changed serial/SSH sources reject before creating a recording', async t => {
  const h = await fixture(t, { sourceSnapshots: async () => ({ cursors: {}, items: [{ unavailable: true }] }) });
  assert.equal((await h.service.start(args({ video: true, ssh: [{ sessionId: 's', terminalId: 't' }] }))).ok, false);
  assert.ok(!h.calls.includes('video:start'));
});

test('a later source failure preserves video and produces partial status', async t => {
  const h = await fixture(t, { startLog: async () => { throw Error('fixture log failed'); } });
  const result = await h.service.start(args({ video: true, logs: true })); assert.equal(result.ok, false);
  assert.equal(result.session.status, 'partial'); assert.equal(result.session.files[0].name, 'video.mp4');
  assert.deepEqual(h.calls.at(-1), ['video:stop', 'owned-video']); assert.equal(h.service.hasActive(), false);
});

test('restart marks unfinished capture interrupted without restarting anything', async t => {
  const h = await fixture(t); const { session } = await h.service.start(args({ performance: true }));
  const reopened = createReproductionService({ directory: path.join(h.root, 'sessions'), recording: {}, startLog: () => assert.fail('must not start'),
    samplePerformance: () => assert.fail('must not sample'), sourceSnapshots: () => assert.fail('must not read'), verifyDevice: () => assert.fail('must not verify') });
  const list = await reopened.list(); assert.equal(list.sessions[0].id, session.id); assert.equal(list.sessions[0].status, 'interrupted');
  assert.equal(reopened.hasActive(), false);
});

test('disk status failure cannot prevent stopping owned resources', async t => {
  const published = [];
  const h = await fixture(t, { broadcast: value => published.push(value.session) }); const started = await h.service.start(args({ logs: true }));
  const original = h.service.store.save; h.service.store.save = async () => { throw Error('fixture disk failure'); };
  const result = await h.service.stop({ id: started.session.id });
  assert.equal(result.ok, false); assert.equal(published.at(-1).status, 'partial'); assert.equal(published.at(-1).unsaved, true);
  assert.equal((await h.service.load(started.session.id)).status, 'partial');
  assert.equal(h.service.hasUnpersisted(), true); assert.equal(h.service.hasActive(), false);
  h.service.store.save = original;
  assert.ok(h.calls.includes('log:stop'));
  assert.equal((await h.service.retrySave({ id: started.session.id })).ok, true); assert.equal(h.service.hasUnpersisted(), false);
});

test('store rejects traversal and external file links without touching sentinel', async t => {
  const h = await fixture(t); const { session } = await h.service.start(args({ performance: true })); await h.service.stop({ id: session.id });
  await assert.rejects(() => h.service.store.load('../outside'));
  await assert.rejects(() => h.service.store.filePath(session.id, '../outside'));
  const sentinel = path.join(h.root, 'sentinel'); await fs.writeFile(sentinel, 'keep');
  const name = await h.service.store.filePath(session.id, 'device.log'); await fs.link(sentinel, name);
  await assert.rejects(() => h.service.store.readTail(session.id, 'device.log'));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});

test('capture file caps are explicit and older bytes remain intact', async t => {
  const h = await fixture(t); const { session } = await h.service.start(args({ performance: true })); await h.service.stop({ id: session.id });
  const store = createReproductionStore(path.join(h.root, 'sessions'));
  const first = await store.append(session.id, 'serial-terminal.jsonl', { text: 'first' }, 40); assert.equal(first.truncated, false);
  const second = await store.append(session.id, 'serial-terminal.jsonl', { text: 'x'.repeat(100) }, 40); assert.equal(second.truncated, true);
  assert.match((await store.readTail(session.id, 'serial-terminal.jsonl')).text, /first/);
});

test('stop flushes selected buffer observations since the last sample without starting new performance reads', async t => {
  let text = '';
  const h = await fixture(t, { sourceSnapshots: async (_selection, cursors) => ({ cursors,
    items: text ? [{ name: 'serial-terminal.jsonl', label: 'Fixture serial', text }] : [] }) });
  const { session } = await h.service.start(args({ performance: true, serial: [{ workspace: 'terminal', sessionId: 'one' }] }));
  text = 'last issue before stopping';
  const before = h.calls.filter(call => call === 'performance').length;
  await h.service.stop({ id: session.id });
  assert.equal(h.calls.filter(call => call === 'performance').length, before);
  assert.match((await h.service.store.readTail(session.id, 'serial-terminal.jsonl')).text, /last issue before stopping/);
});

test('cleanup waits for pending validation and prevents any later capture start', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, { verifyDevice: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  const starting = h.service.start(args({ video: true, logs: true })); await ready;
  let done = false; const cleanup = h.service.cleanup().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  release(); const result = await starting; await cleanup;
  assert.equal(result.ok, false); assert.ok(!h.calls.includes('video:start')); assert.equal(h.service.hasActive(), false);
});

test('stop during video launch waits for the owned ID and never opens the next source', async t => {
  let release, entered, stops = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, { recording: {
    start: async () => { entered(); return new Promise(resolve => { release = () => resolve({ success: true, session: { id: 'late-owned', startedAt: 10000 } }); }); },
    stopOwned: async ({ id }) => { assert.equal(id, 'late-owned'); stops++; return { success: false, error: 'synthetic stop preserves remote' }; },
  } });
  const starting = h.service.start(args({ video: true, logs: true })); await ready;
  const stopping = h.service.stopCurrent(); release();
  await starting; await stopping;
  assert.equal(stops, 1); assert.ok(!h.calls.includes('log:start')); assert.equal(h.service.hasActive(), false);
});

test('real recording-log writer produces the exact manifest path used by preview and analysis', async t => {
  let actualPath;
  const h = await fixture(t, { startLog: async options => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', 0)); };
    const logger = await startRecordingLog(options, { spawnAdb: args => { assert.equal(args[2], 'logcat'); return child; } });
    actualPath = logger.info().path; child.stdout.write('synthetic real writer evidence\n'); return logger;
  } });
  const started = await h.service.start(args({ logs: true })); assert.equal(started.ok, true);
  const stopped = await h.service.stop({ id: started.session.id }); assert.equal(stopped.ok, true);
  const entry = stopped.session.files.find(item => item.name === 'device.log'); assert.ok(entry.bytes > 0);
  assert.equal(actualPath, await h.service.store.filePath(started.session.id, entry.name, true));
  assert.match((await h.service.store.readTail(started.session.id, entry.name)).text, /synthetic real writer evidence/);
});
