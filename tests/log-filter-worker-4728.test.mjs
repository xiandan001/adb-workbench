import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { filterEntries, countByLevel } from '../src/shared/filter.js';
const require = createRequire(import.meta.url);
const policy = require('../electron/lib/log-filter-policy.cjs');
const { queryLogEntries, createLogFilterClient } = require('../electron/lib/log-filter-client.cjs');
const rows = [
  { id: '1', raw: 'Crash Alpha', pkg: 'COM.Demo.One', tag: 'MainTag', pid: 12, level: 'E', domain: 'A0001' },
  { id: '2', raw: 'Crash Alpha ignored', processName: 'com.demo.two', tag: 'MainTag', pid: 13, level: 'W', domain: 'A0002' },
  { id: '3', raw: 'normal output', pkg: 'com.other', tag: 'Worker', pid: 12, level: 'I' },
  { id: '4', raw: 'CRASH Alpha' }
];
test('packaged CJS filter semantics match shared filters, including flags, missing fields, domain and numeric-only PID', () => {
  const filters = [{}, null, { text: 'crash', excludeText: 'IGNORED' }, { pkg: 'DEMO', tag: 'main', pid: 12, minLevel: 'W', text: 'alpha' },
    { minLevel: 'W' }, { pid: 12 }, { pid: '12' }, { domain: 'A0002' }, { regex: '^Crash', regexFlags: '' }, { regex: '[' }, { regex: 'Crash', regexFlags: 'invalid' },
    ...['g', 'y', 'gi', 'yi'].map(regexFlags => ({ regex: 'Crash', regexFlags }))];
  for (const filter of filters) assert.deepEqual(policy.filterEntries(rows, filter), filterEntries(rows, filter));
  assert.deepEqual(policy.countByLevel(rows), countByLevel(rows));
});
test('real worker preserves complete totals/levels and exact pagination or chronological tail references', async () => {
  const page = await queryLogEntries(rows, { text: 'alpha' }, { offset: 1, limit: 2 });
  assert.equal(page.total, 3); assert.equal(page.entries[0], rows[1]); assert.equal(page.entries[1], rows[3]);
  const tail = await queryLogEntries(rows, {}, { tail: true, limit: 2 }); assert.deepEqual(tail.entries, rows.slice(-2));
  const stats = await queryLogEntries(rows, {}, { limit: 0 }); assert.deepEqual(stats.entries, []); assert.deepEqual(stats.levels, countByLevel(rows)); assert.equal(stats.total, rows.length);
});
test('metadata-only worker query never reads raw log strings and a changed source array cannot retarget the snapshot', async () => {
  const entry = { id: 'meta', pkg: 'com.demo', level: 'E', get raw() { throw Error('raw must not be accessed'); } };
  assert.equal((await queryLogEntries([entry], { pkg: 'demo' }, { limit: 0 })).total, 1);
  const source = [...rows], pending = queryLogEntries(source, {}, { limit: 1 }); source.splice(0, source.length, { id: 'B', raw: 'new source' });
  assert.equal((await pending).entries[0], rows[0]);
});
test('dangerous regex terminates in a worker, cancellation rejects, and neither returns a false empty result', async t => {
  let beats = 0; const interval = setInterval(() => beats++, 5), start = performance.now();
  try {
    const client = createLogFilterClient({ deadlineMs: 100 });
    await assert.rejects(client.query([{ raw: 'a'.repeat(10000) + '!' }], { regex: '^(a+)+$' }), error => error.code === 'LOG_FILTER_TIMEOUT');
    assert.ok(beats >= 3); assert.ok(performance.now() - start < 5000);
    const controller = new AbortController(), pending = client.query(rows, {}, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, error => error.code === 'LOG_FILTER_CANCELLED');
    await assert.rejects(client.query(rows, { regex: '[' }), error => error.code === 'LOG_FILTER_INVALID_REGEX');
    t.diagnostic(JSON.stringify({ badRegexElapsedMs: performance.now() - start, mainHeartbeats: beats }));
  } finally { clearInterval(interval); }
});
test('200k-row explicit regex query streams acknowledged batches with bounded main heartbeat', async t => {
  const source = Array.from({ length: 200000 }, (_, index) => ({ id: String(index), raw: `row-${index}`, level: index % 2 ? 'I' : 'E' }));
  let beats = 0, previous = performance.now(), maxGap = 0;
  const interval = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++; }, 5), start = performance.now();
  try {
    const result = await queryLogEntries(source, { regex: '^row-' }, { limit: 5000, tail: true });
    assert.equal(result.total, 200000); assert.equal(result.entries.length, 5000); assert.equal(result.entries[0], source[195000]);
    assert.equal(result.levels.E, 100000); assert.equal(result.levels.I, 100000); assert.ok(beats > 3); assert.ok(maxGap < 1000);
    t.diagnostic(JSON.stringify({ rows: source.length, returned: result.entries.length, elapsedMs: performance.now() - start, mainHeartbeats: beats, maxHeartbeatGapMs: maxGap }));
  } finally { clearInterval(interval); }
});
test('busy tasks, output byte limits and owner loss reject explicitly without silently truncating results', async () => {
  class HeldWorker extends EventEmitter { terminate() { return Promise.resolve(); } }
  const client = createLogFilterClient({ WorkerClass: HeldWorker, maxTasks: 1 }), controller = new AbortController();
  const pending = client.query(rows, {}, { signal: controller.signal });
  await assert.rejects(client.query(rows, {}), error => error.code === 'LOG_FILTER_BUSY');
  controller.abort(); await assert.rejects(pending, error => error.code === 'LOG_FILTER_CANCELLED'); assert.equal(client.state().active, 0);
  const owner = new EventEmitter(); owner.isDestroyed = () => false;
  const owned = client.query(rows, {}, { owner }); owner.emit('destroyed'); await assert.rejects(owned, error => error.code === 'LOG_FILTER_CANCELLED');
  await assert.rejects(queryLogEntries(Array(20).fill({ raw: 'x'.repeat(1024 * 1024) }), {}, { limit: 20 }), error => error.code === 'LOG_FILTER_RESULT_LIMIT');
});
