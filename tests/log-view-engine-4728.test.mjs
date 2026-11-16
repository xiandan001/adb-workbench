import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { applyLogRowFilter, createLogViewIndex, logEntryTimestamp } from '../src/shared/logWorkbenchModel.js';
import { createLogViewController } from '../src/shared/logViewClient.js';

const row = (id, raw = 'test', extra = {}) => ({ id, raw, message: raw, level: 'I', ...extra });
test('row chip actions preserve other conditions and remove only the exact requested value', () => {
  const previous = { pkg: 'com.old', tag: 'Network', text: 'timeout' };
  const selected = applyLogRowFilter(previous, { field: 'pkg', value: 'com.app', mode: 'include' });
  assert.deepEqual(selected, { pkg: 'com.app', tag: 'Network', text: 'timeout' }); assert.equal(previous.pkg, 'com.old');
  assert.deepEqual(applyLogRowFilter(selected, { field: 'pkg', value: 'com.old', mode: 'remove' }), selected);
  assert.deepEqual(applyLogRowFilter(selected, { field: 'pkg', value: 'com.app', mode: 'remove' }), { tag: 'Network', text: 'timeout' });
  assert.equal(applyLogRowFilter({}, { field: 'pid', value: 37, mode: 'include' }).pid, 37);
  assert.throws(() => applyLogRowFilter({}, { field: 'command', value: 'reboot', mode: 'include' }));
});
test('source/received/unknown time bases never substitute a host timestamp for unknown source time', () => {
  assert.equal(logEntryTimestamp(row('a', '', { ts: 123, receivedAt: 456, clockBasis: 'received' }), 'source').value, null);
  assert.equal(logEntryTimestamp(row('a', '', { ts: 123, receivedAt: 456, clockBasis: 'received' }), 'received').value, 456);
  assert.equal(logEntryTimestamp(row('a', '', { ts: 123, clockBasis: 'device-local-year-unknown' }), 'source').reliableDate, false);
  const index = createLogViewIndex(); index.sync({ upsertRows: [row('old', '', { ts: 1, clockBasis: 'source-local' }), row('new', '', { ts: 50000, clockBasis: 'source-local' }), row('unknown', '', { ts: 50001, clockBasis: 'received' })] });
  const result = index.query({ filter: {}, timeRange: { kind: 'recent', durationMs: 30000, basis: 'source' } });
  assert.deepEqual(result.ids, ['new']); assert.equal(result.unknownTimeCount, 1);
});
test('incremental index supports random unsorted IDs, eviction and independent global regex matching', () => {
  const index = createLogViewIndex(); index.sync({ upsertRows: [row('z', 'match'), row(7, 'match'), row('a', 'other')] });
  assert.deepEqual(index.query({ filter: { regex: 'match', regexFlags: 'g' } }).ids, ['z', 7]);
  index.sync({ removedIds: ['z'], upsertRows: [row('q', 'match')] });
  assert.deepEqual(index.query({ filter: {} }).ids, [7, 'a', 'q']); assert.equal(index.size, 3);
});
test('local issue signatures group real repeats and preserve raw context without claiming a cause', () => {
  const first = row('x', 'Socket failed code 404', { level: 'E', ts: 1000, clockBasis: 'source-local', tag: 'Socket', pkg: 'com.app' });
  const second = row('y', 'Socket failed code 404', { ...first, id: 'y', ts: 2000 });
  const different = row('z', 'Socket failed code 500', { level: 'E', tag: 'Socket', pkg: 'com.app' });
  const index = createLogViewIndex(); index.sync({ upsertRows: [first, second, different] }); const result = index.query({ filter: {} });
  assert.equal(result.issues.length, 2); assert.equal(result.issues[0].count, 2); assert.equal(result.issues[0].firstTime, 1000); assert.equal(result.issues[0].lastTime, 2000);
  assert.deepEqual(result.issues[0].contextIds, ['x', 'y', 'z']); assert.equal(first.raw, 'Socket failed code 404');
  assert.equal(Object.hasOwn(result.issues[0], 'rootCause'), false);
});
test('time around a random ID uses the explicitly chosen clock and issue groups are bounded', () => {
  const rows = Array.from({ length: 160 }, (_, i) => row('id-' + (160 - i), 'different error ' + i, { level: 'E', receivedAt: i * 1000, clockBasis: 'received' }));
  const index = createLogViewIndex(); index.sync({ upsertRows: rows });
  const all = index.query({ filter: {} }); assert.equal(all.issues.length, 100); assert.equal(all.ungroupedIssueCount, 60);
  const around = index.query({ filter: {}, timeRange: { kind: 'around', entryId: 'id-150', windowMs: 1000, basis: 'received' } }); assert.deepEqual(around.ids, ['id-151', 'id-150', 'id-149']);
});
test('enabled rules group original W/I rows with rule identity; disabled rules cannot revive a match', () => {
  const rules = [{ id: 'custom', type: 'custom-warning', label: 'Custom clue', enabled: true, pattern: 'timeout code 37', flags: 'g', keywords: ['timeout'] }];
  const index = createLogViewIndex(); index.sync({ upsertRows: [row('a', 'timeout code 37', { level: 'W' }), row('b', 'timeout code 37', { level: 'W' })] });
  const result = index.query({ rules }); assert.equal(result.issues[0].count, 2); assert.equal(result.issues[0].ruleId, 'custom');
  assert.equal(index.query({ rules: [{ ...rules[0], enabled: false }] }).issues.length, 0);
  assert.throws(() => index.query({ rules: [{ ...rules[0], pattern: '[' }] }), { code: 'RULE_INVALID' });
});
test('view index continuously enforces row and byte budgets without rewriting retained evidence', () => {
  const index = createLogViewIndex({ limit: 3, maxBytes: 10 });
  index.sync({ upsertRows: [row('a', '1234'), row('b', '5678'), row('c', '90ab')] });
  assert.ok(index.bytes <= 10); assert.deepEqual(index.query({}).ids, ['b', 'c']);
  index.sync({ upsertRows: [row('d', 'cd'), row('e', 'ef')] }); assert.ok(index.size <= 3); assert.ok(index.bytes <= 10);
});
test('oversized worker rows do not evict earlier valid evidence and are disclosed as omitted', () => {
  const index = createLogViewIndex({ limit: 3, maxBytes: 10 });
  index.sync({ upsertRows: [row('valid', '1234'), row('oversized', 'x'.repeat(11)), row('new', '5678')] });
  const result = index.query({}); assert.deepEqual(result.ids, ['valid', 'new']); assert.equal(result.omittedRows, 1); assert.equal(index.bytes, 8);
});
test('unchanged rows reuse their worker predicate/rule index across bursts without merging different hex codes', () => {
  const index = createLogViewIndex(), first = row('a', 'error 0x04', { level: 'E' }), second = row('b', 'error 0x05', { level: 'E' });
  index.sync({ upsertRows: [first, second] }); assert.equal(index.query({ filter: { text: 'error' } }).evaluatedRows, 2);
  const again = index.query({ filter: { text: 'error' } }); assert.equal(again.evaluatedRows, 0); assert.equal(again.issues.length, 2);
  index.sync({ removedIds: ['a'], upsertRows: [row('c', 'error 0x05', { level: 'E' })] });
  const next = index.query({ filter: { text: 'error' } }); assert.equal(next.evaluatedRows, 1); assert.equal(next.issues[0].count, 2);
});

