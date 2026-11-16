import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_CONTEXT_KEY, emptyApplicationContext, normalizeApplicationContext, nextApplicationContext,
  readApplicationContext, saveApplicationContext, applicationForDevice } from '../src/shared/applicationContext.js';
import { readInitialNavigation, UI_WORKSPACE_KEY, defaultUiWorkspace } from '../src/shared/workbenchUiState.js';

function memory() { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
test('application context is exact-device metadata and persists independently across transport identities', () => {
  const storage = memory();
  let value = nextApplicationContext(emptyApplicationContext(), 'USB-A', 'com.fixture.one');
  value = nextApplicationContext(value, 'hdc:USB-A', 'com.fixture.two'); saveApplicationContext(value, storage);
  assert.equal(applicationForDevice(readApplicationContext(storage), 'USB-A'), 'com.fixture.one');
  assert.equal(applicationForDevice(value, 'hdc:USB-A'), 'com.fixture.two'); assert.equal(applicationForDevice(value, 'unknown'), '');
  value = nextApplicationContext(value, 'USB-A', ''); assert.equal(applicationForDevice(value, 'USB-A'), '');
});
test('context is bounded to twenty devices and excludes active operation or evidence fields', () => {
  let value = emptyApplicationContext();
  for (let i = 0; i < 25; i++) value = nextApplicationContext(value, 'device-' + i, 'com.fixture.app');
  assert.equal(value.entries.length, 20); assert.equal(value.entries[0].deviceId, 'device-5');
  for (const invalid of [{ ...value, execute: true }, { version: 1, entries: [{ deviceId: 'A', packageName: 'x', logs: 'secret' }] },
    { version: 1, entries: [{ deviceId: 'A', packageName: 'x\n' }] }, { version: 1, entries: Array(2) }]) assert.throws(() => normalizeApplicationContext(invalid));
});
test('corrupt context and failed writes preserve original bytes and do not prevent a valid session selection', () => {
  const storage = memory(); storage.values.set(APPLICATION_CONTEXT_KEY, '{bad');
  const next = nextApplicationContext(emptyApplicationContext(), 'A', 'com.fixture');
  assert.throws(() => saveApplicationContext(next, storage)); assert.equal(storage.values.get(APPLICATION_CONTEXT_KEY), '{bad');
  storage.values.set(APPLICATION_CONTEXT_KEY, JSON.stringify(emptyApplicationContext()));
  const before = storage.values.get(APPLICATION_CONTEXT_KEY); storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveApplicationContext(next, storage), /quota/); assert.equal(storage.values.get(APPLICATION_CONTEXT_KEY), before);
  assert.equal(applicationForDevice(next, 'A'), 'com.fixture');
});
test('last-page restoration returns navigation metadata only and never replays work', () => {
  const storage = memory(); storage.values.set(UI_WORKSPACE_KEY, JSON.stringify({ ...defaultUiWorkspace(), lastPage: 'ai-workspace' }));
  assert.deepEqual(readInitialNavigation(storage), { activeTab: 'ai-workspace', sshVisited: false, aiToolsVisited: false, aiVisited: true });
  storage.values.set(UI_WORKSPACE_KEY, '{bad'); assert.equal(readInitialNavigation(storage).activeTab, 'devices');
  assert.equal(storage.values.get(UI_WORKSPACE_KEY), '{bad');
});
