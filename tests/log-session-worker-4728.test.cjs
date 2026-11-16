const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSessionStore, register, cleanup, prepareQuit, resumeAfterQuit } = require('../electron/lib/log-sessions.cjs');
const { runSessionJob } = require('../electron/lib/log-session-jobs.cjs');
const fixture = () => ({ name: 'Fixture', source: 'realtime', deviceId: 'A', buffers: ['main'], filter: {}, entries: [{ id: 'one', raw: 'HiLog 0d001 domain E original token=PRIVATE',
  platform: 'harmony', level: 'E', tag: 'Ui', clockBasis: 'received', receivedAt: 123456, timeKnown: true }], markers: [], evidence: [], aiTurns: [] });
function harness(t, chooseDestination, getProtectedPaths, getSourceIdentity, onRestore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-log-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map(); register({ handle: (key, fn) => handlers.set(key, fn) }, { getDirectory: () => path.join(directory, 'sessions'),
    restore: onRestore || (() => { throw Error('export/compare cannot restore'); }), chooseDestination, getProtectedPaths, getSourceIdentity });
  return { directory, invoke: (key, input) => handlers.get('logSession:' + key)({}, input), store: createSessionStore(path.join(directory, 'sessions')) };
}
test('real worker preserves new clock fields and compares current session IDs only', async t => {
  const h = harness(t), one = await h.store.save(fixture()), two = await h.store.save(fixture());
  const restored = await h.store.read(one.id); assert.equal(restored.entries[0].receivedAt, 123456); assert.equal(restored.entries[0].timeKnown, true);
  const comparison = await h.invoke('compare', { beforeId: one.id, afterId: two.id, requestId: randomUUID() });
  assert.equal(comparison.ok, true); assert.equal(comparison.comparison.groups[0].beforeFirst.basis, 'received');
  assert.equal((await h.invoke('compare', { beforeId: '../outside', afterId: two.id })).ok, false);
  assert.equal((await h.invoke('compare', { beforeId: one.id, afterId: two.id, path: 'untrusted' })).ok, false);
});
test('session load forwards an authoritative restore epoch without persisting it into schema one', async t => {
  const h = harness(t), saved = await h.store.save({ ...fixture(), sourceIdentity: 'renderer-forgery' }), handlers = new Map();
  register({ handle: (key, callback) => handlers.set(key, callback) }, { getDirectory: () => path.join(h.directory, 'sessions'), restore: () => ({ sourceIdentity: 'main-trusted-epoch' }) });
  const response = await handlers.get('logSession:load')({}, { id: saved.id });
  assert.equal(response.sourceIdentity, 'main-trusted-epoch'); assert.equal(Object.hasOwn(response.session, 'sourceIdentity'), false);
  assert.equal(fs.readFileSync(path.join(h.directory, 'sessions', saved.id + '.json'), 'utf8').includes('sourceIdentity'), false);
});
test('load freezes the main epoch at IPC receipt, not when a queued restore eventually starts', async t => {
  let identity = 'A', finish, restored = 0;
  const h = harness(t, () => new Promise(resolve => { finish = resolve; }), undefined, () => identity, () => { restored++; return { sourceIdentity: 'C' }; });
  const saved = await h.store.save(fixture());
  const chooser = h.invoke('export', { requestId: randomUUID(), scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const loading = h.invoke('load', { id: saved.id, expectedSourceIdentity: 'A' }); identity = 'B'; finish({ canceled: true }); await chooser;
  assert.equal((await loading).ok, false); assert.equal(restored, 0);
});
test('source replacement during an actual session read cannot restore over the newer source', async t => {
  let identity = 'A', finish, entered = false, restored = 0;
  const h = harness(t, undefined, undefined, () => identity, () => { restored++; return { sourceIdentity: 'C' }; });
  const saved = await h.store.save(fixture()), target = path.join(h.directory, 'sessions', saved.id + '.json'), original = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async function (file, ...args) {
    if (String(file) === target) { entered = true; await new Promise(resolve => { finish = resolve; }); }
    return original.call(this, file, ...args);
  });
  const loading = h.invoke('load', { id: saved.id, expectedSourceIdentity: 'A' }); while (!entered) await new Promise(resolve => setImmediate(resolve));
  identity = 'B'; finish(); assert.equal((await loading).ok, false); assert.equal(restored, 0);
});
test('session time metadata is exact and legacy sessions default to all without restoring a stale clock anchor', async t => {
  const h = harness(t), { normalizeSessionTimeRange } = require('../electron/lib/log-sessions.cjs');
  assert.deepEqual(normalizeSessionTimeRange(), { kind: 'all' });
  for (const timeRange of [{ kind: 'all' }, { kind: 'recent', durationMs: 30000, basis: 'received' }, { kind: 'around', entryId: 'one', windowMs: 5000, basis: 'source' }]) {
    const saved = await h.store.save({ ...fixture(), timeRange }); assert.deepEqual((await h.store.read(saved.id)).timeRange, timeRange);
  }
  for (const invalid of [{ kind: 'all', command: 'bad' }, { kind: 'recent', durationMs: 42, basis: 'source' }, { kind: 'around', entryId: '\n', windowMs: 5000, basis: 'received' }]) assert.throws(() => normalizeSessionTimeRange(invalid));
});
test('raw export writes original HiLog lines atomically and invalid exports leave a previous destination intact', async t => {
  let destination;
  const h = harness(t, async () => ({ filePath: destination })); destination = path.join(h.directory, 'original.log');
  const input = { requestId: randomUUID(), scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() };
  fs.writeFileSync(destination, 'previous');
  const result = await h.invoke('export', input); assert.equal(result.ok, true); assert.equal(fs.readFileSync(destination, 'utf8'), fixture().entries[0].raw + '\n');
  const original = fs.readFileSync(destination);
  const failed = await h.invoke('export', { ...input, requestId: randomUUID(), snapshot: { ...fixture(), entries: [{ id: 'missing raw' }] } });
  assert.equal(failed.ok, false); assert.deepEqual(fs.readFileSync(destination), original);
  assert.equal((await h.invoke('export', { ...input, requestId: randomUUID(), destination: 'renderer path' })).ok, false);
});
test('cancel bypasses the operation queue while destination choice is pending and forbids a late write', async t => {
  let finish;
  const h = harness(t, () => new Promise(resolve => { finish = resolve; }));
  const requestId = randomUUID(), destination = path.join(h.directory, 'cancelled.log');
  const pending = h.invoke('export', { requestId, scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.invoke('cancel', { requestId })).ok, true);
  finish({ filePath: destination }); assert.equal((await pending).cancelled, true); assert.equal(fs.existsSync(destination), false);
});
test('trusted original paths are frozen before the chooser and rechecked after a source change', async t => {
  let finish, paths = [];
  const h = harness(t, () => new Promise(resolve => { finish = resolve; }), () => paths);
  const old = path.join(h.directory, 'old.log'), next = path.join(h.directory, 'new.log'); fs.writeFileSync(old, 'old source'); fs.writeFileSync(next, 'new source');
  paths = [old];
  const start = () => h.invoke('export', { requestId: randomUUID(), scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() });
  const original = start(); while (!finish) await new Promise(resolve => setImmediate(resolve)); paths = [next]; finish({ filePath: old });
  assert.equal((await original).ok, false); assert.equal(fs.readFileSync(old, 'utf8'), 'old source');
  finish = null; paths = [old]; const changed = start(); while (!finish) await new Promise(resolve => setImmediate(resolve)); paths = [next]; finish({ filePath: next });
  assert.equal((await changed).ok, false); assert.equal(fs.readFileSync(next, 'utf8'), 'new source');
});
test('IPC rejects another window or subframe and owner destruction fences a delayed export', async t => {
  const h = harness(t), sourcePath = path.join(__dirname, '../electron/lib/log-sessions.cjs');
  const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const owner = new EventEmitter(); owner.mainFrame = {}; owner.isDestroyed = () => false;
  const handlers = new Map(), localModule = { exports: {} }; let finish, dialogs = 0;
  require('node:vm').runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { module: localModule, exports: localModule.exports, Buffer, AbortController,
    require: name => name === './app-context.cjs' ? { getLogAnalyzerWindow: () => ({ isDestroyed: () => false, webContents: owner }) } : createRequire(sourcePath)(name) });
  localModule.exports.register({ handle: (key, fn) => handlers.set(key, fn) }, { getDirectory: () => path.join(h.directory, 'sessions'), restore() {},
    chooseDestination: () => { dialogs++; return new Promise(resolve => { finish = resolve; }); } });
  const requestId = randomUUID(), args = { requestId, scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  assert.equal((await handlers.get('logSession:export')({ sender: new EventEmitter(), senderFrame: {} }, args)).ok, false);
  assert.equal((await handlers.get('logSession:export')({ sender: owner, senderFrame: {} }, args)).ok, false); assert.equal(dialogs, 0);
  const exporting = handlers.get('logSession:export')(event, args); while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await handlers.get('logSession:cancel')({ sender: owner, senderFrame: {} }, { requestId })).ok, false);
  owner.emit('destroyed'); const destination = path.join(h.directory, 'owner-gone.log'); finish({ filePath: destination });
  assert.equal((await exporting).cancelled, true); assert.equal(fs.existsSync(destination), false);
});
test('sharing preview uses the real worker redaction and leaves original snapshot unchanged', async t => {
  const h = harness(t), original = fixture(), before = structuredClone(original);
  const result = await h.invoke('exportPreview', { requestId: randomUUID(), scope: 'issue', format: 'bundle', redact: true, includeAi: false, snapshot: original });
  assert.equal(result.ok, true); assert.equal(result.preview.redacted, true); assert.doesNotMatch(result.preview.lines.join('\n'), /PRIVATE/); assert.deepEqual(original, before);
});
test('problem ZIP reuses the archive facility and contains declared redacted evidence without changing the saved source', async t => {
  let destination;
  const h = harness(t, async () => ({ filePath: destination })); destination = path.join(h.directory, 'shared.zip');
  const source = { ...fixture(), name: 'token=PRIVATE' }, saved = await h.store.save(source), original = fs.readFileSync(path.join(h.directory, 'sessions', saved.id + '.json'));
  const result = await h.invoke('export', { requestId: randomUUID(), scope: 'issue', format: 'bundle', redact: true, includeAi: false, snapshot: source });
  assert.equal(result.ok, true);
  const quote = destination.replace(/'/g, "''");
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${quote}'); try {$d=@{}; foreach($e in $z.Entries){$r=[IO.StreamReader]::new($e.Open()); try{$d[$e.FullName.Replace([char]92,[char]47)]=$r.ReadToEnd()}finally{$r.Dispose()}}; $d|ConvertTo-Json -Compress}finally{$z.Dispose()}`;
  const files = JSON.parse(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(Object.keys(files).sort(), ['evidence/logs.log', 'evidence/manifest.json', 'evidence/markers.json', 'manifest.json']);
  assert.doesNotMatch(files['evidence/logs.log'], /PRIVATE/); assert.equal(JSON.parse(files['evidence/manifest.json']).redacted, true);
  assert.doesNotMatch(files['manifest.json'], /PRIVATE/);
  assert.deepEqual(fs.readFileSync(path.join(h.directory, 'sessions', saved.id + '.json')), original);
});
async function waitForZipStage(directory) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const name of fs.readdirSync(directory).filter(name => name.startsWith('.veylo-log-export-'))) {
      const root = path.join(directory, name);
      for (const nested of fs.readdirSync(root).filter(name => name.startsWith('adb-workbench-evidence-'))) {
        if (fs.existsSync(path.join(root, nested, 'evidence.zip'))) return root;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('ZIP subprocess did not enter its file-writing stage');
}
function largeExportFixture() {
  const input = fixture(); input.entries = Array.from({ length: 20000 }, (_, index) => ({ id: String(index), raw: require('node:crypto').randomBytes(256).toString('base64') }));
  return input;
}
test('cancelling an actual active native ZIP waits for child cleanup and leaves no private raw staging copies', async t => {
  let destination;
  const h = harness(t, async () => ({ filePath: destination })); destination = path.join(h.directory, 'cancelled.zip'); fs.writeFileSync(destination, 'previous');
  const requestId = randomUUID();
  const exporting = h.invoke('export', { requestId, scope: 'loaded', format: 'bundle', redact: true, includeAi: false, snapshot: largeExportFixture() });
  await waitForZipStage(h.directory);
  assert.equal((await h.invoke('cancel', { requestId })).ok, true);
  const result = await exporting; assert.equal(result.cancelled, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(h.directory).filter(name => name.startsWith('.veylo-log-export-')), []);
  await cleanup();
  assert.equal((await h.invoke('list')).ok, true, 'Cleanup is reusable, not a permanent disposal');
});
test('application cleanup aborts a live ZIP and waits for owned staging cleanup before returning', async t => {
  let destination;
  const h = harness(t, async () => ({ filePath: destination })); destination = path.join(h.directory, 'quitting.zip');
  const exporting = h.invoke('export', { requestId: randomUUID(), scope: 'loaded', format: 'bundle', redact: true, includeAi: false, snapshot: largeExportFixture() });
  await waitForZipStage(h.directory);
  const closing = cleanup(); assert.equal((await h.invoke('save', fixture())).cancelled, true, 'No fresh file operation can race the cleanup fence'); await closing;
  assert.equal((await exporting).cancelled, true); assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(h.directory).filter(name => name.startsWith('.veylo-log-export-')), []);
});
test('cleanup rejects an unremovable private staging file and a later retry recovers without disabling the service', async t => {
  let destination;
  const h = harness(t, async () => ({ filePath: destination })); destination = path.join(h.directory, 'cleanup-failure.log');
  const original = fs.promises.rm; let fail = true;
  t.mock.method(fs.promises, 'rm', async function (file, options) {
    if (fail && path.basename(String(file)).startsWith('.veylo-log-export-')) throw Object.assign(Error('fixture locked'), { code: 'EPERM' });
    return original.call(this, file, options);
  });
  const response = await h.invoke('export', { requestId: randomUUID(), scope: 'loaded', format: 'raw', redact: false, includeAi: false, snapshot: fixture() });
  assert.equal(response.ok, false); await assert.rejects(cleanup(), /清理失败/);
  fail = false; await cleanup(); assert.equal((await h.invoke('list')).ok, true);
  assert.deepEqual(fs.readdirSync(h.directory).filter(name => name.startsWith('.veylo-log-export-')), []);
});
test('prepareQuit holds a reversible gate beyond cleanup so READY waiting cannot accept fresh session work', async t => {
  const h = harness(t); t.after(resumeAfterQuit);
  const preparing = prepareQuit(); assert.equal((await h.invoke('save', fixture())).cancelled, true);
  await preparing; assert.equal((await h.invoke('list')).cancelled, true);
  resumeAfterQuit(); assert.equal((await h.invoke('list')).ok, true);
  const saved = await h.invoke('save', fixture()); assert.equal(saved.ok, true);
});
test('50,000-row JSON work runs off the main event loop and cancellation releases a queued job', async t => {
  const h = harness(t), input = fixture(); input.entries = Array.from({ length: 50000 }, (_, i) => ({ id: String(i), raw: `${i} HiLog E Ui failure ` + 'x'.repeat(160), level: 'E', tag: 'Ui', clockBasis: 'unknown' }));
  let beats = 0, last = performance.now(), maximumPause = 0;
  const timer = setInterval(() => { const now = performance.now(); maximumPause = Math.max(maximumPause, now - last); last = now; beats++; }, 10);
  const start = performance.now(); let saved;
  try { saved = await h.store.save(input); } finally { clearInterval(timer); }
  assert.equal(saved.entryCount, 50000); assert.ok(beats > 1);
  const elapsed = performance.now() - start, bytes = fs.statSync(path.join(h.directory, 'sessions', saved.id + '.json')).size;
  t.diagnostic(JSON.stringify({ rows: 50000, bytes, elapsedMs: Math.round(elapsed), heartbeatCount: beats, maximumPauseMs: Math.round(maximumPause) }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runSessionJob('encode', {}, { signal: controller.signal }), /取消/);
});