function fakeWorkers() {
  const workers = [];
  return { workers, createWorker() { const worker = { messages: [], terminated: false, postMessage(message) { this.messages.push(message); }, terminate() { this.terminated = true; }, reply(result) { this.onmessage?.({ data: result }); } }; workers.push(worker); return worker; } };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('client and worker agree on the same 100 MiB full snapshot for 128 legal 1 MiB records', () => {
  const f = fakeWorkers(), client = createLogViewController({ createWorker: () => f.createWorker() });
  const raw = 'x'.repeat(1024 * 1024), rows = Array.from({ length: 128 }, (_, id) => row(id, raw));
  try {
    client.update({ entries: rows, filter: {}, scopeKey: 'long-lines' });
    const worker = f.workers[0], sync = worker.messages.find(message => message.type === 'sync'), query = worker.messages.find(message => message.type === 'query');
    assert.equal(sync.upsertRows.length, 100); assert.equal(sync.upsertRows[0].id, 28);
    const index = createLogViewIndex(); index.sync(sync); worker.reply({ ...query, type: 'result', result: index.query({}) });
    const state = client.getSnapshot(); assert.equal(state.windowRows.length, 100); assert.equal(state.rows.length, 100); assert.equal(state.omittedRows, 28);
    assert.equal(state.windowRows.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.raw), 0), 100 * 1024 * 1024);
    assert.equal(rows.length, 128, 'The external original source is not rewritten');
  } finally { client.dispose(); }
});
test('client sends only incremental raw rows, fences stale queries and scope changes, and freezes paused rows', () => {
  const f = fakeWorkers(), client = createLogViewController({ createWorker: () => f.createWorker() });
  const first = [row('z'), row('a')]; client.update({ entries: first, filter: {}, scopeKey: 'capture-A' });
  assert.equal(client.getSnapshot().selectionPending, true);
  const worker = f.workers[0], query = worker.messages.find(message => message.type === 'query');
  worker.reply({ ...query, type: 'result', result: { ids: ['z', 'a'], counts: { I: 2 }, issues: [], total: 2 } });
  assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['z', 'a']);
  assert.equal(client.getSnapshot().selectionPending, false);
  assert.equal(client.isSelectionCurrent({ filter: { text: 'different' }, scopeKey: 'capture-A' }), false, 'A render can block a new query before the effect dispatch');
  assert.equal(client.isSelectionCurrent({ filter: {}, scopeKey: 'another-source' }), false);
  client.update({ entries: [...first, row('q')], filter: {}, scopeKey: 'capture-A' });
  assert.equal(client.getSnapshot().pending, true); assert.equal(client.getSnapshot().selectionPending, false, 'Live additions do not disable actions on the visible frozen selection');
  assert.equal(worker.messages.filter(message => message.type === 'sync').at(-1).upsertRows.length, 1);
  const late = worker.messages.filter(message => message.type === 'query').at(-1), oldCallback = worker.onmessage;
  client.update({ entries: [...first, row('q')], filter: {}, scopeKey: 'capture-A', paused: true });
  assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['z', 'a']);
  client.update({ entries: [...first, row('q'), row('new')], filter: {}, scopeKey: 'capture-A', paused: true }); assert.ok(client.getSnapshot().pendingCount >= 1);
  client.update({ entries: [row('different')], filter: {}, scopeKey: 'file-B' });
  oldCallback({ data: { ...late, type: 'result', result: { ids: ['q'], counts: {}, issues: [], total: 3 } } });
  assert.equal(client.getSnapshot().rows.some(item => item.id === 'q'), false); assert.equal(worker.terminated, true); client.dispose();
});
test('regex watchdog terminates its owned worker and preserves a successful visible snapshot', async () => {
  const f = fakeWorkers(), client = createLogViewController({ createWorker: () => f.createWorker(), timeoutMs: 30 });
  client.update({ entries: [row('safe', 'aaaa!')], filter: {}, scopeKey: 'A' }); const worker = f.workers[0], query = worker.messages.find(message => message.type === 'query');
  worker.reply({ ...query, type: 'result', result: { ids: ['safe'], counts: { I: 1 }, issues: [], total: 1 } });
  client.update({ entries: [row('safe', 'aaaa!')], filter: { regex: '^(a+)+$' }, scopeKey: 'A' }); await pause(60);
  assert.equal(f.workers.at(-1).terminated, true); assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['safe']); assert.ok(client.getSnapshot().error);
  const total = f.workers.length; client.update({ entries: [row('safe', 'aaaa!'), row('extra')], filter: { regex: '^(a+)+$' }, scopeKey: 'A' });
  assert.equal(f.workers.length, total, 'Live batches must not silently restart the same failing regex'); client.dispose();
});
test('without Worker, regex fails closed rather than executing on the UI thread', async () => {
  const client = createLogViewController({ createWorker: () => null });
  client.update({ entries: [row('danger', 'a'.repeat(5000) + '!')], filter: { regex: '^(a+)+$' }, scopeKey: 'A' }); await pause(10);
  assert.ok(client.getSnapshot().error); assert.equal(client.getSnapshot().pending, false); client.dispose();
});
test('without Worker, enabled rule regex also fails closed', async () => {
  const client = createLogViewController({ createWorker: () => null }); client.update({ entries: [row('a', 'aaaa!')], filter: {}, rules: [{ id: 'bad', pattern: '^(a+)+$', enabled: true }], scopeKey: 'A' });
  await pause(10); assert.equal(client.getSnapshot().errorCode, 'WORKER_REQUIRED'); client.dispose();
});

