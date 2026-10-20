const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadWorkerModel() {
  const filename = path.resolve(__dirname, '../electron/lib/task-center-worker.cjs');
  const localRequire = createRequire(filename);
  const context = {
    require(name) {
      if (name === 'worker_threads') return { parentPort: { on() {}, postMessage() {} }, workerData: {} };
      if (name === 'child_process') return { execFile() { throw new Error('Tests must never execute ADB or shell commands'); } };
      return localRequire(name);
    },
    console, process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  context.broadcastTask = () => {};
  context.getDeviceRebindTimeout = () => 0;
  return context;
}

function createRun(identity, candidateIdentity) {
  const run = { deviceId: 'original', originalDeviceId: 'original', deviceIdentity: identity, steps: [] };
  return {
    run,
    task: {
      id: 'synthetic', deviceRuns: [run], deviceIdentityCache: new Map([['candidate', candidateIdentity]]),
      logs: [], completedSteps: 0, failedSteps: 0, continueOnError: false,
      script: { steps: [{ id: 'step', type: 'shell', label: '受保护步骤', command: 'never-executed' }] }
    }
  };
}

test('same strong identity reconnects and continues on the new transport', async () => {
  const model = loadWorkerModel();
  const { task, run } = createRun({ roSerialno: 'serial-A' }, { roSerialno: 'serial-A' });
  model.listOnlineAdbDevices = async () => [{ id: 'candidate', status: 'device' }];
  let executedDevice = '';
  model.executeStep = async (_task, deviceId) => { executedDevice = deviceId; return { ok: true }; };
  await model.runDevice(task, run);
  assert.equal(executedDevice, 'candidate');
  assert.equal(run.status, 'success');
});

for (const [name, expected, candidate] of [
  ['only another device remains', { roSerialno: 'serial-A' }, { roSerialno: 'serial-B' }],
  ['same model is not identity', { model: 'Same', manufacturer: 'Same' }, { model: 'Same', manufacturer: 'Same' }],
  ['conflicting strong identity is not accepted', { roSerialno: 'A', androidId: 'shared' }, { roSerialno: 'B', androidId: 'shared' }],
  ['no useful original identity', {}, { roSerialno: 'B' }]
]) {
  test(name, async () => {
    const model = loadWorkerModel();
    const { task, run } = createRun(expected, candidate);
    model.listOnlineAdbDevices = async () => [{ id: 'candidate', status: 'device' }];
    let executed = false;
    model.executeStep = async () => { executed = true; return { ok: true }; };
    await model.runDevice(task, run);
    assert.equal(executed, false);
    assert.equal(run.deviceId, 'original');
    assert.equal(run.status, 'failed');
    assert.match(run.steps[0].error, /同一台设备/);
  });
}
