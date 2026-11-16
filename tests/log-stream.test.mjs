import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLogWindow, createLogBatchBuffer, LOG_VIEW_LIMIT } from '../src/shared/logStream.js';
import * as stream from '../src/shared/logStream.js';

function fixture(options = {}) {
  const timers = new Map();
  const results = [];
  let nextId = 0;
  const buffer = createLogBatchBuffer(batch => results.push(batch), {
    schedule(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    cancel(id) { timers.delete(id); },
    ...options
  });
  return { buffer, results, timers, tick() { for (const { callback } of [...timers.values()]) callback(); } };
}

test('display append retains exactly the newest 50k even for one oversized batch', () => {
  const incoming = Array.from({ length: LOG_VIEW_LIMIT + 123 }, (_, id) => ({ id }));
  const displayed = appendLogWindow([{ id: -1 }], incoming);
  assert.equal(displayed.length, LOG_VIEW_LIMIT);
  assert.equal(displayed[0].id, 123);
  assert.equal(displayed.at(-1).id, LOG_VIEW_LIMIT + 122);
  assert.equal(appendLogWindow(displayed, []), displayed);
  assert.deepEqual(appendLogWindow([1, 2, 3], [4, 5], 3), [3, 4, 5]);
});

test('a burst of 1000 IPC batches schedules one bounded display update', () => {
  const { buffer, results, timers, tick } = fixture();
  for (let batch = 0; batch < 1000; batch++) buffer.push(Array.from({ length: 50 }, (_, index) => batch * 50 + index));
  assert.equal(results.length, 0);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 100);
  tick();
  assert.equal(results.length, 1);
  assert.equal(results[0].entries.length, LOG_VIEW_LIMIT);
  assert.equal(results[0].entries[0], 0);
  assert.equal(results[0].entries.at(-1), LOG_VIEW_LIMIT - 1);
  assert.equal(results[0].truncated, false);
  assert.equal(timers.size, 0);
});

test('pending chunks preserve newest order and signal count or upstream truncation', () => {
  const { buffer, results } = fixture({ limit: 5 });
  buffer.push([0, 1, 2]);
  buffer.push({ entries: [3, 4, 5, 6], truncated: false });
  buffer.flush();
  assert.deepEqual(results[0], { entries: [2, 3, 4, 5, 6], truncated: true });
  buffer.push([7, 8, 9, 10, 11, 12]);
  buffer.flush();
  assert.deepEqual(results[1], { entries: [8, 9, 10, 11, 12], truncated: true });
  buffer.push({ entries: [13], truncated: true });
  buffer.flush();
  assert.deepEqual(results[2], { entries: [13], truncated: true });
  buffer.push({ entries: [], truncated: true });
  buffer.flush();
  assert.deepEqual(results[3], { entries: [], truncated: true });
});

test('reset discards a previous stream and its timer without polluting a new capture', () => {
  const { buffer, results, timers, tick } = fixture({ limit: 2 });
  buffer.push([1, 2, 3]);
  buffer.reset();
  assert.equal(timers.size, 0);
  buffer.push({ entries: [4], truncated: false });
  tick();
  assert.deepEqual(results, [{ entries: [4], truncated: false }]);
  buffer.push([5]);
  buffer.reset();
  buffer.flush();
  assert.equal(results.length, 1);
});

test('stop flush delivers the final partial batch once and cancels the pending timer', () => {
  const { buffer, results, timers, tick } = fixture();
  buffer.push([1, 2]);
  buffer.flush();
  assert.equal(timers.size, 0);
  tick();
  buffer.flush();
  assert.deepEqual(results, [{ entries: [1, 2], truncated: false }]);
  buffer.push(null);
  buffer.push({ entries: 'invalid' });
  assert.equal(timers.size, 0);
});

test('display append enforces 100 MiB across consecutive legal long-line batches, not just 50k rows', () => {
  const raw = 'x'.repeat(1024 * 1024), rows = Array.from({ length: 128 }, (_, id) => ({ id, raw }));
  const previous = appendLogWindow([], rows.slice(0, 100)), result = appendLogWindow(previous, rows.slice(100));
  assert.equal(result.length, 100); assert.equal(result[0].id, 28); assert.equal(result.at(-1).id, 127);
  assert.equal(result.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.raw), 0), 100 * 1024 * 1024);
  assert.equal(rows.length, 128); assert.equal(rows[0].raw, raw); assert.equal(previous[0].id, 0);
});

test('the common bounded-window result discloses omitted whole rows and preserves original inputs', () => {
  const rows = [{ id: 'old', raw: '1234' }, { id: 'oversized', raw: 'x'.repeat(11) }, { id: 'new', raw: '5678' }];
  const result = stream.boundLogWindow(rows, { limit: 10, maxBytes: 10 });
  assert.deepEqual(result.entries.map(entry => entry.id), ['old', 'new']); assert.equal(result.bytes, 8); assert.equal(result.omittedRows, 1);
  assert.equal(result.entries[0], rows[0]); assert.equal(rows.length, 3);
});

test('pending IPC chunks enforce the same byte budget before their delayed display flush', () => {
  const { buffer, results, tick } = fixture({ maxBytes: 10 });
  for (let id = 0; id < 20; id++) { buffer.push([{ id, raw: '1234' }]); assert.ok(buffer.pendingBytes <= 10); }
  buffer.push([{ id: 'oversized', raw: 'x'.repeat(11) }]); assert.ok(buffer.pendingBytes <= 10);
  tick(); assert.deepEqual(results[0].entries.map(entry => entry.id), [18, 19]); assert.equal(results[0].truncated, true);
  assert.equal(buffer.pendingBytes, 0); assert.equal(buffer.pendingCount, 0);
});

test('pending byte eviction keeps the chronological tail, not older rows before an already-dropped incoming prefix', () => {
  const { buffer, results } = fixture({ maxBytes: 10 });
  buffer.push([{ id: 'old', raw: '12' }]);
  buffer.push([{ id: 'middle', raw: '1234' }, { id: 'new', raw: '12345678' }]);
  buffer.flush(); assert.deepEqual(results[0].entries.map(entry => entry.id), ['new']); assert.equal(results[0].truncated, true);
});

test('append caches old immutable row UTF-8 sizes instead of re-encoding the retained window on each burst', () => {
  const rows = Array.from({ length: 50000 }, (_, id) => ({ id, raw: '中文 original ' + id }));
  const previous = appendLogWindow([], rows), original = TextEncoder.prototype.encode; let calls = 0;
  TextEncoder.prototype.encode = function (...args) { calls++; return original.apply(this, args); };
  try { const next = appendLogWindow(previous, [{ id: 50000, raw: 'one new row' }]); assert.equal(next.length, 50000); assert.ok(calls <= 1, 'Only a newly received row needs UTF-8 encoding'); }
  finally { TextEncoder.prototype.encode = original; }
});
