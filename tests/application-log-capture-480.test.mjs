import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedApplicationLogCapture, getApplicationLogCapture } from '../src/shared/applicationLogCapture.js';

const state = () => ({ recording: false, available: false, startedAt: null, stoppedAt: null, bytes: 0, records: 0, dropped: 0, reason: 'idle', error: '' });
const settle = () => new Promise(resolve => setImmediate(resolve));
test('two application surfaces share one operation lock and one status lifecycle', async () => {
  let current = state(), reads = 0, starts = 0, release;
  const api = { appLogStatus: async () => { reads++; return { success: true, state: current }; },
    appLogStart: async () => { starts++; await new Promise(resolve => { release = resolve; }); current = { ...current, recording: true, available: true, startedAt: 1 }; return { success: true, state: current }; } };
  const store = createSharedApplicationLogCapture(api), snapshots = [];
  const offA = store.subscribe(() => snapshots.push(store.getSnapshot())), offB = store.subscribe(() => {});
  await settle(); assert.equal(reads, 1); assert.equal(store.getSnapshot(), store.getSnapshot());
  const first = store.model.start(), second = store.model.start(); await second;
  assert.equal(starts, 1); assert.equal(store.getSnapshot().busy, 'start');
  release(); await first; assert.equal(store.getSnapshot().capture.recording, true);
  offA(); assert.equal(store.getSnapshot().capture.recording, true); offB();
  assert.ok(snapshots.length > 0); assert.equal(starts, 1, 'Unmounting views cannot stop the backend capture');
});
test('cache is per desktop API and a remount reads authoritative state without starting or exporting', async () => {
  let reads = 0; const api = { appLogStatus: async () => { reads++; return { success: true, state: state() }; } };
  const first = getApplicationLogCapture(api); assert.equal(first, getApplicationLogCapture(api));
  assert.notEqual(first, getApplicationLogCapture({}));
  const off = first.subscribe(() => {}); await settle(); off();
  const again = first.subscribe(() => {}); await settle(); again(); assert.equal(reads, 2);
});

test('a deferred explicit action survives zero subscribers and a remount cannot reset its lock or lose its result', async t => {
  let current = state(), starts = 0; const releases = [];
  const api = { appLogStatus: async () => ({ success: true, state: current }), appLogStart: async () => {
    starts++; await new Promise(resolve => { releases.push(resolve); }); current = { ...current, available: true, recording: true, startedAt: 1 }; return { success: true, state: current };
  } };
  const store = createSharedApplicationLogCapture(api); const firstOff = store.subscribe(() => {}); await settle();
  const first = store.model.start(); firstOff(); const secondOff = store.subscribe(() => {}); await settle();
  t.after(() => { secondOff(); releases.forEach(resolve => resolve()); });
  const second = store.model.start(); assert.equal(starts, 1); assert.equal(store.getSnapshot().busy, 'start');
  releases.forEach(resolve => resolve()); await Promise.all([first, second]); assert.equal(store.getSnapshot().capture.recording, true); assert.equal(store.getSnapshot().busy, ''); secondOff();
});
