const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { discoverDevices } = require('../electron/lib/device-discovery.cjs');
const { resolveDeviceRef, registerDiscoveredDevices } = require('../electron/lib/device-registry.cjs');
const { runAdb } = require('../electron/lib/adb-runtime.cjs');

const ok = stdout => ({ ok: true, stdout });
const androidList = 'List of devices attached\nUSB_A device model:Android_Board';
const emptyAndroidList = 'List of devices attached\n';
const nativeList = 'native-A USB Connected Board hdc';

test('shows Android without waiting for HDC or either board metadata query', async () => {
  let releaseHdc, releaseModel;
  const hdc = new Promise(resolve => { releaseHdc = resolve; });
  const model = new Promise(resolve => { releaseModel = resolve; });
  const progress = [];
  const request = discoverDevices({
    readAdb: async () => ok(androidList), readHdcHost: () => hdc, readHdc: () => model
  }, snapshot => progress.push(snapshot));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0].channels, { adb: 'ready', hdc: 'pending' });
  assert.deepEqual(progress[0].devices.map(device => device.id), ['USB_A']);

  releaseHdc(ok(nativeList));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(progress[1].channels, { adb: 'ready', hdc: 'ready' });
  assert.equal(progress[1].devices.at(-1).id, 'hdc:native-A');
  releaseModel(ok('__AWB_MODEL__Detailed Board\n__AWB_API__18\n__AWB_TOOL__hilog\n'));
  const final = await request;
  assert.deepEqual(final.devices.map(device => device.id), ['USB_A', 'hdc:native-A']);
  assert.equal(final.devices.at(-1).model, 'Detailed Board');
  assert.equal(final.devices.at(-1).capabilities.logs, true);
});

test('partial / total failure keeps known IDs and genuine connection generations; confirmed absence removes a target', async () => {
  await discoverDevices({
    readAdb: async () => ok(androidList), readHdcHost: async () => ok(nativeList),
    readHdc: async () => ok('__AWB_MODEL__Detailed Board')
  });
  const originalAndroid = resolveDeviceRef('USB_A');
  const originalNative = resolveDeviceRef('hdc:native-A');
  const timeout = async () => ({ ok: false, timedOut: true, error: 'timed out' });
  const updated = await discoverDevices({ readAdb: timeout, readHdcHost: async () => ok(nativeList) });
  assert.deepEqual(updated.channels, { adb: 'unconfirmed', hdc: 'ready' });
  assert.equal(updated.devices[0].status, 'unconfirmed');
  assert.equal(updated.devices[0].generation, originalAndroid.generation);
  assert.equal(updated.devices[1].status, 'device');
  const run = await runAdb(['-s', 'USB_A', 'shell', 'getprop'], { queue: false });
  assert.equal(run.code, 'DEVICE_UNCONFIRMED');
  assert.equal(run.ok, false);

  const both = await discoverDevices({ readAdb: async () => ok('daemon started but device list missing'), readHdcHost: timeout });
  assert.equal(both.available, false);
  assert.deepEqual(both.devices.map(row => row.status), ['unconfirmed', 'unconfirmed']);
  assert.throws(() => resolveDeviceRef(originalNative.id, { deviceRef: originalNative }), { code: 'DEVICE_UNCONFIRMED' });

  const recovered = await discoverDevices({ readAdb: async () => ok(androidList), readHdcHost: async () => ok(nativeList) });
  assert.deepEqual(recovered.devices.map(device => device.generation), [originalAndroid.generation, originalNative.generation]);
  assert.deepEqual(recovered.devices.map(device => device.status), ['device', 'device']);
  await discoverDevices({ readAdb: timeout, readHdcHost: timeout });
  const removed = await discoverDevices({ readAdb: async () => ok(emptyAndroidList), readHdcHost: async () => ok('[Empty]') });
  assert.deepEqual(removed.devices, []);
  assert.deepEqual(removed.channels, { adb: 'ready', hdc: 'ready' });
  assert.throws(() => resolveDeviceRef(originalNative.id), { code: 'DEVICE_OFFLINE' });
  assert.equal(resolveDeviceRef(originalNative.id, { allowOffline: true }).generation, originalNative.generation + 1);
});

