import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTroubleshootingContext } from '../src/shared/troubleshootingContext.js';
import { executePersistedPackageBatch, readPackageBatchResult, storePackageBatchResult } from '../src/shared/packageBatchStore.js';

test('global device switch clears old package; same navigation atomically applies its new package', () => {
  const previous = { currentDeviceId: 'A', activeDeviceId: 'B', running: false, appliedRequestId: 'old' };
  assert.equal(nextTroubleshootingContext(previous).packageName, '');
  const next = nextTroubleshootingContext({ ...previous, navigationContext: { requestId: 'new', deviceId: 'B', packageName: 'app.for.b' } });
  assert.equal(next.packageName, 'app.for.b');
  assert.equal(next.deviceId, 'B');
  assert.equal(next.appliedRequestId, 'new');
  assert.equal(nextTroubleshootingContext({ ...previous, currentDeviceId: 'B', appliedRequestId: 'new', navigationContext: { requestId: 'new', deviceId: 'B', packageName: 'app.for.b' } }), null);
});

test('running task keeps its context and consumes pending navigation only when it ends', () => {
  const state = { currentDeviceId: 'A', activeDeviceId: 'B', running: true, navigationContext: { requestId: 'new', deviceId: 'B', packageName: 'app.b' } };
  assert.equal(nextTroubleshootingContext(state), null);
  assert.equal(nextTroubleshootingContext({ ...state, running: false }).packageName, 'app.b');
  assert.equal(nextTroubleshootingContext({ ...state, running: false, navigationContext: { requestId: 'stale', deviceId: 'A', packageName: 'app.a' } }).packageName, '');
});

function createStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}

test('batch preserves previous record while pending and persists after UI unmount without callbacks', async () => {
  const storage = createStorage();
  const old = { label: '之前的操作', successCount: 1, failures: [] };
  storePackageBatchResult('A', old, storage);
  let finish;
  const pending = executePersistedPackageBatch({
    deviceId: 'A', action: 'uninstall', label: '批量卸载', packageNames: ['app.ok', 'app.fail'],
    storage, request: () => new Promise(resolve => { finish = resolve; })
  });
  assert.deepEqual(readPackageBatchResult('A', storage), old);
  // No mounted component or React state callback participates in persistence.
  finish({ results: [{ packageName: 'app.ok', ok: true }, { packageName: 'app.fail', ok: false, error: 'denied' }] });
  await pending;
  const restored = readPackageBatchResult('A', storage);
  assert.equal(restored.successCount, 1);
  assert.equal(restored.failures[0].packageName, 'app.fail');
  assert.equal(readPackageBatchResult('B', storage), null);
});

test('batch exceptions are persisted with uncertain outcomes, and cache failures remain visible', async () => {
  const storage = createStorage();
  const result = await executePersistedPackageBatch({
    deviceId: 'A', action: 'clearData', label: '清数据', packageNames: ['app.one'], storage,
    request: async () => { throw new Error('offline'); }
  });
  assert.equal(result.requestError, 'offline');
  assert.match(readPackageBatchResult('A', storage).failures[0].error, /执行结果不确定/);
  const failedStorage = { setItem() { throw new Error('quota'); } };
  assert.match(storePackageBatchResult('A', result.result, failedStorage), /缓存失败.*quota/);
});
