const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createRunComparisonIdentity, deviceComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');
const { captureRunSnapshot } = require('../electron/lib/task-rerun.cjs');

test('actual worker preserves script, step, and hashed device identity through progress, completion, and disk manifest without ADB', { timeout: 10000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-comparison-worker-'));
  const worker = new Worker(path.join(__dirname, '../electron/lib/task-center-worker.cjs'), {
    workerData: { adbPath: path.join(directory, 'forbidden-adb-does-not-exist.exe'), defaultArtifactBaseDir: directory }
  });
  t.after(async () => { await worker.terminate(); fs.rmSync(directory, { recursive: true, force: true }); });
  const script = { id: 'saved-delay-script', name: '比较元数据验证', mode: 'replay', steps: [{ id: 'wait-one', type: 'delay', label: '等待', durationMs: 100 }] };
  const deviceIdentity = { androidId: 'abcdef1234567890', roSerialno: 'test-device-unique' };
  const expected = createRunComparisonIdentity(script, { concurrency: 1, continueOnError: true });
  const rerunSnapshot = await captureRunSnapshot(script, { concurrency: 1, continueOnError: true });
  const analysisOrigin = { question: 'Synthetic original question', summary: 'Unverified fixture hypothesis' };
  const snapshots = [];
  const completed = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.type === 'progress') snapshots.push(message.task);
      if (message.type === 'workerError') reject(new Error(message.error));
      if (message.type === 'done') resolve(message.task);
    });
  });
  worker.postMessage({ action: 'run', task: {
    id: 'comparison-worker-test', script, scriptName: script.name, status: 'queued', createdAt: new Date().toISOString(), rerunSnapshot, analysisOrigin,
    concurrency: 1, continueOnError: true, artifactBaseDir: directory, completedSteps: 0, failedSteps: 0, totalSteps: 1,
    logs: [], deviceRuns: [{ deviceId: 'fake-device', deviceIdentity, status: 'queued', steps: [], stressRounds: [] }]
  } });
  const record = await completed;
  assert.equal(record.status, 'success');
  assert.equal(record.scriptId, script.id);
  assert.equal(record.scriptHash, expected.scriptHash);
  assert.equal(record.comparisonVersion, 1);
  assert.deepEqual(record.scriptSteps, expected.scriptSteps);
  assert.deepEqual(record.deviceRuns[0].comparisonIdentity, deviceComparisonIdentity(deviceIdentity));
  assert.equal(record.deviceRuns[0].steps[0].id, 'wait-one');
  assert.equal(record.deviceRuns[0].steps[0].status, 'success');
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every(snapshot => snapshot.scriptHash === expected.scriptHash));
  assert.ok(snapshots.every(snapshot => snapshot.rerunSnapshot === undefined));
  assert.equal(record.rerunSnapshot, undefined);
  assert.equal(record.analysisOrigin.question, analysisOrigin.question);
  const manifest = JSON.parse(fs.readFileSync(record.runResultPath, 'utf8'));
  assert.equal(manifest.scriptHash, record.scriptHash);
  assert.deepEqual(manifest.deviceRuns[0].comparisonIdentity, record.deviceRuns[0].comparisonIdentity);
  assert.ok(!JSON.stringify(manifest).includes(deviceIdentity.roSerialno));
  assert.deepEqual(manifest.rerunSnapshot, rerunSnapshot);
  assert.deepEqual(manifest.analysisOrigin, analysisOrigin);
  assert.match(manifest.inputHash, /^[a-f0-9]{64}$/);
});