test('plain fallback is chunked and a disposed strict-effect instance can activate again', async () => {
  const client = createLogViewController({ createWorker: () => null });
  client.update({ entries: [row('x', 'selected')], filter: { text: 'selected' }, scopeKey: 'A' }); await pause(20);
  assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['x']); client.dispose(); client.activate();
  client.update({ entries: [row('y', 'next')], filter: {}, scopeKey: 'A' }); await pause(20);
  assert.deepEqual(client.getSnapshot().windowRows.map(item => item.id), ['y']); client.dispose();
});

function realWorkers() {
  const sent = [], workers = [];
  return { sent, workers, createWorker() {
    const entry = new URL('../src/workers/log-view-worker.js', import.meta.url).href;
    const native = new Worker(`const {parentPort}=require('node:worker_threads');let ready=false;const pending=[];globalThis.postMessage=value=>parentPort.postMessage(value);parentPort.on('message',data=>ready?globalThis.onmessage({data}):pending.push(data));import(${JSON.stringify(entry)}).then(()=>{ready=true;for(const data of pending)globalThis.onmessage({data});});`, { eval: true });
    const adapter = { terminated: false, postMessage(message) { sent.push({ type: message.type, reset: message.reset, count: message.upsertRows?.length || 0 }); native.postMessage(message); }, terminate() { this.terminated = true; void native.terminate(); } };
    native.on('message', data => adapter.onmessage?.({ data })); native.on('error', error => adapter.onerror?.(error)); workers.push(adapter); return adapter;
  } };
}
async function waitFor(predicate, milliseconds = 4000) {
  const started = performance.now(); while (!predicate()) { if (performance.now() - started > milliseconds) assert.fail('View worker fixture timed out'); await pause(5); }
}
test('actual worker retains 50k and sends only 100 new raw rows per burst without blocking heartbeat', async t => {
  const f = realWorkers(), client = createLogViewController({ createWorker: () => f.createWorker() }); t.after(() => client.dispose());
  let rows = Array.from({ length: 50000 }, (_, i) => row('random-' + ((i * 7919) % 50021), 'normal-' + i + ' raw evidence '.repeat(6), { receivedAt: i, clockBasis: 'received' }));
  const started = performance.now(); client.update({ entries: rows, filter: {}, scopeKey: 'burst' }); await waitFor(() => !client.getSnapshot().pending);
  assert.equal(client.getSnapshot().rows.length, 50000); const initialMs = performance.now() - started;
  let lastBeat = performance.now(), maxHeartbeatGapMs = 0;
  const heartbeat = setInterval(() => { const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastBeat); lastBeat = now; }, 10);
  const latencies = [];
  try { for (let batch = 0; batch < 12; batch++) {
    const incoming = Array.from({ length: 100 }, (_, i) => row(`burst-${batch}-${i}`, 'next raw evidence '.repeat(6)));
    rows = rows.slice(100).concat(incoming); const before = performance.now(); client.update({ entries: rows, filter: {}, scopeKey: 'burst' });
    await waitFor(() => !client.getSnapshot().pending); latencies.push(performance.now() - before); await pause(10);
  } } finally { clearInterval(heartbeat); }
  const syncs = f.sent.filter(message => message.type === 'sync');
  assert.equal(syncs[0].count, 50000); assert.ok(syncs.slice(1).every(message => message.count === 100 && !message.reset));
  assert.equal(client.getSnapshot().windowRows.length, 50000); assert.equal(client.getSnapshot().rows.length, 50000); assert.ok(maxHeartbeatGapMs < 500, 'No catastrophic regex/filter work on UI heartbeat');
  t.diagnostic(JSON.stringify({ rows: 50000, batches: 12, addedRawRows: syncs.slice(1).reduce((sum, item) => sum + item.count, 0), initialMs: Math.round(initialMs), maxBurstMs: Math.round(Math.max(...latencies)), maxHeartbeatGapMs: Math.round(maxHeartbeatGapMs) }));
});
test('actual catastrophic regex is cancelled or timed out in an owned worker, never the UI thread', async t => {
  const f = realWorkers(), client = createLogViewController({ createWorker: () => f.createWorker(), timeoutMs: 180 }); t.after(() => client.dispose());
  const rows = [row('safe', 'normal'), row('danger', 'a'.repeat(16000) + '!')];
  client.update({ entries: rows, filter: {}, scopeKey: 'regex' }); await waitFor(() => !client.getSnapshot().pending);
  let beats = 0; const heartbeat = setInterval(() => beats++, 5), started = performance.now();
  try {
    client.update({ entries: rows, filter: { regex: '^(a+)+$' }, scopeKey: 'regex' }); await pause(30); const cancelAt = performance.now(); client.cancel();
    assert.ok(performance.now() - cancelAt < 100); assert.equal(client.getSnapshot().errorCode, 'QUERY_CANCELLED');
    client.retry(); await waitFor(() => client.getSnapshot().errorCode === 'QUERY_TIMEOUT');
    assert.equal(f.workers.at(-1).terminated, true); assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['safe', 'danger']); assert.ok(beats > 5);
    t.diagnostic(JSON.stringify({ regexTimeoutMs: 180, observedMs: Math.round(performance.now() - started), heartbeatTicks: beats, terminatedWorkers: f.workers.filter(item => item.terminated).length }));
  } finally { clearInterval(heartbeat); }
});
test('actual custom-rule catastrophe terminates with a rule-specific error and cannot auto-loop on bursts', async t => {
  const f = realWorkers(), client = createLogViewController({ createWorker: () => f.createWorker(), timeoutMs: 180 }); t.after(() => client.dispose());
  const rows = [row('bad', 'a'.repeat(16000) + '!')], rules = [{ id: 'bad-rule', pattern: '^(a+)+$', enabled: true }];
  client.update({ entries: rows, filter: {}, scopeKey: 'rules' }); await waitFor(() => !client.getSnapshot().pending);
  client.update({ entries: rows, filter: {}, rules, scopeKey: 'rules' }); await waitFor(() => client.getSnapshot().errorCode === 'RULE_TIMEOUT');
  const count = f.workers.length; client.update({ entries: rows.concat(row('more')), filter: {}, rules, scopeKey: 'rules' });
  assert.equal(f.workers.length, count); assert.deepEqual(client.getSnapshot().rows.map(item => item.id), ['bad']);
});
