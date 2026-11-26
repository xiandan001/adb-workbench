const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validTaskStepReference, readTaskStepEvidence, taskStepLogIdentity, taskEvidenceFileStem } = require('../electron/lib/task-step-evidence.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0s0AAAAASUVORK5CYII=', 'base64');
const none = { screenshot: '', logText: '', logTruncated: false };
const input = { taskId: 'task-fixture', deviceId: 'original-A', stepId: 'same', stepIndex: 1, roundIndex: null };

test('the unpacked task worker has its step evidence dependency beside it', () => {
  const { asarUnpack } = require('../electron-builder.json');
  assert.ok(asarUnpack.includes('electron/lib/task-center-worker.cjs'));
  assert.ok(asarUnpack.includes('electron/lib/task-step-evidence.cjs'));
});

test('read only the named run device step screenshot; reject renderer paths, cross-run and ambiguous selectors', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-step-evidence-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'artifacts');
  await fs.mkdir(root);
  const shot = path.join(root, 'a.png');
  await fs.writeFile(shot, png);
  const task = { id: input.taskId, mode: 'replay', artifactDir: root, deviceRuns: [
    { deviceId: 'new-A', originalDeviceId: 'original-A', steps: [{ id: 'same', index: 1, screenshotArtifact: shot, artifact: path.join(root, 'a.json') }] },
    { deviceId: 'B', steps: [{ id: 'same', index: 1, artifact: path.join(root, 'missing.png') }] },
  ] };
  assert.equal(validTaskStepReference(input), true);
  assert.equal(validTaskStepReference({ ...input, filePath: shot }), false);
  assert.equal(validTaskStepReference({ ...input, roundIndex: 0 }), false);
  assert.deepEqual(await readTaskStepEvidence(task, input), { ...none, screenshot: `data:image/png;base64,${png.toString('base64')}` });
  for (const mismatched of [{ deviceId: 'new-A' }, { deviceId: 'B' }, { taskId: 'task-other' }, { stepIndex: 0 }, { stepId: 'other' }, { roundIndex: 1 }]) {
    assert.deepEqual(await readTaskStepEvidence(task, { ...input, ...mismatched }), none);
  }
  const duplicate = { ...task, deviceRuns: [...task.deviceRuns, task.deviceRuns[0]] };
  assert.deepEqual(await readTaskStepEvidence(duplicate, input), none);
  const step = task.deviceRuns[0].steps[0];
  const external = path.join(base, 'elsewhere.png');
  await fs.writeFile(external, png);
  step.screenshotArtifact = external;
  assert.deepEqual(await readTaskStepEvidence(task, input), none);
  const externalRoot = path.join(base, 'unowned');
  await fs.mkdir(externalRoot);
  await fs.writeFile(path.join(externalRoot, 'external.png'), png);
  await fs.symlink(externalRoot, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  step.screenshotArtifact = path.join(root, 'alias', 'external.png');
  assert.deepEqual(await readTaskStepEvidence(task, input), none);
  await fs.writeFile(shot, 'Not a PNG');
  step.screenshotArtifact = shot;
  assert.deepEqual(await readTaskStepEvidence(task, input), none);
});

test('read bounded step log from that same stress round, retain exact identity metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-step-log-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'capture.log');
  await fs.writeFile(log, 'r2\n' + 'x'.repeat(512 * 1024));
  const step = { id: 'same', index: 1, artifact: log, roundIndex: 2 };
  const run = { deviceId: 'new-A', originalDeviceId: 'original-A', stressRounds: [{ index: 2, steps: [step] }], steps: [] };
  const task = { id: input.taskId, mode: 'stress', artifactDir: root, deviceRuns: [run] };
  assert.deepEqual(taskStepLogIdentity(run, step), { deviceId: 'original-A', stepId: 'same', stepIndex: 1, roundIndex: 2 });
  const shown = await readTaskStepEvidence(task, { ...input, roundIndex: 2 });
  assert.match(shown.logText, /^r2\n/);
  assert.equal(shown.logText.length, 512 * 1024);
  assert.equal(shown.logTruncated, true);
  assert.deepEqual(await readTaskStepEvidence(task, { ...input, roundIndex: 1 }), none);
});

test('screenshot, comparison and external log stems are distinct even for an identical sanitized device and clock', () => {
  for (const prefix of ['', 'compare', 'external']) {
    const stems = new Set(Array.from({ length: 300 }, () => taskEvidenceFileStem(prefix, 'same-device', '2026-11-26-151500')));
    assert.equal(stems.size, 300);
    assert.match([...stems][0], /same-device-2026-11-26-151500-[0-9a-f-]{36}$/i);
  }
});

test('legacy path reused across devices, steps, or rounds is ambiguous; a duplicate view of the same step is safe', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-shared-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shot = path.join(root, 'shared.png'), log = path.join(root, 'shared.log');
  await fs.writeFile(shot, png);
  await fs.writeFile(log, 'device log');
  const selected = { id: 'same', index: 1, roundIndex: 1, artifact: log, screenshotArtifact: shot };
  const activeInput = { ...input, roundIndex: 1 };
  const device = { originalDeviceId: 'original-A', deviceId: 'A', steps: [selected], stressRounds: [{ index: 1, steps: [{ ...selected }] }] };
  const task = { id: input.taskId, mode: 'stress', artifactDir: root, deviceRuns: [device] };
  assert.deepEqual(await readTaskStepEvidence(task, activeInput), {
    screenshot: `data:image/png;base64,${png.toString('base64')}`, logText: 'device log', logTruncated: false,
  });
  const otherDevice = { ...task, deviceRuns: [...task.deviceRuns, { deviceId: 'B', steps: [{ ...selected }] }] };
  const conflict = { ...none, artifactConflict: true };
  assert.deepEqual(await readTaskStepEvidence(otherDevice, activeInput), conflict);
  for (const other of [{ index: 2 }, { id: 'other' }, { roundIndex: 2 }]) {
    const otherStep = { ...task, deviceRuns: [{ ...device, steps: [selected, { ...selected, ...other }] }] };
    assert.deepEqual(await readTaskStepEvidence(otherStep, activeInput), conflict);
  }
  if (process.platform === 'win32') {
    const alias = { ...task, deviceRuns: [...task.deviceRuns, { deviceId: 'B', steps: [{ ...selected, artifact: log.toUpperCase(), screenshotArtifact: shot.toUpperCase() }] }] };
    assert.deepEqual(await readTaskStepEvidence(alias, activeInput), conflict);
  }
});