test('old all-success list consumers keep descriptors and HDC metadata', async () => {
  const readAdb = async () => ok(androidList);
  const readHdcHost = async () => ok(nativeList);
  const readHdc = async () => ok('__AWB_MODEL__Detailed Board\n__AWB_API__18\n');
  registerDiscoveredDevices('hdc', []);
  const devices = await require('../electron/lib/device-discovery.cjs').listDevices({ readAdb, readHdcHost, readHdc });
  assert.ok(Array.isArray(devices));
  assert.equal(devices[0].model, 'Android_Board');
  assert.equal(devices[1].model, 'Detailed Board');
  assert.equal(devices[1].apiVersion, 18);
});

test('preload associates progress with one outstanding call and releases listeners on failure', async () => {
  const ipcRenderer = new EventEmitter(), received = [];
  const pending = new Map();
  ipcRenderer.invoke = (channel, id) => {
    assert.equal(channel, 'adb:getDevices');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  let api;
  const source = readFileSync(require.resolve('../electron/preload.cjs'), 'utf8');
  runInNewContext(source, {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } } }), console
  });
  const a = api.getDevices(message => received.push(['a', message]));
  const b = api.getDevices(message => received.push(['b', message]));
  ipcRenderer.emit('adb:devicesProgress', {}, 1, 'first');
  ipcRenderer.emit('adb:devicesProgress', {}, 2, 'second');
  ipcRenderer.emit('adb:devicesProgress', {}, 3, 'unknown');
  assert.deepEqual(received, [['a', 'first'], ['b', 'second']]);
  pending.get(1).resolve('finished'); pending.get(2).reject(new Error('lost'));
  assert.equal(await a, 'finished');
  await assert.rejects(b, /lost/);
  assert.equal(ipcRenderer.listenerCount('adb:devicesProgress'), 0);
});

test('main-process progress is sent only to its original top-level owner and legacy results stay arrays', async () => {
  const { parse } = require('@babel/parser');
  const file = require.resolve('../electron/lib/adb.cjs');
  const source = readFileSync(file, 'utf8');
  const register = parse(source).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'register');
  const callback = register.body.body.find(node => node.expression?.arguments?.[0]?.value === 'adb:getDevices').expression.arguments[1];
  const rows = [{ id: 'USB_A', status: 'device' }];
  const channels = { adb: 'ready', hdc: 'unconfirmed' };
  const sent = [];
  const ownerFrame = { send: (...args) => sent.push(args) };
  const ownerContents = { mainFrame: ownerFrame };
  const execute = runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
    require: name => ({
      './app-context.cjs': { getMainWindow: () => ({ webContents: ownerContents }) },
      './device-discovery.cjs': { discoverDevices: async (_options, progress) => {
        const snapshot = { available: true, devices: rows, channels };
        progress?.(snapshot);
        return snapshot;
      } },
      './performance-monitor.cjs': { syncDeviceConnections: () => {} }
    }[name]),
    fillMissingDeviceModels: async devices => devices
  });
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(await execute({ sender: ownerContents, senderFrame: ownerFrame }, 42)), { devices: rows, channels });
  assert.deepEqual(normalize(sent), [['adb:devicesProgress', 42, { devices: rows, channels }]]);
  const otherFrame = { send: () => assert.fail('Progress must not reach a different renderer') };
  assert.deepEqual(await execute({ sender: { mainFrame: otherFrame }, senderFrame: otherFrame }, 43), rows);
  assert.deepEqual(await execute({ sender: ownerContents, senderFrame: otherFrame }, 44), rows);
  assert.deepEqual(await execute({ sender: ownerContents, senderFrame: ownerFrame }), rows);
  assert.equal(sent.length, 1);
});
