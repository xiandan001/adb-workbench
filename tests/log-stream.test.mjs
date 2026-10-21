import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLogWindow, createLogBatchBuffer, LOG_VIEW_LIMIT } from '../src/shared/logStream.js';

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
