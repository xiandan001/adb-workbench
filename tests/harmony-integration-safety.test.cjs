const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(predicate) { for (let index = 0; index < 30; index++) { if (predicate()) return; await tick(); } assert.fail('Fixture did not settle'); }
function workerFixture() {
  const file = path.resolve(__dirname, '../electron/lib/performance-worker.cjs'), requireFromFile = createRequire(file);
  const port = new EventEmitter(), responses = [], calls = [], module = { exports: {} };
  port.postMessage = response => responses.push(response);
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.cache = lastSnapshotByDevice;', {
    module, require(name) {
      if (name === 'worker_threads') return { parentPort: port, workerData: {} };
      if (name === 'child_process') return { execFile() { assert.fail('No device process in fixtures'); } };
      if (name === './harmony-metrics.cjs') return { collectHarmonySnapshot: (deviceId, options) => new Promise(resolve => calls.push({ deviceId, options,
        finish() { resolve({ deviceId, generation: options.deviceRef.generation, timestamp: Date.now(), cpu: { usage: null }, memory: { usage: null }, battery: { temperature: null }, thermal: { hottest: null }, disk: [] }); } })) };
      return requireFromFile(name);
    }, AbortController, Buffer, Date, console, setInterval: () => 1, clearInterval() {}
  }, { filename: file });
  const send = (id, generation, action = 'snapshot') => port.emit('message', { action, id, deviceId: 'hdc:fixture',
    deviceRef: { id: 'hdc:fixture', targetKey: 'fixture', transport: 'hdc', status: 'device', generation }, hdcPath: 'C:/fixture/hdc.exe' });
  return { calls, responses, send, cache: module.exports.cache };
}

test('in-flight Harmony snapshots never coalesce across generations and late old data cannot overwrite the cache', async () => {
  const f = workerFixture();
  f.send('old', 1); await settle(() => f.calls.length === 1);
  f.send('new', 2); await settle(() => f.calls.length === 2);
  f.calls[1].finish(); await settle(() => f.responses.some(item => item.id === 'new'));
  assert.equal(f.responses.find(item => item.id === 'new').snapshot.generation, 2);
  f.calls[0].finish(); await settle(() => f.responses.some(item => item.id === 'old'));
  assert.equal(f.responses.find(item => item.id === 'old').ok, false);
  assert.equal(f.cache.get('hdc:fixture').generation, 2);
  f.send('stale', 1); await settle(() => f.responses.some(item => item.id === 'stale'));
  assert.equal(f.responses.find(item => item.id === 'stale').ok, false); assert.equal(f.calls.length, 2);
});

test('same-generation Harmony requests still share one bounded read', async () => {
  const f = workerFixture();
  f.send('first', 3); f.send('second', 3); await settle(() => f.calls.length === 1);
  await tick(); assert.equal(f.calls.length, 1);
  f.calls[0].finish(); await settle(() => f.responses.length === 2);
  assert.ok(f.responses.every(item => item.ok && item.snapshot.generation === 3));
});

test('a new Harmony monitor does not reuse a prior-generation one-shot cache', async () => {
  const f = workerFixture();
  f.send('first', 1); await settle(() => f.calls.length === 1); f.calls[0].finish(); await settle(() => f.responses.length === 1);
  f.send('monitor', 2, 'start'); await settle(() => f.calls.length === 2);
  f.send('snapshot', 2); await settle(() => f.calls.length === 3);
  assert.ok(!f.responses.some(item => item.id === 'snapshot'));
  f.calls[2].finish(); await settle(() => f.responses.some(item => item.id === 'snapshot'));
  assert.equal(f.responses.find(item => item.id === 'snapshot').snapshot.generation, 2);
  f.calls[1].finish(); await tick(); f.send('stop', 2, 'stop');
});

test('model enrichment clones frozen descriptors and retains legacy Android getprop behavior', async () => {
  const file = path.resolve(__dirname, '../electron/lib/adb.cjs'), requireFromFile = createRequire(file), module = { exports: {} }, calls = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.enrich = fillMissingDeviceModels;', {
    module, Buffer, console, require(name) {
      if (name === './localization.cjs' || name === './device-platform.cjs' || name === './adb-device-parser.cjs') return requireFromFile(name);
      if (name === './adb-runtime.cjs') return { runAdb: async args => { calls.push(args); return { ok: true, stdout: args[1].startsWith('hdc:') ? 'Harmony Model' : 'Android Model' }; } };
      if (name.startsWith('.')) return {};
      return requireFromFile(name);
    }
  }, { filename: file });
  const android = Object.freeze({ id: 'legacy', status: 'device', model: '' });
  const harmony = Object.freeze({ id: 'hdc:native', status: 'device', model: '' });
  const offline = Object.freeze({ id: 'offline', status: 'offline', model: '' });
  const result = await module.exports.enrich([android, harmony, offline]);
  assert.equal(result[0].model, 'Android Model'); assert.equal(result[1].model, 'Harmony Model');
  assert.equal(android.model, ''); assert.equal(harmony.model, ''); assert.notEqual(result[0], android);
  assert.deepEqual(Array.from(calls[0]), ['-s', 'legacy', 'shell', 'getprop', 'ro.product.model']);
  assert.deepEqual(Array.from(calls[1]), ['-s', 'hdc:native', 'shell', 'param', 'get', 'const.product.model']);
  assert.equal(calls.length, 2);
});

test('main-process performance caller rejects a connection change even without a newer worker request', async () => {
  const file = path.resolve(__dirname, '../electron/lib/performance-monitor.cjs'), requireFromFile = createRequire(file), module = { exports: {} };
  let generation = 1, finish;
  const waitForWorker = () => new Promise(resolve => { finish = resolve; });
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nrequestWorker = fixtureRequest; readThresholds = () => ({});', {
    module, fixtureRequest: waitForWorker, Buffer, console, require(name) {
      if (name === './localization.cjs' || name === './device-platform.cjs') return requireFromFile(name);
      if (name === './device-registry.cjs') return { resolveDeviceRef: () => ({ id: 'hdc:fixture', generation }) };
      if (name === './hdc-runtime.cjs') return { getHdcCommand: () => 'C:/fixture/hdc.exe' };
      if (name === './adb-runtime.cjs') return { getAdbCommand: () => 'fixture-adb' };
      if (name === 'electron') return {};
      if (name.startsWith('.')) return {};
      return requireFromFile(name);
    }
  }, { filename: file });
  const pending = module.exports.collectSnapshot('hdc:fixture', false);
  await settle(() => Boolean(finish)); generation = 2;
  finish({ ok: true, snapshot: { generation: 1, cpu: { usage: 10 } } });
  await assert.rejects(pending, /设备连接已变化/);
});

test('Harmony shortcut editor offers native examples and platform-scoped saving without replacing Android guidance', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/components/DeviceShortcutEditor.jsx'), 'utf8');
  assert.match(source, /uitest uiInput keyEvent Back/);
  assert.match(source, /例如 input keyevent KEYCODE_BACK/);
  assert.match(source, /HDC shell 命令/); assert.match(source, /ADB shell 命令/);
  assert.match(source, /保存到鸿蒙设备/);
});
