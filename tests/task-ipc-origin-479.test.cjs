const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-task-ipc-'));
  const filename = path.join(__dirname, '../electron/lib/task-center.cjs'), actualRequire = createRequire(filename);
  const sender = new EventEmitter(); sender.id = 17; sender.mainFrame = {};
  const window = { isDestroyed: () => false, webContents: sender };
  const module = { exports: {} }, handlers = new Map(), spawned = [], activity = [], handoffs = [];
  const context = { module, console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    require(name) {
      if (name === 'electron') return { app: { getPath: () => directory, isPackaged: false } };
      if (name === './app-context.cjs') return { getMainWindow: () => window, broadcastToAllWindows() {} };
      if (name === './workbench-activity.cjs') return { begin: item => activity.push(item), update() {}, finish() {} };
      if (name === './ai-analysis-handoff.cjs') return { createInternal: async input => { handoffs.push(input); return { handoffId: 'fixture-target-handoff' }; } };
      if (name === 'child_process') return { execFile() { throw new Error('No real ADB'); } };
      if (name === 'worker_threads') return { Worker: class { constructor() { throw new Error('No real worker execution'); } } };
      if (name === './adb-runtime.cjs') return { getAdbCommand: () => 'forbidden-adb', runAdb: async () => { throw new Error('No real ADB'); } };
      if (['./vip.cjs', './inspection.cjs', './performance-monitor.cjs', './ai-analyze.cjs'].includes(name)) return {};
      return actualRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  context.captureUiSnapshot = async () => ({ nodes: [{ index: 0, label: 'Settings', resourceId: 'fixture:id/settings', text: 'Settings', className: 'Button' }] });
  context.recordStressAction = async () => { throw new Error('Selection must never record or execute a step'); };
  context.startWorkerTask = task => { spawned.push(task); return { ok: true }; };
  module.exports.register({ handle: (name, handler) => handlers.set(name, handler) });
  t.after(() => {
    module.exports.cleanup();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-task-ipc-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const event = { sender, senderFrame: sender.mainFrame };
  return { api: module.exports, context, handlers, sender, event, directory, spawned, activity, handoffs };
}

test('new task capabilities reject foreign main frames; select never calls recordAction or starts a worker', async t => {
  const h = harness(t);
  for (const channel of ['ai-target:select', 'ai-target:handoff', 'rerun:preview', 'rerun:failed']) {
    assert.equal((await h.handlers.get(`task-center:${channel}`)({ sender: h.sender, senderFrame: {} }, {})).code, 'TASK_OWNER');
  }
  const snapshot = await h.handlers.get('task-center:stress:uiSnapshot')(h.event, { deviceId: 'fixture-A' });
  assert.equal(snapshot.ok, true); assert.ok(snapshot.snapshotId); assert.ok(snapshot.nodes[0].targetNodeId);
  const selected = await h.handlers.get('task-center:ai-target:select')(h.event, { snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId });
  assert.equal(selected.ok, true); assert.equal(h.spawned.length, 0);
  assert.equal(h.api.resolveAiTaskTargets([selected.target.token], 17).targets[0].id, 'T1');
  h.sender.emit('did-start-navigation', {}, 'fixture', false, true);
  assert.throws(() => h.api.resolveAiTaskTargets([selected.target.token], 17), { code: 'TASK_TARGET_INVALID' });
});

test('actual main-process UI DTO also blocks plaintext password values before target registration', t => {
  const h = harness(t);
  const node = h.context.toPublicUiNode({ attrs: { text: 'private-input', 'content-desc': 'private-description', password: 'true', 'resource-id': 'fixture:id/password', class: 'EditText' }, bounds: { left: 0, top: 0, right: 100, bottom: 40 } }, 0);
  assert.equal(node.password, true); assert.equal(node.text, ''); assert.equal(node.label, 'fixture:id/password'); assert.doesNotMatch(JSON.stringify(node), /private-input|private-description/);
});

test('registered target handoff resolves real selected tokens without executing a device action', async t => {
  const h = harness(t);
  const snapshot = await h.handlers.get('task-center:stress:uiSnapshot')(h.event, { deviceId: 'fixture-A' });
  const selected = await h.handlers.get('task-center:ai-target:select')(h.event, { snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId });
  const result = await h.handlers.get('task-center:ai-target:handoff')(h.event, { tokens: [selected.target.token] });
  assert.equal(result.ok, true, result.error); assert.equal(result.handoffId, 'fixture-target-handoff');
  assert.equal(h.handoffs.length, 1); assert.equal(h.spawned.length, 0);
  const handoff = h.handoffs[0];
  assert.equal(handoff.origin, 'task-targets'); assert.equal(handoff.deviceId, 'fixture-A');
  assert.equal(handoff.text, 'T1: Settings'); assert.equal(handoff.taskTargets[0].token, selected.target.token);
  assert.equal(handoff.taskTargets[0].deviceId, 'fixture-A'); assert.equal(handoff.taskTargets[0].selector, undefined);
  assert.equal(handoff.taskTargets[0].id, undefined);
});

test('internally saved analysis origin survives editing and dispatch; renderer-forged origins are not trusted', async t => {
  const h = harness(t);
  const script = h.api.saveAiDraft({ name: 'fixture', description: 'safe', steps: [{ type: 'screenshot', label: 'capture' }] },
    { origin: { question: 'Original question', summary: 'Original hypothesis', finding: { title: 'Original finding', detail: 'fixture detail' } } });
  const stored = JSON.parse(fs.readFileSync(path.join(h.directory, 'task-center-scripts.json'), 'utf8')).scripts[0];
  assert.equal(stored.analysisOrigin.question, 'Original question');
  const edited = await h.handlers.get('task-center:scripts:save')(h.event, { script: { ...script, name: 'edited', analysisOrigin: { question: 'renderer forged' } } });
  assert.equal(edited.ok, true); assert.equal(edited.script.analysisOrigin.question, 'Original question');
  const run = await h.api.runInlineScript({ ...edited.script, analysisOrigin: { question: 'forged again' } }, ['fixture-A'], h.sender, {});
  assert.equal(run.ok, true); assert.equal(h.spawned.length, 1); assert.equal(h.spawned[0].analysisOrigin.question, 'Original question');
  assert.equal(h.spawned[0].rerunSnapshot.script.name, 'edited'); assert.equal(run.task.rerunSnapshot, undefined);
  assert.equal(h.activity[0].target.id, run.task.id);
  const evidence = await h.api.getRunEvidence(run.task.id);
  assert.match(evidence.text, /Original question/); assert.doesNotMatch(evidence.text, /renderer forged|forged again/);
});

test('AI control tasks retain source-device binding despite editor metadata removal, while manual multi-device tasks remain usable', async t => {
  const h = harness(t);
  const snapshot = await h.handlers.get('task-center:stress:uiSnapshot')(h.event, { deviceId: 'fixture-A' });
  const selected = await h.handlers.get('task-center:ai-target:select')(h.event, { snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0].targetNodeId });
  const { targets } = h.api.resolveAiTaskTargets([selected.target.token], 17);
  const script = h.api.saveAiDraft({ name: 'chosen control', description: '', steps: [{ type: 'tap', label: 'tap', targetId: 'T1' }] }, { targets });
  assert.equal(script.aiTargetDeviceId, 'fixture-A'); assert.equal(script.steps[0].requireUnique, true);
  assert.equal(script.steps[0].resourceId, 'fixture:id/settings');
  const edited = await h.handlers.get('task-center:scripts:save')(h.event, { script: { ...script, aiTargetDeviceId: '', analysisOrigin: null } });
  assert.equal(edited.script.aiTargetDeviceId, 'fixture-A');
  assert.equal((await h.api.runInlineScript({ ...edited.script, aiTargetDeviceId: 'fixture-B' }, ['fixture-B'], h.sender)).code, 'TASK_TARGET_DEVICE');
  assert.equal(h.spawned.length, 0);
  assert.equal((await h.api.runInlineScript(edited.script, ['fixture-A'], h.sender)).ok, true);
  const manual = { id: 'separate-manual', name: 'manual', steps: [{ type: 'screenshot' }] };
  assert.equal((await h.api.runInlineScript(manual, ['fixture-A', 'fixture-B'], h.sender)).ok, true); assert.equal(h.spawned.length, 2);
});
