const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverDevices } = require('../electron/lib/device-discovery.cjs');
const { connectDevice, disconnectDevice, connectionAddress } = require('../electron/lib/device-connection.cjs');
const { registerDiscoveredDevices } = require('../electron/lib/device-registry.cjs');
const { collectHarmonySnapshot, parseHarmonyMemory, parseHarmonyDisk, parseHarmonyProcesses, parseHarmonyBattery, parseHarmonyThermal } = require('../electron/lib/harmony-metrics.cjs');
const { listHarmonyDirectory, parseDirectory } = require('../electron/lib/harmony-files.cjs');

const ok = stdout => ({ ok: true, stdout, stderr: '' });
const ref = { id: 'hdc:metric-target', targetKey: 'metric-target', platform: 'harmony', transport: 'hdc', status: 'device', generation: 3 };

test('independent discovery retains both same-serial devices and excludes UART Ready channels', async () => {
  const result = await discoverDevices({
    readAdb: async () => ok('List of devices attached\nSHARED device product:p model:Android_Board\n'),
    readHdcHost: async () => ok('SHARED USB Connected Harmony hdc\nCOM4 UART Ready hdc\n'),
    readHdc: async id => { assert.equal(id, 'hdc:SHARED'); return ok('__AWB_MODEL__Native Board\n__AWB_API__18\n__AWB_TOOL__uitest\n__AWB_TOOL__hilog\n__AWB_METRICS__\n'); }
  });
  assert.deepEqual(result.devices.map(item => item.id), ['SHARED', 'hdc:SHARED']);
  assert.equal(result.unconnectedTargets[0].id, 'hdc:COM4');
  assert.equal(result.devices[1].capabilities.recording, null);
  assert.equal(result.devices[1].capabilities.performance, true);
  const partial = await discoverDevices({ readAdb: async () => { throw new Error('no adb'); }, readHdcHost: async () => ok('[Empty]') });
  assert.equal(partial.available, true);
  assert.match(partial.errors.adb, /no adb/);
});

test('wireless fallback uses native connection only after Android fails and verifies the exact authorized target', async () => {
  const calls = [];
  const options = { runAdb: async args => { calls.push(args); return { ok: false }; }, runHdcHost: async args => { calls.push(args); return ok('Connect OK'); },
    discoverDevices: async () => ({ devices: [{ id: 'hdc:192.168.1.2:5555', status: 'unauthorized' }] }) };
  assert.equal((await connectDevice('192.168.1.2:5555', options)).success, false);
  options.discoverDevices = async () => ({ devices: [{ id: 'hdc:192.168.1.2:5555', status: 'device' }] });
  assert.equal((await connectDevice('hdc:192.168.1.2:5555', options)).deviceId, 'hdc:192.168.1.2:5555');
  assert.equal(calls.filter(args => args[0] === 'connect').length, 1);
  assert.equal(connectionAddress('[::1]:1234'), '[::1]:1234');
  for (const address of ['bad host', '-t:5555', 'host:0', 'host:99999', 'host:5555 shell false']) assert.throws(() => connectionAddress(address));
});

test('Android bare IP and legacy history addresses retain the ADB default port without trying HDC', async () => {
  assert.equal(connectionAddress('172.20.74.121'), '172.20.74.121:5555');
  assert.equal(connectionAddress('localhost'), 'localhost:5555');
  assert.equal(connectionAddress('[::1]'), '[::1]:5555');
  assert.equal(connectionAddress('172.20.74.121:6666'), '172.20.74.121:6666');
  const calls = [];
  const result = await connectDevice('172.20.74.121', {
    runAdb: async args => { calls.push(args); return ok('connected to 172.20.74.121:5555'); },
    runHdcHost: async () => assert.fail('Successful Android connect must not switch transport')
  });
  assert.equal(result.success, true); assert.equal(result.deviceId, '172.20.74.121:5555');
  assert.deepEqual(calls, [['connect', '172.20.74.121:5555']]);
  for (const address of ['999.20.74.121', '172.20.74.121:0', '[not:ipv6]', 'hdc:172.20.74.121']) assert.throws(() => connectionAddress(address));
});

test('disconnect never kills shared HDC services or disconnects unrelated transports', async () => {
  registerDiscoveredDevices('hdc', [{ id: 'hdc:wire', targetKey: 'wire', status: 'device', connectionType: 'usb' },
    { id: 'hdc:192.168.0.2:1000', targetKey: '192.168.0.2:1000', status: 'device', connectionType: 'tcp' }]);
  const calls = [], options = { runHdcHost: async args => { calls.push(args); return ok('removed'); } };
  assert.equal((await disconnectDevice('hdc:wire', options)).success, false);
  assert.equal(calls.length, 0);
  assert.equal((await disconnectDevice('hdc:192.168.0.2:1000', options)).success, true);
  assert.deepEqual(calls, [['tconn', '192.168.0.2:1000', '-remove']]);
});

