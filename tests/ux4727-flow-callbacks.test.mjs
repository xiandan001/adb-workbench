import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareSavedTaskRun } from '../src/shared/taskQuickRun.js';
import { applyAndConnectSerialScheme } from '../src/shared/serialSchemeConnection.js';
import { defaultSerialPreferences } from '../src/shared/serialSettings.js';
import { addSerialScheme } from '../src/shared/serialSchemes.js';
import { adaptPristineBuiltin, taskPlatformForDevice } from '../src/shared/taskPlatform.js';
import { seedQualityApplication } from '../src/shared/qualityDraft.js';
import { tr } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url), parse = require('@babel/parser').parse;
const traverse = require('@babel/traverse').default;
function expressions(file) {
  const source = readFileSync(new URL('../src/components/' + file, import.meta.url), 'utf8'), values = {};
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) {
    if (node.id.type === 'Identifier' && node.init) values[node.id.name] = source.slice(node.init.start, node.init.end);
  } });
  return values;
}
const task = expressions('TaskCenter.jsx'), serial = expressions('SerialPanel.jsx'), quality = expressions('QualityCenter.jsx');
const instantiate = (expression, bindings) => new Function(...Object.keys(bindings), `return (${expression});`)(...Object.values(bindings));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const sample = () => ({ id: 'saved', name: 'Saved', targetPlatform: 'android', steps: [{ id: 'wait', type: 'delay', durationMs: 50 }] });

test('actual saved-card callback opens a detached preview and never starts a task or replaces the draft', () => {
  let request, calls = 0;
  const selected = ['A'], source = sample(), dirtyDraft = { name: 'unsaved', steps: [] };
  const preview = instantiate(task.previewSavedRun, { runInFlightRef: { current: false }, selectedDeviceIds: selected,
    taskPlatformForDevice, adaptPristineBuiltin, cloneScript: value => JSON.parse(JSON.stringify(value)), setSavedRun: value => { request = value; },
    draft: dirtyDraft, window: { electronAPI: { taskRun: () => calls++ } } });
  preview(source); source.steps[0].durationMs = 999; selected.push('B');
  assert.deepEqual(request.deviceIds, ['A']); assert.equal(request.script.steps[0].durationMs, 50);
  assert.equal(calls, 0); assert.equal(dirtyDraft.name, 'unsaved');
});

test('actual saved-card Run and Edit handlers are independent and Edit retains the dirty-draft review', () => {
  const source = readFileSync(new URL('../src/components/TaskCenterQuickStart.jsx', import.meta.url), 'utf8');
  const handlers = {};
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXAttribute({ node }) {
    if (node.name.name !== 'onClick' || !node.value?.expression) return;
    const expression = source.slice(node.value.expression.start, node.value.expression.end);
    if (expression.includes('onRunScript')) handlers.run = expression;
    if (expression.includes('onOpenScript')) handlers.edit = expression;
  } });
  let runs = 0, edits = 0, pending, changed = 0;
  const selected = sample();
  instantiate(handlers.run, { script: selected, onRunScript: script => { assert.equal(script, selected); runs++; } })();
  assert.equal(runs, 1); assert.equal(edits, 0);
  const replaceDraft = instantiate(task.replaceDraft, { draftDirty: true, setPendingDraftAction: update => { pending = update(); } });
  const selectScript = instantiate(task.selectScript, { replaceDraft, resolveScriptAfterSave: value => value, setSelectedScriptId() {}, setDraft() { changed++; }, setSavedFingerprint() {}, cloneScript: value => value, draftFingerprint: () => '' });
  const open = instantiate(task.openScriptEditor, { selectScript, setEditorMode() {}, setWorkspaceView() {} });
  instantiate(handlers.edit, { script: selected, onOpenScript: script => { edits++; open(script); } })();
  assert.equal(runs, 1); assert.equal(edits, 1); assert.equal(changed, 0); assert.equal(typeof pending, 'function');
  pending(); assert.equal(changed, 1);
});

test('actual task executor is same-tick single-flight and freezes the reviewed target across changes', async () => {
  let resolve, payload, calls = 0, active = [], selectedTask;
  const lock = { current: false }, state = [];
  const execute = instantiate(task.executeRun, { runInFlightRef: lock, prepareSavedTaskRun, devices: [{ id: 'A', status: 'device' }], taskCenterPath: 'out', tr,
    setStarting: value => state.push(value), showToast() {}, setActiveTasks: update => { active = update(active); }, setSelectedTaskId: value => { selectedTask = value; },
    window: { electronAPI: { taskRun: value => { payload = value; calls++; return new Promise(done => { resolve = done; }); } } } });
  const source = sample(), ids = ['A']; const first = execute(source, ids);
  assert.equal(await execute(source, ids), null); source.steps[0].durationMs = 999; ids.push('B');
  assert.equal(calls, 1); assert.deepEqual(payload.deviceIds, ['A']); assert.equal(payload.script.steps[0].durationMs, 50);
  resolve({ ok: true, task: { id: 'run-A' } }); assert.deepEqual(await first, { ok: true });
  assert.deepEqual(state, [true, false]); assert.equal(lock.current, false); assert.equal(selectedTask, 'run-A'); assert.equal(active[0].id, 'run-A');
});

