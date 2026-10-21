import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreStartupData } from '../src/shared/dataMigrationBootstrap.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('normal startup does not change local storage or acknowledge unrelated data', async () => {
  const local = storage({ activeDeviceId: 'current-device', currentTheme: 'default' });
  await restoreStartupData({ migrationBootstrap: async () => ({ ok: true, status: 'none' }) }, local);
  assert.equal(local.getItem('currentTheme'), 'default');
  assert.equal(local.getItem('activeDeviceId'), 'current-device');
});

test('startup preferences are restored before acknowledgement and unrelated keys survive', async () => {
  const local = storage({ activeDeviceId: 'keep', currentTheme: 'default' });
  let acknowledgements = 0;
  await restoreStartupData({
    migrationBootstrap: async () => ({ ok: true, id: 'one', preferences: { currentTheme: 'tech', deviceNames: '{"d":"Office"}' } }),
    migrationAcknowledge: async ({ id }) => {
      assert.equal(id, 'one'); assert.equal(local.getItem('currentTheme'), 'tech'); acknowledgements++; return { ok: true };
    }
  }, local);
  assert.equal(acknowledgements, 1);
  assert.equal(local.getItem('activeDeviceId'), 'keep');
});

test('storage failure rolls disk and preferences back before starting the application', async () => {
  const local = storage({ currentTheme: 'default', unrelated: 'kept' });
  const set = local.setItem;
  local.setItem = (key, value) => { if (value === 'tech') throw new Error('quota'); return set(key, value); };
  const calls = [];
  await restoreStartupData({
    migrationBootstrap: async () => ({ ok: true, id: 'one', preferences: { deviceNames: '{"d":"new"}', currentTheme: 'tech' } }),
    migrationRollback: async ({ id }) => { calls.push(`rollback:${id}`); return { ok: true, preferences: { currentTheme: 'default' }, removePreferenceKeys: ['deviceNames'] }; },
    migrationAcknowledge: async ({ id }) => { calls.push(`ack:${id}`); return { ok: true }; }
  }, local);
  assert.deepEqual(calls, ['rollback:one', 'ack:one']);
  assert.equal(local.getItem('currentTheme'), 'default');
  assert.equal(local.getItem('deviceNames'), null);
  assert.equal(local.getItem('unrelated'), 'kept');
});

test('failed rollback blocks startup rather than mounting a partially restored application', async () => {
  const local = storage();
  await assert.rejects(restoreStartupData({
    migrationBootstrap: async () => ({ ok: true, id: 'one', preferences: { forbidden: 'bad' } }),
    migrationRollback: async () => ({ ok: false, error: 'disk inaccessible' })
  }, local), /恢复失败/);
});

test('interrupted import removes only new portable keys while acknowledging recovery', async () => {
  const local = storage({ deviceNames: '{"d":"new"}', currentTheme: 'tech', secret: 'unchanged' });
  await restoreStartupData({
    migrationBootstrap: async () => ({ ok: true, id: 'one', status: 'rolled-back', preferences: { currentTheme: 'default' }, removePreferenceKeys: ['deviceNames'] }),
    migrationAcknowledge: async () => ({ ok: true })
  }, local);
  assert.equal(local.getItem('deviceNames'), null);
  assert.equal(local.getItem('secret'), 'unchanged');
  assert.equal(local.getItem('currentTheme'), 'default');
});
