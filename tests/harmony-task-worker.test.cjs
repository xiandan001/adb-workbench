const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function workerModel() {
  const filename = path.resolve(__dirname, '../electron/lib/task-center-worker.cjs'), actualRequire = createRequire(filename);
  const state = { processes: [], native: [], jobs: [], devices: [], identities: new Map(), host: [] };
  const model = { Buffer, console, process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    require(name) {
      if (name === 'worker_threads') return { parentPort: { on() {}, postMessage() {} }, workerData: { adbPath: '/fixture/default-adb' } };
      if (name === 'child_process') return { execFile(command, args, options, done) {
        const child = { stdin: { end() {} }, killed: false, kill() { this.killed = true; } };
        state.processes.push({ command, args, options, child }); setImmediate(() => done(null, 'fixture output', '')); return child;
      } };
      if (name === './harmony-task-execution.cjs') return {
        ...actualRequire(name),
        executeHarmonyCoreStep: async (task, id) => { state.native.push({ id, command: task.hdcPath, ref: task.deviceRefs[id] }); return { ok: true }; },
        readHarmonyIdentity: async (_task, id) => ({ transport: 'hdc', harmonyUdid: state.identities.get(id) || '' })
      };
      if (name === './hdc-runtime.cjs') return { runHdc: async () => ({ ok: true }), runHdcHost: async (args, options) => { state.host.push({ args, options }); return { ok: true }; } };
      if (name === './device-discovery.cjs') return { listDevices: async options => { state.discovery = options; return state.devices; } };
      return actualRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), model, { filename });
  model.runTask = async task => { state.jobs.push(task); };
  model.broadcastTask = () => {};
  model.getDeviceRebindTimeout = () => 0;
  return { model, state };
}

function task(id, deviceId, harmony = false) {
  return { id, scriptName: id, script: { id: `${id}-script`, mode: 'replay', ...(harmony ? { targetPlatform: 'harmony' } : {}), steps: [{ id: 'shell', type: 'shell', command: 'fixture only' }] },
    deviceRefs: harmony ? { [deviceId]: { id: deviceId, targetKey: deviceId.slice(4), transport: 'hdc', status: 'device' } } : {},
    deviceRuns: [{ deviceId, originalDeviceId: deviceId, steps: [], status: 'queued' }], logs: [], status: 'queued' };
}

test('mixed worker jobs retain their own command paths and target descriptor instead of a mutable current backend', async () => {
  const h = workerModel();
  await h.model.handleWorkerMessage({ action: 'run', adbPath: '/fixture/adb-A', task: task('android', 'A') });
  await h.model.handleWorkerMessage({ action: 'run', adbPath: '/fixture/adb-B', hdcPath: '/fixture/hdc-B', task: task('harmony', 'hdc:A', true) });
  const [android, harmony] = h.state.jobs;
  await Promise.all([h.model.executeStep(android, 'A', android.script.steps[0]), h.model.executeStep(harmony, 'hdc:A', harmony.script.steps[0])]);
  assert.equal(h.state.processes[0].command, '/fixture/adb-A');
  assert.equal(h.state.native[0].command, '/fixture/hdc-B');
  assert.equal(h.state.native[0].ref.targetKey, 'A');
  assert.equal(android.adbPath, '/fixture/adb-A');
  assert.equal(harmony.adbPath, '/fixture/adb-B');
  const owned = { killed: false, kill() { this.killed = true; } };
  android.procs.add(owned);
  await h.model.handleWorkerMessage({ action: 'cancel', taskId: android.id });
  assert.equal(owned.killed, true); assert.equal(android.cancelled, true); assert.equal(harmony.cancelled, false);
});

test('Harmony reconnect requires a unique same-platform UDID; a lone different or Android target never substitutes', async () => {
  const h = workerModel(), job = task('harmony', 'hdc:old', true), run = job.deviceRuns[0];
  run.deviceIdentity = { transport: 'hdc', harmonyUdid: '1234abcd' };
  h.state.devices = [{ id: 'hdc:new', targetKey: 'new', transport: 'hdc', status: 'device' }];
  h.state.identities.set('hdc:new', '1234abcd');
  assert.equal(await h.model.resolveRunDeviceId(job, run, { type: 'shell' }), 'hdc:new');
  assert.equal(job.deviceRefs['hdc:new'].targetKey, 'new');
  run.deviceId = 'hdc:old';
  h.state.identities.set('hdc:new', 'different');
  await assert.rejects(h.model.resolveRunDeviceId(job, run, { type: 'shell' }), /UDID/);
  h.state.devices = [{ id: 'android-target', transport: 'adb', status: 'device' }];
  await assert.rejects(h.model.resolveRunDeviceId(job, run, { type: 'shell' }), /UDID/);
  h.state.devices = [{ id: 'hdc:new', targetKey: 'new', transport: 'hdc', status: 'device' }];
  run.deviceIdentity = { transport: 'hdc', harmonyUdid: '' };
  await assert.rejects(h.model.resolveRunDeviceId(job, run, { type: 'shell' }), /UDID/);
  assert.equal(h.state.native.length, 0);
});

test('same Harmony connection can operate without a reported UDID but identity changes stop subsequent execution', async () => {
  const h = workerModel(), job = task('harmony', 'hdc:old', true), run = job.deviceRuns[0];
  h.state.devices = [job.deviceRefs['hdc:old']];
  assert.equal(await h.model.resolveRunDeviceId(job, run, { type: 'shell' }), 'hdc:old');
  assert.equal(run.deviceIdentity.harmonyUdid, '');
  run.deviceIdentity.harmonyUdid = '1234abcd'; h.state.identities.set('hdc:old', '9876abcd');
  await assert.rejects(h.model.resolveRunDeviceId(job, run, { type: 'shell' }), /身份/);
  const blocked = await h.model.runAdb(job, ['-s', 'hdc:old', 'shell', 'input keyevent 3']);
  assert.equal(blocked.ok, false); assert.equal(h.state.processes.length, 0);
});