test('native metric samples use counter deltas and never reuse healthy values after failed reads', async () => {
  let ticks = 'cpu 100 0 100 800 0 0 0 0';
  const runHdc = async (id, args) => { assert.equal(id, ref.id); assert.doesNotMatch(args.join(' '), /dumpsys|SurfaceFlinger|logcat/);
    return ok(`__AWB_HOS_CPU__\n${ticks}\n__AWB_HOS_MEMORY__\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n__AWB_HOS_DISK__\n/dev/data 100 20 80 20% /data\n`); };
  const first = await collectHarmonySnapshot(ref.id, { deviceRef: ref, runHdc });
  assert.equal(first.cpu.usage, null);
  assert.equal(first.memory.usage, 75);
  assert.equal(first.battery.present, null);
  ticks = 'cpu 150 0 150 900 0 0 0 0';
  const second = await collectHarmonySnapshot(ref.id, { deviceRef: ref, runHdc });
  assert.equal(second.cpu.usage, 50);
  const failed = await collectHarmonySnapshot(ref.id, { deviceRef: ref, runHdc: async () => ({ ok: false, error: 'denied' }) });
  assert.equal(failed.cpu.usage, null);
  assert.equal(failed.memory.usage, null);
  assert.equal(failed.fps.foreground.fps, null);
  assert.deepEqual(failed.disk, []);
  assert.equal(failed.sampleError, 'denied');
});

test('native parsers reject missing metrics, preserve process names, and handle files without ls date assumptions', async () => {
  assert.equal(parseHarmonyMemory('').usage, null);
  assert.deepEqual(parseHarmonyDisk('Filesystem 1K-blocks Used Available Use% Mounted on'), []);
  assert.equal(parseHarmonyProcesses('UID PID PPID C STIME TTY TIME CMD\nroot 12 1 0 12:00 ? 00:00 foo --bar')[0].name, 'foo --bar');
  const files = parseDirectory(['f', 'file with spaces.hap', '1024', 'd', 'folder', '', 'l', 'a -> b', '16', ''].join('\0'), '/data/local/tmp');
  assert.ok(files.some(item => item.name === 'file with spaces.hap' && item.size === '1024'));
  const result = await listHarmonyDirectory(ref.id, "/data/a'b", { runHdc: async (_id, args) => { assert.match(args[1], /cd '\/data\/a'\\''b'/); return { ok: false, error: 'denied' }; } });
  assert.equal(result.success, false);
});

test('native battery and thermal data retain documented sysfs units and missing values', () => {
  assert.equal(parseHarmonyBattery('capacity=80\ntemp=321\npresent=1').temperature, 32.1);
  assert.equal(parseHarmonyBattery('capacity=200\ntemp=\n').level, null);
  assert.equal(parseHarmonyBattery('').present, null);
  const thermal = parseHarmonyThermal('/sys/class/thermal/thermal_zone0|soc |42000\n/sys/class/thermal/thermal_zone1|bad|999999');
  assert.equal(thermal.hottest, 42);
  assert.equal(thermal.sensors.length, 1);
});

test('native performance worker pins command paths and cancellation to each monitor', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const filename = path.resolve(__dirname, '../electron/lib/performance-worker.cjs');
  const originalRequire = createRequire(filename), events = new EventEmitter(), responses = [], calls = [];
  events.postMessage = value => responses.push(value);
  const native = async (id, options) => {
    calls.push({ id, options });
    return { timestamp: Date.now(), deviceId: id, cpu: { usage: null }, memory: { usage: null }, battery: { temperature: null }, thermal: { hottest: null }, disk: [] };
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require(name) {
    if (name === 'worker_threads') return { parentPort: events, workerData: {} };
    if (name === './harmony-metrics.cjs') return { collectHarmonySnapshot: native };
    if (name === 'child_process') return { execFile() { throw new Error('Android command must not run for a Harmony monitor'); } };
    return originalRequire(name);
  }, AbortController, Buffer, Date, console, setInterval: () => 1, clearInterval() {} }, { filename });
  const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
  const second = { ...ref, id: 'hdc:other', targetKey: 'other' };
  events.emit('message', { action: 'start', id: 'start1', deviceId: ref.id, deviceRef: ref, hdcPath: 'C:/first/hdc.exe' });
  events.emit('message', { action: 'start', id: 'start2', deviceId: second.id, deviceRef: second, hdcPath: 'C:/second/hdc.exe' });
  await flush();
  assert.deepEqual(calls.map(item => [item.id, item.options.command]), [[ref.id, 'C:/first/hdc.exe'], [second.id, 'C:/second/hdc.exe']]);
  events.emit('message', { action: 'stop', id: 'stop1', deviceId: ref.id }); await flush();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[1].options.signal.aborted, false);
  events.emit('message', { action: 'snapshot', id: 'new-generation', deviceId: second.id, deviceRef: { ...second, generation: 4 } }); await flush();
  assert.equal(responses.find(item => item.id === 'new-generation').ok, false);
  assert.equal(calls[1].options.signal.aborted, true);
});
