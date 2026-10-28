const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { captureRunSnapshot, createTaskRerunService, fingerprintInputs, hashInput, validateSnapshot, TTL } = require('../electron/lib/task-rerun.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-task-rerun-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-task-rerun-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'fixture.apk'); fs.writeFileSync(filename, 'original fixture bytes');
  const script = { id: 'fixture-script', name: 'original script', continueOnError: false, mode: 'replay', steps: [{ id: 'install', type: 'installApk', localPath: filename }, { id: 'shot', type: 'screenshot' }] };
  return { directory, filename, script };
}
async function harness(t, overrides = {}) {
  const f = fixture(t), started = [];
  const snapshot = await captureRunSnapshot(f.script);
  const record = { id: 'fixture-run', status: 'failed', rerunSnapshot: snapshot, deviceRuns: [{ deviceId: 'fixture-A', status: 'success' }, { deviceId: 'fixture-B', status: 'failed', steps: [{ status: 'failed' }] }] };
  let now = 1000;
  const deps = { getRun: async () => record, getOnlineDevices: async () => [{ id: 'fixture-A', status: 'device' }, { id: 'fixture-B', status: 'device' }], confirm: async () => true,
    verifyDevices: async () => true, startRun: async (...args) => { started.push(args); return { task: { id: 'new-run' } }; }, now: () => now, ...overrides };
  return { ...f, record, started, service: createTaskRerunService(deps), deps, advance: ms => { now += ms; } };
}

test('snapshot hashes real file bytes and preserves immutable script content after editor changes', async t => {
  const f = fixture(t), snapshot = await captureRunSnapshot(f.script);
  f.script.name = 'edited later'; f.script.steps[0].localPath = 'renderer-unknown';
  assert.equal(snapshot.script.name, 'original script'); assert.equal(snapshot.inputs[0].sha256, createHash('sha256').update('original fixture bytes').digest('hex'));
  assert.equal(validateSnapshot(snapshot).script.steps[0].localPath, f.filename);
  snapshot.script.name = 'tampered'; assert.throws(() => validateSnapshot(snapshot), { code: 'TASK_RERUN_INVALID' });
});

test('rerun includes only selected original failures, starts the complete snapshot and preserves the old record', async t => {
  const h = await harness(t); const original = JSON.stringify(h.record);
  const preview = await h.service.preview({ taskId: h.record.id }, 1);
  assert.deepEqual(preview.failedDeviceIds, ['fixture-B']); assert.equal(preview.fromStep, 1);
  assert.deepEqual(preview.script, h.record.rerunSnapshot.script); assert.equal(preview.script.steps[0].localPath, h.filename);
  preview.script.steps[0].localPath = 'renderer-tampered-preview';
  await assert.rejects(h.service.run({ previewId: preview.id, deviceIds: ['fixture-A'] }, 1), { code: 'TASK_RERUN_INVALID' });
  await assert.rejects(h.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 2), { code: 'TASK_RERUN_INVALID' });
  await h.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1);
  assert.equal(h.started.length, 1); assert.deepEqual(h.started[0][1], ['fixture-B']); assert.equal(h.started[0][0].steps.length, 2);
  assert.equal(h.started[0][0].steps[0].localPath, h.filename);
  assert.equal(h.started[0][3].parentTaskId, h.record.id); assert.equal(JSON.stringify(h.record), original);
  await assert.rejects(h.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1), { code: 'TASK_RERUN_INVALID' });
});

test('changed inputs require explicit acceptance and a second change after preview always invalidates consent', async t => {
  const h = await harness(t); fs.writeFileSync(h.filename, 'changed once');
  const preview = await h.service.preview({ taskId: h.record.id }, 1); assert.equal(preview.inputs[0].changed, true);
  await assert.rejects(h.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1), { code: 'TASK_INPUT_CHANGED' });
  fs.writeFileSync(h.filename, 'changed twice');
  await assert.rejects(h.service.run({ previewId: preview.id, deviceIds: ['fixture-B'], acceptInputChanges: true }, 1), { code: 'TASK_INPUT_CHANGED_AGAIN' });
  assert.equal(h.started.length, 0);
});

test('confirmation cancellation, owner loss, expiry and wrong physical device never start a rerun', async t => {
  const cancelled = await harness(t, { confirm: async () => false });
  let preview = await cancelled.service.preview({ taskId: cancelled.record.id }, 1);
  assert.equal((await cancelled.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1)).cancelled, true); assert.equal(cancelled.started.length, 0);
  const wrong = await harness(t, { verifyDevices: async () => false }); preview = await wrong.service.preview({ taskId: wrong.record.id }, 1);
  await assert.rejects(wrong.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1), { code: 'TASK_RERUN_DEVICE' });
  const expired = await harness(t); preview = await expired.service.preview({ taskId: expired.record.id }, 1); expired.advance(TTL);
  await assert.rejects(expired.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1), { code: 'TASK_RERUN_INVALID' });
  const closed = await harness(t); preview = await closed.service.preview({ taskId: closed.record.id }, 1); closed.service.clearOwner(1);
  await assert.rejects(closed.service.run({ previewId: preview.id, deviceIds: ['fixture-B'] }, 1), { code: 'TASK_RERUN_INVALID' });
});

test('legacy runs without a snapshot are unavailable and missing or symlink inputs do not execute', async t => {
  const h = await harness(t); delete h.record.rerunSnapshot;
  assert.equal((await h.service.preview({ taskId: h.record.id }, 1)).available, false);
  const missing = await harness(t); fs.unlinkSync(missing.filename);
  const preview = await missing.service.preview({ taskId: missing.record.id }, 1);
  assert.equal(preview.inputs[0].state, 'missing');
  await assert.rejects(missing.service.run({ previewId: preview.id, deviceIds: ['fixture-B'], acceptInputChanges: true }, 1), { code: 'TASK_INPUT_UNAVAILABLE' });
  const linked = await hashInput({ path: missing.filename }, { io: { promises: {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 10 }),
    open: async () => { throw new Error('A symlink must never be opened'); },
  } } });
  assert.equal(linked.state, 'unavailable');
});

test('streamed hashing is cancellable and keeps the UI loop responsive without loading large inputs at once', async t => {
  const f = fixture(t), buffer = Buffer.alloc(32 * 1024 * 1024, 65); fs.writeFileSync(f.filename, buffer);
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  try { const inputs = await fingerprintInputs(f.script); assert.equal(inputs[0].sha256, createHash('sha256').update(buffer).digest('hex')); assert.ok(ticks > 2); }
  finally { clearInterval(timer); }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fingerprintInputs(f.script, { signal: controller.signal }), { code: 'CANCELLED' });
});

test('repeated references to one input hash it once per snapshot, not once per task step', async t => {
  const f = fixture(t); let opens = 0;
  f.script.steps.push({ id: 'second-install', type: 'installApk', localPath: f.filename });
  const io = { ...fs, promises: { ...fs.promises, open: async (...args) => { opens++; return fs.promises.open(...args); } } };
  const inputs = await fingerprintInputs(f.script, { io });
  assert.equal(opens, 1); assert.equal(inputs.length, 2); assert.equal(inputs[0].sha256, inputs[1].sha256); assert.notEqual(inputs[0].stepId, inputs[1].stepId);
});
