const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { captureRunSnapshot } = require('../electron/lib/task-rerun.cjs');
const { writeRunManifest, createRunComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');
const { normalizeTaskOrigin, runEvidence } = require('../electron/lib/task-run-provenance.cjs');

function workerModel() {
  const filename = path.resolve(__dirname, '../electron/lib/task-center-worker.cjs'), actualRequire = createRequire(filename);
  const model = { Buffer, console, process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    require(name) {
      if (name === 'worker_threads') return { parentPort: { on() {}, postMessage() {} }, workerData: {} };
      if (name === 'child_process') return { execFile() { throw new Error('No real device operations permitted'); } };
      return actualRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), model, { filename });
  model.waitForUiNode = (task, deviceId, step, timeout) => model.findUiNode(task, deviceId, step, timeout);
  return model;
}
const xmlNode = (left = 10, right = 30) => `<node text="Settings" resource-id="fixture:id/settings" class="Button" bounds="[${left},20][${right},40]" />`;

test('actual worker UI DTO marks password controls and omits their plaintext labels and values', () => {
  const model = workerModel();
  const parsed = model.parseUiNodes('<hierarchy><node text="must-not-leak" content-desc="private-value" password="true" resource-id="fixture:id/password" class="EditText" bounds="[10,10][100,50]" /></hierarchy>');
  const node = model.toPublicUiNode(parsed[0], 0);
  assert.equal(node.password, true); assert.equal(node.text, ''); assert.equal(node.contentDesc, '');
  assert.equal(node.label, 'fixture:id/password'); assert.doesNotMatch(JSON.stringify(node), /must-not-leak|private-value/);
});

test('AI selectors require a unique current node, reject ambiguous matches, and never use stale fallback coordinates', async () => {
  const model = workerModel(); let xml = `<hierarchy>${xmlNode()}</hierarchy>`; const commands = [];
  model.runAdb = async (_task, args) => { commands.push(args); return args.at(-1).startsWith('input ') ? { ok: true } : { ok: true, stdout: xml }; };
  const step = { type: 'tap', label: 'fixture', selector: { resourceId: 'fixture:id/settings' }, requireUnique: true, x: 999, y: 999, timeoutMs: 1 };
  assert.equal(model.normalizeStep(step).requireUnique, true);
  assert.equal((await model.tapUiTarget({}, 'fixture-A', step)).ok, true); assert.match(commands.at(-1).at(-1), /input tap 20 30/);
  commands.length = 0; xml = `<hierarchy>${xmlNode()}${xmlNode(40, 60)}</hierarchy>`;
  assert.equal((await model.tapUiTarget({}, 'fixture-A', step)).ok, false); assert.equal(commands.some(args => args.at(-1).startsWith('input ')), false);
  commands.length = 0; xml = '<hierarchy></hierarchy>';
  assert.equal((await model.longPressUiTarget({}, 'fixture-A', { ...step, durationMs: 500 })).ok, false);
  assert.equal(commands.some(args => args.at(-1).startsWith('input ')), false);
  assert.equal((await model.tapUiTarget({}, 'fixture-A', { ...step, requireUnique: false })).ok, true);
  assert.match(commands.at(-1).at(-1), /input tap 999 999/);
});

test('input snapshot persists in manifest but never leaks into frequent public worker updates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-task-origin-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-task-origin-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const script = { id: 'fixture-script', name: 'Fixture', mode: 'replay', continueOnError: false, steps: [{ id: 's', type: 'screenshot', label: 'capture' }] };
  const rerunSnapshot = await captureRunSnapshot(script);
  const analysisOrigin = normalizeTaskOrigin({ caseId: randomUUID(), turnId: randomUUID(), question: 'fixture question', summary: 'Hypothesis, not verified', finding: { title: 'fixture finding', detail: 'password=secret-fixture' } });
  assert.doesNotMatch(JSON.stringify(analysisOrigin), /secret-fixture/);
  const task = { id: 'fixture-task', script, scriptName: script.name, analysisOrigin, rerunSnapshot, parentTaskId: 'fixture-parent', artifactDir: directory,
    status: 'failed', comparison: createRunComparisonIdentity(script, { rerunSnapshot }), deviceRuns: [{ deviceId: 'fixture-A', status: 'failed', steps: [{ id: 's', type: 'screenshot', status: 'failed', error: 'fixture failed' }] }] };
  const model = workerModel(), record = JSON.parse(JSON.stringify(model.publicTask(task)));
  assert.equal(record.rerunSnapshot, undefined); assert.deepEqual(record.analysisOrigin, analysisOrigin); assert.ok(record.inputHash);
  writeRunManifest(record, { rerunSnapshot });
  const stored = JSON.parse(fs.readFileSync(record.runResultPath, 'utf8'));
  assert.equal(stored.rerunSnapshot.script.name, 'Fixture'); assert.equal(stored.parentTaskId, 'fixture-parent');
  const evidence = runEvidence(stored); assert.equal(evidence.deviceId, 'fixture-A'); assert.match(evidence.text, /fixture question|fixture failed/);
  assert.equal(evidence.contextRef, undefined); assert.deepEqual(evidence.originSnapshot, analysisOrigin);
});

test('a rerun step whose input changed after final confirmation fails before issuing its device command', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-task-step-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-task-step-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'fixture.apk'); fs.writeFileSync(filename, 'first');
  const script = { name: 'fixture', continueOnError: false, steps: [{ id: 'install', type: 'installApk', localPath: filename }] };
  const snapshot = await captureRunSnapshot(script); fs.writeFileSync(filename, 'changed');
  const model = workerModel(); let calls = 0; model.runAdb = async () => { calls++; return { ok: true }; };
  const result = await model.executeStep({ parentTaskId: 'original', rerunSnapshot: snapshot }, 'fixture-A', script.steps[0]);
  assert.equal(result.ok, false); assert.equal(calls, 0);
});

test('cancelling optional AI summary preserves actual local task results and writes a skipped-analysis report', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-task-summary-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-task-summary-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const model = workerModel(); model.ensureTaskRootDir = async () => directory;
  let answer;
  model.requestMain = async (action, payload, timeoutMs) => {
    assert.equal(action, 'aiSummary'); assert.equal(payload.taskId, 'summary-fixture'); assert.ok(timeoutMs > 70000);
    return new Promise(resolve => { answer = resolve; });
  };
  const task = { id: 'summary-fixture', scriptName: 'fixture', status: 'success', logs: [],
    script: { loop: {}, acceptance: {}, report: { includeAiSummary: true } },
    deviceRuns: [{ deviceId: 'fixture-A', status: 'success', completedRounds: 1, stressRounds: [] }] };
  const writing = model.writeStressArtifacts(task, { passed: true, completedRounds: 1, failedRounds: 0, totalSteps: 1 });
  for (let i = 0; !answer && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof answer, 'function');
  const filename = path.join(directory, 'stress-result.json'), before = fs.readFileSync(filename);
  assert.equal(JSON.parse(before).status, 'success');
  answer({ ok: true, result: { ok: true, summary: { ok: false, cancelled: true, code: 'AI_SEND_CANCELLED' } } });
  await writing;
  assert.deepEqual(fs.readFileSync(filename), before); assert.equal(task.status, 'success'); assert.equal(task.deviceRuns[0].status, 'success');
  const report = fs.readFileSync(path.join(directory, 'stress-report.md'), 'utf8');
  assert.match(report, /AI 分析已取消/); assert.doesNotMatch(report, /AI 分析失败/);
});
