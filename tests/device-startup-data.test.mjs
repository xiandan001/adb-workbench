import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolveActiveDeviceId } from '../src/shared/deviceWorkflow.js';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
let fetchCallback;
let initialDevices;
traverse(ast, {
  VariableDeclarator({ node }) {
    if (node.id.type === 'ArrayPattern' && node.id.elements[0]?.name === 'devices') initialDevices = node.init.arguments[0];
  },
  CallExpression(call) {
    if (call.node.callee.name === 'singleFlight' && call.findParent(parent => parent.isVariableDeclarator() && parent.node.id.name === 'fetchDevices')) fetchCallback = call.node.arguments[0];
  },
});

async function fetchState(api, previous = [], active = '') {
  assert.ok(fetchCallback);
  const state = { devices: previous, active, error: '', loading: false };
  const callback = runInNewContext(`(${source.slice(fetchCallback.start, fetchCallback.end)})`, {
    window: { electronAPI: api },
    setLoading: value => { state.loading = value; },
    setDevices: update => { state.devices = update(state.devices); },
    setActiveDeviceId: update => { state.active = update(state.active); },
    resolveActiveDeviceId,
    setError: value => { state.error = value; },
  });
  await callback();
  return JSON.parse(JSON.stringify(state));
}

test('device state starts empty before the first real device discovery', () => {
  assert.equal(initialDevices.type, 'ArrayExpression');
  assert.equal(initialDevices.elements.length, 0);
});
test('browser preview without Electron IPC does not invent connected or offline devices', async () => {
  assert.deepEqual(await fetchState(undefined), { devices: [], active: '', error: '', loading: false });
});
test('real device discovery passes through rows without filtering IDs', async () => {
  const devices = [{ id: 'QA-real-user-device', model: 'actual connected device', status: 'device' }];
  const state = await fetchState({ getDevices: async () => devices });
  assert.deepEqual(state.devices, devices);
  assert.equal(state.active, devices[0].id);
});
test('device discovery errors retain known rows offline and release the loading state', async () => {
  const state = await fetchState({ getDevices: async () => { throw new Error('discovery unavailable'); } }, [{ id: 'actual-device', status: 'device' }], 'actual-device');
  assert.deepEqual(state.devices, [{ id: 'actual-device', status: 'offline' }]);
  assert.match(state.error, /discovery unavailable/);
  assert.equal(state.loading, false);
  assert.equal(state.active, 'actual-device');
});

test('actual App discovery switches stale Wi-Fi selection to online USB without another request', async () => {
  let calls = 0;
  const rows = [{ id: 'wifi:5555', status: 'offline' }, { id: 'usb', status: 'device' }];
  const state = await fetchState({ getDevices: async () => { calls++; return rows; } }, [], 'wifi:5555');
  assert.equal(calls, 1);
  assert.equal(state.active, 'usb');
  assert.deepEqual(state.devices, rows);
  assert.equal(state.loading, false);
  assert.equal(state.error, '');
});

test('actual App refresh preserves manual online choice and waits when all devices disconnect', async () => {
  const rows = [{ id: 'A', status: 'device' }, { id: 'B', status: 'device' }];
  assert.equal((await fetchState({ getDevices: async () => rows }, [], 'B')).active, 'B');
  assert.equal((await fetchState({ getDevices: async () => [] }, rows, 'B')).active, 'B');
});
