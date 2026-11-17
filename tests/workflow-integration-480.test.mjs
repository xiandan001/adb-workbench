import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), functions = new Map();
traverseModule.default(parse(app, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) {
  if (['connectDevice', 'handleStartScrcpy', 'handleMirrorProfile'].includes(node.id.name)) functions.set(node.id.name, app.slice(node.init.start, node.init.end));
} });
const tr = (text, values = {}) => text.replace(/\{(\d+)\}/g, (token, key) => values[key] ?? token);

test('a new address has a durable inline result DTO and reconnect success does not steal an unrelated active target', async () => {
  let results = {}, last; const selected = [], calls = [], history = { deviceId: 'old-history', ip: '192.0.2.2' };
  let result = { success: false, message: 'fixture timeout', code: 'ETIMEDOUT' };
  const connect = vm.runInNewContext('(' + functions.get('connectDevice') + ')', {
    tr, window: { electronAPI: {} }, connectingAddressesRef: { current: new Set() },
    setLastConnectionAttempt: value => { last = value; }, setConnectionResults: update => { results = update(results); },
    connectWirelessDevice: async (address, options) => { calls.push({ address, history: options.historyEntry }); return result; },
    fetchDevices() {}, setConnectionHistory() {}, showToast() {}, setDeviceQuery() {}, chooseDevice: id => selected.push(id), setActiveTab() {}, setConnectionFormOpen() {},
  });
  assert.equal(await connect(' 192.0.2.1 '), false); assert.equal(last.address, '192.0.2.1');
  assert.equal(results[last.key].status, 'error'); assert.equal(results[last.key].code, 'ETIMEDOUT'); assert.equal(results[last.key].address, last.address);
  result = { success: true, message: 'connected', deviceId: '192.0.2.2:5555' };
  assert.equal(await connect('192.0.2.2', history), true); assert.deepEqual(selected, []);
  assert.equal(results[history.deviceId].deviceId, result.deviceId); assert.equal(calls.length, 2);
});

test('mirror retry uses its explicit device/options and profile actions send only the current session identity', async () => {
  const calls = [], session = { id: 'session-A' };
  const globals = { tr, scrcpySettings: { bitrate: '8 Mbps' }, mirrorSessions: { A: session }, setOperationLoading() {}, showToast() {}, showDeviceFailure() {},
    window: { electronAPI: { startScrcpy: async (...args) => { calls.push(['start', ...args]); return { success: true }; },
      mirrorConfirmProfile: async value => { calls.push(['confirm', value]); return { ok: true }; }, mirrorForgetProfile: async value => { calls.push(['forget', value]); return { ok: true }; } } } };
  const start = vm.runInNewContext('(' + functions.get('handleStartScrcpy') + ')', globals);
  const profile = vm.runInNewContext('(' + functions.get('handleMirrorProfile') + ')', globals);
  await start('A', { profileMode: 'global' }); await profile('A', 'remember'); await profile('A', 'forget'); await profile('B', 'remember');
  assert.equal(calls.length, 3); assert.equal(calls[0][1], 'A'); assert.equal(calls[0][3].profileMode, 'global');
  assert.equal(JSON.stringify(calls[1][1]), JSON.stringify({ deviceId: 'A', sessionId: 'session-A' })); assert.equal(Object.keys(calls[2][1]).length, 2);
});

test('main and preload integration keep state reads and budget subscriptions separate from execution', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.ok(main.indexOf("require('./lib/mirror-workflow.cjs').register(diagnosticIpc)") < main.indexOf('adb.register(diagnosticIpc, mirroring)'));
  const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /mirrorGetState: \(\) => ipcRenderer\.invoke\('mirror:state'\)/);
  assert.match(preload, /onAiWorkspaceMaterialBudget:[\s\S]+?ipcRenderer\.on\('ai-workspace:materialBudget', listener\)/);
  assert.match(preload, /return \(\) => ipcRenderer\.off\('ai-workspace:materialBudget', listener\)/);
});