test('actual serial combo callback saves before one connection and persistence failure leaves it disconnected', async () => {
  const preferences = addSerialScheme(defaultSerialPreferences(), { id: 'scheme', name: 'Saved', workspace: 'rs232', config: { ...defaultSerialPreferences().config, baudRate: 230400 } });
  const actionRef = { current: { rs232: null } }, pending = [], errors = [], order = [];
  let persistOk = false, connects = 0, payload;
  const bindings = { actionRef, aliveRef: { current: true }, setPending: update => pending.push(update({ rs232: '' })), setErrors: update => errors.push(update({ rs232: '' })),
    setSnapshots() {}, applySerialWorkspaceSnapshot() {}, snapshotRef: { current() {} }, tr };
  const act = instantiate(serial.act, bindings);
  const combo = instantiate(serial.applySchemeAndConnect, { mode: 'rs232', selectedPath: 'COM9', selectedSchemes: { rs232: 'scheme' }, ports: [{ path: 'COM9' }], actionRef, act,
    applyAndConnectSerialScheme, preferencesRef: { current: preferences }, snapshots: { rs232: { status: 'disconnected', revision: 1 } },
    commitScheme: next => { order.push('persist'); assert.equal(next.config.baudRate, 230400); return persistOk; },
    window: { electronAPI: { serialConnect: async value => { connects++; order.push('connect'); payload = value; return { success: true }; } } } });
  assert.equal(await combo(), false); assert.equal(connects, 0); assert.equal(actionRef.current.rs232, null);
  persistOk = true; const connected = combo(); assert.equal(await combo(), false); await flush(); assert.equal(await connected, true);
  assert.equal(connects, 1); assert.equal(payload.path, 'COM9'); assert.equal(payload.config.baudRate, 230400);
  assert.deepEqual(order, ['persist', 'persist', 'connect']); assert.equal(actionRef.current.rs232, null);
  assert.ok(errors.some(value => value.rs232)); assert.equal(pending.at(-1).rs232, '');
});

test('actual serial scheme selection persists only metadata without applying, connecting or changing COM', () => {
  let selected, saved, calls = 0;
  const select = instantiate(serial.selectScheme, { mode: 'terminal', selectedSchemes: { version: 1, rs232: 'one', terminal: '' },
    setWorksetNotice() {}, setSelectedSchemes: value => { selected = value; }, saveSerialSchemeSelection: value => { saved = value; },
    setSchemeSelectionError() {}, onWorksetContext() {}, window: { electronAPI: { serialConnect() { calls++; } } } });
  select('terminal-two');
  assert.deepEqual(selected, { version: 1, rs232: 'one', terminal: 'terminal-two' });
  assert.deepEqual(saved, selected); assert.equal(calls, 0);
});

test('actual workset restore selects and persists a scheme without applying it, connecting or changing COM', () => {
  const source = readFileSync(new URL('../src/components/SerialPanel.jsx', import.meta.url), 'utf8');
  let expression;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
    if (node.callee.name !== 'useEffect' || !node.arguments[0]) return;
    const callback = source.slice(node.arguments[0].start, node.arguments[0].end);
    if (callback.includes('const reference = worksetRequest.serial')) expression = callback;
  } });
  const preferences = addSerialScheme(defaultSerialPreferences(), { id: 'saved', name: 'Saved', workspace: 'terminal', config: { ...defaultSerialPreferences().terminalConfig, baudRate: 115200 } });
  let workspace = { mode: 'rs232', selectedPath: 'COM5', terminalSelectedPath: 'COM6' }, saved, selected, connects = 0;
  instantiate(expression, { worksetRequest: { requestId: 'restore-1', serial: { workspace: 'terminal', schemeId: 'saved' } }, handledWorkset: { current: '' },
    preferences, selectedSchemes: { version: 1, rs232: 'one', terminal: '' }, setWorksetNotice() {}, setPersistenceError() {}, setSchemeSelectionError() {},
    updateSerialWorkspace: update => { workspace = { ...workspace, ...update }; }, setWorkspace: update => { workspace = update(workspace); }, setTerminalOpened() {},
    setSelectedSchemes: value => { selected = value; }, saveSerialSchemeSelection: value => { saved = value; }, onWorksetContext() {}, tr,
    window: { electronAPI: { serialConnect() { connects++; } } } })();
  assert.equal(workspace.mode, 'terminal'); assert.equal(workspace.selectedPath, 'COM5'); assert.equal(workspace.terminalSelectedPath, 'COM6');
  assert.deepEqual(saved, selected); assert.equal(saved.terminal, 'saved'); assert.equal(connects, 0);
  assert.equal(preferences.terminalConfig.baudRate, defaultSerialPreferences().terminalConfig.baudRate);
});

test('actual quality derived package uses context only until a user choice is made', () => {
  const base = { applicationEdited: false, packageInput: '', seedQualityApplication, initialDraft: {}, selectedDeviceId: 'A', applicationContext: { deviceId: 'A', packageName: 'com.example.a' } };
  const read = overrides => instantiate(quality.packageName, { ...base, ...overrides });
  assert.equal(read(), 'com.example.a'); assert.equal(read({ selectedDeviceId: 'B' }), '');
  assert.equal(read({ packageInput: 'com.example.saved' }), 'com.example.saved');
  assert.equal(read({ applicationEdited: true, packageInput: '' }), '', 'Explicitly clearing the picker must not refill the global application');
  let frozen, edited = false;
  instantiate(quality.markApplicationEdited, { applicationEdited: false, packageName: 'com.example.a', setPackageName: value => { frozen = value; }, setApplicationEdited: value => { edited = value; } })();
  assert.equal(frozen, 'com.example.a'); assert.equal(edited, true);
});
