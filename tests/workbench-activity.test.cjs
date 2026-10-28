const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityRegistry } = require('../electron/lib/workbench-activity.cjs');
const input = id => ({ id, kind: 'ai', title: 'Fixture', target: { page: 'ai-workspace', id } });

test('activity exposes bounded DTOs and never serializes callbacks or private fields', () => {
  const registry = createActivityRegistry();
  registry.begin({ ...input('one'), cancel: () => {}, secret: 'hidden' });
  assert.equal(registry.list().items[0].canCancel, true);
  assert.ok(!JSON.stringify(registry.list()).includes('hidden'));
  assert.ok(!Object.hasOwn(registry.list().items[0], 'cancel'));
  assert.throws(() => registry.begin(input('one')));
  assert.throws(() => registry.begin({ ...input('two'), target: { page: 'https://example.invalid' } }));
});

test('cancellation is isolated and remains pending until the owner reports terminal state', async () => {
  const registry = createActivityRegistry(); let calls = 0;
  registry.begin({ ...input('one'), cancel: async () => { calls++; } }); registry.begin(input('two'));
  assert.equal((await registry.cancel('one')).ok, true); assert.equal(calls, 1);
  assert.equal((await registry.cancel('one')).ok, false);
  assert.equal(registry.list().items.find(item => item.id === 'one').status, 'cancelling');
  assert.equal(registry.list().items.find(item => item.id === 'two').status, 'running');
  assert.equal(registry.dismiss('one'), false);
  registry.finish('one', { status: 'cancelled' }); assert.equal(registry.dismiss('one'), true);
});

test('no fabricated progress, no late overwrite and terminal retention is disclosed', () => {
  let now = 0; const registry = createActivityRegistry({ now: () => now++, limit: 2 });
  registry.begin(input('active'));
  for (let i = 0; i < 3; i++) { registry.begin(input(`done${i}`)); registry.finish(`done${i}`, { status: 'failed', detail: 'failure' }); }
  assert.equal(registry.list().items.length, 3); assert.equal(registry.list().olderCount, 1);
  assert.equal(registry.update('done2', { detail: 'late' }), false);
  assert.equal(registry.list().items.find(item => item.id === 'done2').detail, 'failure');
  assert.ok(!Object.hasOwn(registry.list().items[0], 'progress'));
  registry.update('active', { progress: 41 }); assert.equal(registry.list().items[0].progress, 41);
  registry.update('active', { progress: null }); assert.ok(!Object.hasOwn(registry.list().items[0], 'progress'));
});

test('failed cancellation restores only its activity and does not hide failure', async () => {
  const registry = createActivityRegistry();
  registry.begin({ ...input('one'), cancel: async () => ({ ok: false, error: 'not yet' }) });
  assert.equal((await registry.cancel('one')).ok, false);
  assert.equal(registry.list().items[0].status, 'running'); assert.equal(registry.list().items[0].detail, 'not yet');
});
