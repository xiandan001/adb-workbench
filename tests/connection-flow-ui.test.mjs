import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { defaultSshConnectionMemory, defaultReproductionConfig, selectSshProfile, revalidateReproductionConfig } from '../src/shared/connectionPreferences.js';
const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const uuid = '00000000-0000-4000-8000-000000000001';
const tr = (source, params = {}) => source.replace(/\{(\d+)\}/g, (token, key) => params[key] ?? token);
function callback(file, select) {
  const source = fs.readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8'); let found;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    CallExpression({ node }) { if (typeof select === 'function' && node.callee.name === 'useEffect' && select(source.slice(node.arguments[0].start, node.arguments[0].end))) found = node.arguments[0]; },
    VariableDeclarator({ node }) { if (node.id.name === select) found = node.init; }
  });
  assert.ok(found, `actual callback exists: ${file}`); return source.slice(found.start, found.end);
}
const restoreEffect = file => callback(file, source => source.includes('handledWorkset.current === worksetRequest.requestId'));

test('actual SSH restoration queues during a pending connection and selects only the validated profile after settlement', () => {
  const calls = [], scope = { snapshot: { revision: 1, profiles: [{ id: uuid }] }, worksetRequest: { requestId: 'restore', ssh: { profileId: uuid } }, handledWorkset: { current: '' }, connecting: true,
    memory: defaultSshConnectionMemory(), selectSshProfile, tr, setWorksetNotice: value => calls.push(['notice', value]), setError: value => calls.push(['error', value]),
    setSelectedProfile: value => calls.push(['selected', value]), setMemory: value => calls.push(['memory', value]), saveSshConnectionMemory: value => calls.push(['saved', value]) };
  const restore = runInNewContext(`(${restoreEffect('ssh/SshWorkspace.jsx')})`, scope);
  restore(); assert.equal(scope.handledWorkset.current, ''); assert.equal(calls.filter(([kind]) => kind === 'selected').length, 0);
  scope.connecting = false; restore(); assert.equal(scope.handledWorkset.current, 'restore'); assert.deepEqual(calls.find(([kind]) => kind === 'selected'), ['selected', uuid]);
  const count = calls.length; restore(); assert.equal(calls.length, count);
  scope.worksetRequest = { requestId: 'missing', ssh: { profileId: '00000000-0000-4000-8000-000000000002' } }; restore();
  assert.match(calls.at(-1)[1], /请重新选择配置/); assert.equal(calls.filter(([kind]) => kind === 'selected').length, 1);
});

test('actual serial restoration selects the saved workspace/scheme without applying parameters or touching live COM state', () => {
  const calls = [], scope = { worksetRequest: { requestId: 'restore', serial: { workspace: 'terminal', schemeId: 'saved' } }, handledWorkset: { current: '' }, preferences: { schemes: [{ workspace: 'terminal', id: 'saved' }] }, tr,
    setWorksetNotice: value => calls.push(['notice', value]), setPersistenceError: value => calls.push(['error', value]), updateSerialWorkspace: value => calls.push(['workspace', value]),
    setWorkspace: update => update({ mode: 'rs232', selectedPath: 'COM7' }), setTerminalOpened: value => calls.push(['terminal', value]), setSelectedSchemes: update => calls.push(['selection', update({ rs232: 'other', terminal: '' })]),
    onWorksetContext: value => calls.push(['context', value]) };
  const restore = runInNewContext(`(${restoreEffect('SerialPanel.jsx')})`, scope); restore();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([kind]) => kind === 'workspace')[1])), { mode: 'terminal' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([kind]) => kind === 'selection')[1])), { rs232: 'other', terminal: 'saved' });
  assert.ok(!JSON.stringify(calls).includes('baudRate')); assert.ok(!JSON.stringify(calls).includes('COM7'));
  scope.worksetRequest = { requestId: 'missing', serial: { workspace: 'rs232', schemeId: 'missing' } }; restore(); assert.match(calls.at(-1)[1], /请重新选择方案/);
});

test('actual reproduction reuse revalidates fresh source references and never starts collection', async () => {
  const values = {}, scope = { devices: [{ id: 'other', status: 'device' }], alive: { current: true }, configDirty: { current: false }, tr, revalidateReproductionConfig,
    window: { electronAPI: { reproductionSources: async () => ({ ok: true, serial: [{ workspace: 'terminal', sessionId: 'new' }], ssh: [] }), reproductionStart: () => { throw new Error('must not start'); } } } };
  for (const name of ['Sources', 'Title', 'SelectedDevice', 'Duration', 'Selection', 'Notice']) scope[`set${name}`] = value => { values[name] = value; };
  const reuse = runInNewContext(`(${callback('ReproductionDialog.jsx', 'reuseConfig')})`, scope);
  const config = { ...defaultReproductionConfig(), deviceId: 'offline', selection: { video: true, logs: true, performance: false, serial: [{ workspace: 'terminal', sessionId: 'old' }], ssh: [] } };
  assert.equal((await reuse(config)).ok, true); assert.equal(values.SelectedDevice, ''); assert.deepEqual(values.Selection.serial, []); assert.match(values.Notice, /未开始采集/);
});
