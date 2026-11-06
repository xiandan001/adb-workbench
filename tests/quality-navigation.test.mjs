import test from 'node:test';
import assert from 'node:assert/strict';
import { guardNavigationRequest, findGuardRecord } from '../src/shared/qualityNavigation.js';

test('guard navigation consumes exact IDs from current and legacy request shapes', () => {
  assert.deepEqual(guardNavigationRequest('guard-old:1730000000000'), { id: 'guard-old', key: 'guard-old:1730000000000' });
  assert.deepEqual(guardNavigationRequest({ id: 'guard-old', requestId: 3 }), { id: 'guard-old', key: 'guard-old:3' });
  assert.equal(guardNavigationRequest('guard-old').id, 'guard-old');
});

test('an older guard opens exactly its report rather than latest or another device', () => {
  const state = { activeGuards: [{ id: 'guard-active', deviceId: 'A' }], history: [
    { id: 'latest-B', deviceId: 'B', reportPath: 'B.md' },
    { id: 'latest-A', deviceId: 'A', reportPath: 'new.md' },
    { id: 'guard-old', deviceId: 'A', reportPath: 'old.md' }
  ] };
  assert.equal(findGuardRecord(state, 'A', 'guard-old').reportPath, 'old.md');
  assert.equal(findGuardRecord(state, 'A').reportPath, 'new.md');
  assert.equal(findGuardRecord(state, 'A', 'guard-active').id, 'guard-active');
  assert.equal(findGuardRecord(state, 'A', 'removed'), null);
  assert.equal(findGuardRecord(state, 'B', 'guard-old').reportPath, 'old.md');
  assert.equal(findGuardRecord(state, 'B', 'guard-old').deviceId, 'A');
  assert.equal(findGuardRecord(state, 'B').deviceId, 'B');
  assert.equal(findGuardRecord(state, '', 'guard-old').deviceId, 'A');
});
