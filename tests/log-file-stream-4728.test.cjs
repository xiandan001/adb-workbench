const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { readLogFile, FILE_LIMITS } = require('../electron/lib/log-file-reader.cjs');
const { createLogFileImporter } = require('../electron/lib/log-file-importer.cjs');
const { parseLogLine } = require('../electron/lib/log-line-parser.cjs');
function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'veylo-log-file-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('veylo-log-file-')); fs.rmSync(root, { recursive: true, force: false }); });
  return path.join(root, 'fixture.log');
}
test('stream reader maintains count/UTF-8 budgets and omits one oversized line without retaining it', async t => {
  const file = temporary(t); fs.writeFileSync(file, 'before\n' + '中'.repeat(400000) + '\n中文😀\r\nafter\n');
  const progress = [], result = await readLogFile(file, { requestId: 'bounded', maxEntries: 2, maxBytes: 20, onProgress: state => progress.push(state) });
  assert.deepEqual(result.entries.map(entry => entry.raw), ['中文😀', 'after']);
  assert.equal(result.stats.omittedLines, 1); assert.equal(result.stats.omittedBytes, 1200000); assert.equal(result.stats.lineCount, 4);
  for (const state of progress) { assert.ok(state.keptCount <= 2); assert.ok(state.keptBytes <= 20); assert.ok(state.maxPendingBytes <= FILE_LIMITS.maxLineBytes); }
});
test('files changed during streaming fail rather than committing a misleading complete snapshot', async t => {
  const file = temporary(t); fs.writeFileSync(file, 'original\n'); let changed = false;
  await assert.rejects(readLogFile(file, { requestId: 'changed', onProgress: () => { if (!changed) { changed = true; fs.appendFileSync(file, 'late append\n'); } } }), /LOG_FILE_CHANGED/);
});
test('file unknown timestamps remain unknown while live rows record host receipt time', () => {
  assert.equal(parseLogLine('file', 'unstructured').ts, undefined);
  assert.equal(parseLogLine('file', 'unstructured').clockBasis, 'unknown');
  assert.equal(parseLogLine('file', '99-99 99:99:99.000 1 2 I A03200/Tag: invalid date').ts, undefined);
  const live = parseLogLine('realtime', 'unstructured', { receivedAt: 12345 }); assert.equal(live.ts, 12345); assert.equal(live.receivedAt, 12345); assert.equal(live.clockBasis, 'received');
  assert.equal(parseLogLine('file', '11-16 12:00:00.000 1 2 I Tag: original').clockBasis, 'device-local-year-unknown');
});
test('abort stops a real streaming reader before success without accumulating the rest of the file', async t => {
  const file = temporary(t); fs.writeFileSync(file, 'plain\n'.repeat(100000)); const controller = new AbortController();
  await assert.rejects(readLogFile(file, { requestId: 'aborted', signal: controller.signal,
    onProgress: state => { if (state.readBytes) controller.abort(); } }), error => error.name === 'AbortError');
});
test('cancelled, superseded and owner-lost import replies cannot replace the previous view', () => {
  const workers = [], commits = [], states = [];
  class FakeWorker extends EventEmitter { constructor() { super(); workers.push(this); } terminate() { return Promise.resolve(); } postMessage() {} }
  const importer = createLogFileImporter({ WorkerClass: FakeWorker, onCommit: rows => commits.push(rows), onState: state => states.push(state) });
  const owner = new EventEmitter(); owner.isDestroyed = () => false;
  const first = importer.start('/fixture/first.log', owner); assert.equal(importer.cancel(first.requestId, {}), false);
  assert.equal(importer.cancel(first.requestId, owner), true);
  workers[0].emit('message', { type: 'done', stats: { keptCount: 0, keptBytes: 0 } });
  importer.start('/fixture/second.log', owner); importer.start('/fixture/third.log', owner);
  workers[1].emit('message', { type: 'done', stats: { keptCount: 0, keptBytes: 0 } });
  owner.emit('destroyed'); workers[2].emit('message', { type: 'done', stats: { keptCount: 0, keptBytes: 0 } });
  assert.equal(commits.length, 0); assert.equal(states.at(-1).status, 'cancelled');
});
test('real worker streams 240k rows into a bounded 200k window while main heartbeat keeps running', async t => {
  const file = temporary(t); fs.writeFileSync(file, Array.from({ length: 240000 }, (_, i) => `11-16 12:00:00.000 1 2 I Tag: row-${i}`).join('\n'));
  let commit, finish, reject, beats = 0, previous = performance.now(), maxGap = 0;
  const completed = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++; }, 5);
  const start = performance.now(), importer = createLogFileImporter({ onCommit: rows => { commit = rows; }, onState: state => {
    assert.ok(state.keptCount <= 200000); assert.ok(state.keptBytes <= 100 * 1024 * 1024);
    if (state.status === 'completed') finish(state); if (state.status === 'failed') reject(Error(state.error));
  } });
  const timeout = setTimeout(() => { importer.cancelCurrent(); reject(Error('isolated worker deadline')); }, 30000);
  try {
    importer.start(file); const state = await completed;
    assert.equal(commit.length, 200000); assert.ok(commit[0].raw.endsWith('row-40000')); assert.equal(state.lineCount, 240000);
    assert.ok(beats > 3); assert.ok(maxGap < 1000);
    t.diagnostic(JSON.stringify({ rows: state.lineCount, retained: state.keptCount, bytes: state.keptBytes, ms: performance.now() - start, heartbeats: beats, maxHeartbeatGapMs: maxGap }));
  } finally { clearInterval(timer); clearTimeout(timeout); importer.cancelCurrent(); }
});
test('real worker enforces the default 100 MiB raw-byte window on a 120 MiB long-line file', async t => {
  const file = temporary(t), line = Buffer.alloc(1024 * 1024, 120); line[line.length - 1] = 10;
  const handle = fs.openSync(file, 'wx');
  try { for (let i = 0; i < 120; i++) fs.writeSync(handle, line); } finally { fs.closeSync(handle); }
  let finish, reject, rows, beats = 0, previous = performance.now(), maxGap = 0;
  const completed = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++; }, 5);
  const start = performance.now(), importer = createLogFileImporter({ onCommit: value => { rows = value; }, onState: state => {
    assert.ok(state.keptBytes <= 100 * 1024 * 1024); assert.ok(state.keptCount <= 200000);
    if (state.status === 'completed') finish(state); if (state.status === 'failed') reject(Error(state.error));
  } });
  const timeout = setTimeout(() => { importer.cancelCurrent(); reject(Error('isolated byte-bound worker deadline')); }, 30000);
  try {
    importer.start(file); const state = await completed;
    assert.equal(state.lineCount, 120); assert.equal(rows.length, 100); assert.equal(state.keptBytes, 100 * (1024 * 1024 - 1));
    assert.equal(state.truncated, true); assert.equal(state.omittedLines, 0); assert.ok(beats > 3); assert.ok(maxGap < 1000);
    t.diagnostic(JSON.stringify({ fileBytes: 120 * 1024 * 1024, retainedBytes: state.keptBytes, retainedRows: rows.length, ms: performance.now() - start,
      heartbeats: beats, maxHeartbeatGapMs: maxGap }));
  } finally { clearInterval(timer); clearTimeout(timeout); importer.cancelCurrent(); }
});
