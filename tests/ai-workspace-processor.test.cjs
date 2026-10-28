const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createWorkspaceProcessor, createWorkerReportStore } = require('../electron/lib/ai-workspace-processor.cjs');
const { createAsyncReportStore, atomicWriteAsync } = require('../electron/lib/ai-workspace-store-async.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-worker-'));
  const processor = createWorkspaceProcessor();
  t.after(async () => { await processor.dispose(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-ai-worker-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, processor };
}
async function report(processor) {
  const frozen = await processor.run('freeze', { sources: [{ kind: 'text', label: 'fixture', text: 'startup timeout fixture', capturedAt: 0 }], now: 0 });
  return { id: randomUUID(), kind: 'analysis', createdAt: new Date().toISOString(), preview: { id: randomUUID(), question: 'startup timeout', ...frozen },
    result: { summary: 'startup timeout fixture', findings: [{ title: 'fixture', detail: 'fixture', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: [], limitations: [] }, usage: null };
}
const review = () => ({ status: 'unverified', rootCause: '', solution: '', verification: '', packageName: 'com.example.fixture', version: '1.0', tags: ['startup'] });

test('real worker preserves 2000 large lines and main-thread heartbeat without trusting renderer device labels', async t => {
  const { processor } = fixture(t);
  const text = Array.from({ length: 2000 }, (_, i) => `10-28 10:00:00.000 123 456 E Fixture: ${i} ${'synthetic'.repeat(12)}`).join('\n');
  assert.ok(Buffer.byteLength(text) > 128 * 1024);
  let ticks = 0; const timer = setInterval(() => ticks++, 2); t.after(() => clearInterval(timer));
  const frozen = await processor.run('freeze', { sources: [{ kind: 'adb', label: 'fixture', target: 'fake-device', text, provenance: { trust: 'renderer-view', origin: 'fixture' } }], now: 1 });
  assert.equal(frozen.entries[0].lineCount, 2000); assert.equal(frozen.entries[0].truncated, false); assert.equal(frozen.entries[0].targetKey, null);
  assert.ok(ticks > 0, 'main thread must continue ticking during worker startup and processing');
  const request = await processor.run('request', { prompt: 'fixture', payload: { evidence: frozen.entries } });
  assert.deepEqual(JSON.parse(request.content).evidence, frozen.entries);
});

test('worker cancellation and bounded queue settle every request without cancelling a sibling', async t => {
  const { processor } = fixture(t); const abort = new AbortController();
  const pending = processor.run('freeze', { sources: [{ kind: 'text', label: 'one', text: 'fixture' }] }, { signal: abort.signal });
  const sibling = processor.run('freeze', { sources: [{ kind: 'text', label: 'two', text: 'fixture two' }] });
  abort.abort(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal((await sibling).entries[0].label, 'two');
  const requests = Array.from({ length: 8 }, () => processor.run('clone', { value: 'fixture' }));
  await assert.rejects(processor.run('clone', { value: 'overflow' }), { code: 'AI_WORKER_BUSY' });
  assert.equal((await Promise.all(requests)).length, 8);
});

test('async casebook snapshots survive original-history deletion, preserve review revisions and search locally', async t => {
  const { directory, processor } = fixture(t);
  const history = createWorkerReportStore({ directory: path.join(directory, 'history'), processor: processor.run });
  const cases = createWorkerReportStore({ directory: path.join(directory, 'cases'), casebook: true, processor: processor.run });
  const original = await report(processor), saved = await history.save(original, 'source');
  const item = await cases.save(await history.load(saved.id), 'verified later', review());
  await history.delete(saved.id);
  assert.equal((await cases.load(item.id)).preview.entries[0].text, '[L1] startup timeout fixture');
  await assert.rejects(cases.update(item.id, 1, { ...review(), status: 'verified' }), { code: 'AI_CASEBOOK_REVIEW' });
  const updated = await cases.update(item.id, 1, { ...review(), status: 'verified', verification: 'Explicit synthetic test passed', rootCause: 'startup fixture', solution: 'synthetic fix' });
  assert.equal(updated.revision, 2);
  const exported = await processor.run('reportText', { report: await cases.load(item.id) });
  assert.match(exported, /Explicit synthetic test passed/); assert.match(exported, /synthetic fix/);
  await assert.rejects(cases.update(item.id, 1, review()), { code: 'AI_CASEBOOK_CONFLICT' });
  assert.equal((await cases.list({ query: 'startup', status: 'verified' })).length, 1);
  const similar = await cases.similar(original, 5); assert.equal(similar[0].id, item.id); assert.ok(similar[0].matchTerms.length);
  await cases.delete(item.id); assert.deepEqual(await cases.list(), []);
});

test('async atomic writes preserve destinations on failure and cancelled writes create no report', async t => {
  const { directory } = fixture(t); const destination = path.join(directory, 'keep.txt'); fs.writeFileSync(destination, 'previous');
  const io = { ...fs.promises, rename: async () => { throw Object.assign(new Error('fixture failure'), { code: 'EACCES' }); } };
  await assert.rejects(atomicWriteAsync(destination, 'replacement', { io }), { code: 'EACCES' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous'); assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
  const flag = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(flag, 0, 1);
  await assert.rejects(atomicWriteAsync(path.join(directory, 'cancelled.txt'), 'never written', { flag }), { code: 'CANCELLED' });
  assert.equal(fs.existsSync(path.join(directory, 'cancelled.txt')), false);
});

test('async store rejects corrupt display metadata and traversal, and can delete corrupted report bodies', async t => {
  const { directory, processor } = fixture(t); const store = createAsyncReportStore({ directory, casebook: true });
  const original = await report(processor), saved = await store.save(original, 'fixture', review());
  const file = path.join(directory, `${saved.id}.json`), corrupt = JSON.parse(fs.readFileSync(file)); corrupt.preview.entries[0].label = { unsafe: true }; fs.writeFileSync(file, JSON.stringify(corrupt));
  await assert.rejects(store.load(saved.id), { code: 'AI_REPORT' }); await assert.rejects(store.load('../outside'), { code: 'AI_REPORT' });
  await store.delete(saved.id); assert.deepEqual(await store.list(), []);
});

test('worker crash settles all pending calls and a later explicit request starts a fresh worker', async t => {
  let worker;
  const processor = createWorkspaceProcessor({ workerFactory: filename => { worker = new Worker(filename); return worker; } });
  t.after(() => processor.dispose());
  const a = processor.run('clone', { value: 'first' }).catch(error => error);
  const b = processor.run('clone', { value: 'second' }).catch(error => error);
  await worker.terminate();
  assert.equal((await a).code, 'AI_WORKER_FAILED'); assert.equal((await b).code, 'AI_WORKER_FAILED');
  assert.equal(await processor.run('clone', { value: 'fresh' }), 'fresh');
});

test('cancelled queued requests retain their bounded slots until worker acknowledgement', async t => {
  const { processor } = fixture(t);
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map(signal => processor.run('clone', { value: 'fixture' }, { signal: signal.signal }).catch(error => error));
  controllers.forEach(controller => controller.abort());
  await assert.rejects(processor.run('clone', { value: 'cannot overflow cancellation queue' }), { code: 'AI_WORKER_BUSY' });
  assert.ok((await Promise.all(requests)).every(error => error.code === 'CANCELLED'));
});

test('near-budget multi-source evidence and report storage keep the main thread responsive', async t => {
  const { directory, processor } = fixture(t);
  const text = Array.from({ length: 2000 }, (_, i) => `${i} ${'x'.repeat(225)}`).join('\n');
  const sources = ['one', 'two'].map(label => ({ kind: 'text', label, text }));
  let ticks = 0, previous = performance.now(), maximumGap = 0;
  const timer = setInterval(() => { const current = performance.now(); maximumGap = Math.max(maximumGap, current - previous); previous = current; ticks++; }, 2); t.after(() => clearInterval(timer));
  const frozen = await processor.run('freeze', { sources, now: 1 });
  assert.ok(frozen.bytes > 900 * 1024); assert.ok(frozen.bytes <= 1024 * 1024);
  const value = { ...await report(processor), preview: { id: randomUUID(), question: 'large synthetic fixture', ...frozen } };
  const store = createWorkerReportStore({ directory, casebook: true, processor: processor.run });
  const before = ticks, saved = await store.save(value, 'large fixture', review());
  assert.equal((await store.load(saved.id)).preview.bytes, frozen.bytes); assert.ok(ticks > before);
  t.diagnostic(`Frozen evidence ${frozen.bytes} bytes; main heartbeat ${ticks} ticks; maximum observed gap ${maximumGap.toFixed(1)}ms`);
});

test('casebook capacity never evicts existing cases and symlink roots are rejected', async t => {
  const { directory, processor } = fixture(t); const casesDirectory = path.join(directory, 'cases');
  const store = createAsyncReportStore({ directory: casesDirectory, casebook: true });
  const value = await report(processor);
  for (let i = 0; i < 50; i++) await store.save(value, `fixture ${i}`, review());
  const before = (await store.list()).map(item => item.id);
  await assert.rejects(store.save(value, 'overflow', review()), { code: 'AI_CASEBOOK_LIMIT' });
  assert.deepEqual((await store.list()).map(item => item.id), before);
  const alias = path.join(directory, 'alias');
  try { fs.symlinkSync(casesDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink fixture unavailable in this environment'); return; } throw error; }
  await assert.rejects(createAsyncReportStore({ directory: alias, casebook: true }).list(), { code: 'AI_REPORT' });
});

test('failed async case revision commits roll back the report and its index together', async t => {
  const { directory, processor } = fixture(t); let denyIndex = false;
  const io = { ...fs.promises, rename: async (from, to) => {
    if (denyIndex && to === path.join(directory, 'index.json')) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
    return fs.promises.rename(from, to);
  } };
  const store = createAsyncReportStore({ directory, casebook: true, io });
  const value = await report(processor), saved = await store.save(value, 'keep previous', review());
  denyIndex = true;
  await assert.rejects(store.update(saved.id, 1, { ...review(), rootCause: 'new cause' }), { code: 'EACCES' });
  assert.equal((await store.load(saved.id)).revision, 1); assert.equal((await store.load(saved.id)).review.rootCause, '');
  assert.deepEqual(fs.readdirSync(directory).sort(), [`${saved.id}.json`, 'index.json'].sort());
});
