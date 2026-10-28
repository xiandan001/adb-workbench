const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskTargetRegistry, materializeAiSteps, TTL } = require('../electron/lib/task-ai-targets.cjs');
const node = (text = 'Settings') => ({ index: 0, label: text, text, resourceId: 'fixture:id/settings', className: 'Button', x: 50, y: 80 });

test('read-only target registration and selection bind owner, snapshot, node and device without execution dependencies', () => {
  const registry = createTaskTargetRegistry();
  const snapshot = registry.remember({ nodes: [node()] }, 'fixture-A', 1);
  const target = registry.select({ snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId }, 1);
  assert.equal(target.deviceId, 'fixture-A'); assert.equal(target.label, 'Settings'); assert.equal(target.selector, undefined);
  const resolved = registry.resolve([target.token], 1);
  assert.equal(resolved.targets[0].id, 'T1'); assert.equal(resolved.targets[0].selector.resourceId, 'fixture:id/settings');
  assert.throws(() => registry.resolve([target.token], 2), { code: 'TASK_TARGET_INVALID' });
  assert.throws(() => registry.select({ snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId }, 2), { code: 'TASK_TARGET_INVALID' });
  assert.throws(() => registry.select({ snapshotId: snapshot.snapshotId, nodeId: 'made-up' }, 1), { code: 'TASK_TARGET_INVALID' });
});

test('new snapshots invalidate unselected old nodes; selected references remain frozen until bounded expiry', () => {
  let now = 0; const registry = createTaskTargetRegistry({ now: () => now });
  const first = registry.remember({ nodes: [node()] }, 'fixture-A', 1);
  const target = registry.select({ snapshotId: first.snapshotId, nodeId: first.nodes[0].targetNodeId }, 1);
  registry.remember({ nodes: [node('Other')] }, 'fixture-A', 1);
  assert.throws(() => registry.select({ snapshotId: first.snapshotId, nodeId: first.nodes[0].targetNodeId }, 1), { code: 'TASK_TARGET_INVALID' });
  assert.equal(registry.resolve([target.token], 1).targets[0].label, 'Settings');
  now = TTL; assert.throws(() => registry.resolve([target.token], 1), { code: 'TASK_TARGET_INVALID' });
});

test('ambiguous, class-only and password nodes cannot become AI interaction capabilities', () => {
  const registry = createTaskTargetRegistry();
  const snapshot = registry.remember({ nodes: [node(), node(), { label: 'class', className: 'View' }, { ...node('secret'), password: true }] }, 'fixture-A', 1);
  assert.ok(snapshot.nodes.every(item => item.aiSelectable === false));
  for (const item of snapshot.nodes) assert.throws(() => registry.select({ snapshotId: snapshot.snapshotId, nodeId: item.targetNodeId }, 1), { code: 'TASK_TARGET_INVALID' });
});

test('multi-target generation rejects mixed devices, duplicate tokens and more than ten targets', () => {
  const registry = createTaskTargetRegistry(); const tokens = [];
  for (const deviceId of ['fixture-A', 'fixture-B']) {
    const snapshot = registry.remember({ nodes: [node()] }, deviceId, 1);
    tokens.push(registry.select({ snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId }, 1).token);
  }
  assert.throws(() => registry.resolve(tokens, 1), { code: 'TASK_TARGET_INVALID' });
  assert.throws(() => registry.resolve([tokens[0], tokens[0]], 1), { code: 'TASK_TARGET_INVALID' });
  assert.throws(() => registry.resolve(Array(11).fill(tokens[0]), 1), { code: 'TASK_TARGET_INVALID' });
  registry.clearOwner(1); assert.throws(() => registry.resolve([tokens[0]], 1), { code: 'TASK_TARGET_INVALID' });
});

test('model target IDs materialize only known selectors with unique matching and no coordinate fallback', () => {
  const targets = [{ id: 'T1', label: 'settings', selector: { resourceId: 'fixture:id/settings', className: 'Button' } }];
  const actual = materializeAiSteps([{ type: 'tap', label: 'tap chosen', targetId: 'T1' }], targets)[0];
  assert.deepEqual(actual, { type: 'tap', label: 'tap chosen', ...targets[0].selector, requireUnique: true });
  assert.equal(actual.x, undefined); assert.equal(actual.y, undefined);
  for (const step of [{ type: 'tap', label: 'bad', targetId: 'T2' }, { type: 'tap', label: 'bad', targetId: 'T1', x: 50, y: 80 },
    { type: 'tap', label: 'bad', targetId: 'T1', selector: { text: 'model invented' } }, { type: 'shell', label: 'bad', targetId: 'T1' }]) {
    assert.throws(() => materializeAiSteps([step], targets), { code: 'TASK_TARGET_INVALID' });
  }
  assert.deepEqual(materializeAiSteps([{ type: 'screenshot', label: 'capture' }]), [{ type: 'screenshot', label: 'capture' }]);
});
