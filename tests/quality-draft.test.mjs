import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQualityDraft, readQualityDraft, writeQualityDraft } from '../src/shared/qualityDraft.js';
const storage = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };
test('quality drafts restore per device and never inherit another device baseline', () => {
  const store = storage();
  writeQualityDraft(store, 'device-A', { packageName: 'com.example.a', selectedBaselinePath: 'A', qualityTab: 'acceptance', lastTaskId: 'task-A' });
  writeQualityDraft(store, 'device-B', { packageName: 'com.example.b', selectedBaselinePath: 'B' });
  assert.equal(readQualityDraft(store, 'device-A').selectedBaselinePath, 'A');
  assert.equal(readQualityDraft(store, 'device-A').lastTaskId, 'task-A');
  assert.equal(readQualityDraft(store, 'device-C').selectedBaselinePath, '');
  assert.equal(readQualityDraft(store, 'device-B').packageName, 'com.example.b');
});
test('invalid stored values fall back safely and draft cache stays bounded', () => {
  const store = storage();
  assert.deepEqual(normalizeQualityDraft({ rounds: Infinity, qualityTab: {}, apkPath: { toString() { throw Error('not called'); } } }), normalizeQualityDraft());
  for (let i = 0; i < 12; i++) writeQualityDraft(store, `device-${i}`, { packageName: `com.example.app${i}` }, i);
  assert.equal(readQualityDraft(store, 'device-0').packageName, '');
  assert.equal(readQualityDraft(store, 'device-11').packageName, 'com.example.app11');
  assert.equal(writeQualityDraft({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }, 'device', {}), false);
});
test('corrupt or unreadable draft storage is never overwritten by default form persistence', () => {
  let value = '{broken-user-draft', writes = 0;
  const store = { getItem: () => value, setItem: (_key, next) => { value = next; writes++; } };
  assert.equal(readQualityDraft(store, 'device').packageName, '');
  assert.equal(writeQualityDraft(store, 'device', {}), false);
  assert.equal(writes, 0); assert.equal(value, '{broken-user-draft');
  const denied = { getItem() { throw Error('denied'); }, setItem() { writes++; } };
  assert.equal(writeQualityDraft(denied, 'device', {}), false); assert.equal(writes, 0);
});
