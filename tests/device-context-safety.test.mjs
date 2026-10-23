import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'); const traverse = require('@babel/traverse').default;
function handler(file, name, context) {
  const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] }); let target;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === name) target = node.init; }, FunctionDeclaration({ node }) { if (node.id?.name === name) target = node; } });
  assert.ok(target, `missing ${name}`); return runInNewContext(`(${source.slice(target.start, target.end)})`, context);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function recorderContext(api) {
  const state = { recorder: { deviceId: 'A', nodes: [], selectedNodeIndex: '', recording: false }, steps: [], refreshes: [] };
  const context = {
    recorder: state.recorder, onlineDevices: [{ id: 'A' }, { id: 'B' }], workspaceView: 'recording',
    recorderMountedRef: { current: true }, recorderActionInFlightRef: { current: false },
    recorderContextRef: { current: { deviceId: 'A', generation: 1 } },
    clearScheduledRecorderRefresh() {}, showToast() {}, RECORD_ACTIONS_REFRESH_SNAPSHOT: new Set(['tap']),
    setRecorder: update => { state.recorder = update(state.recorder); }, appendRecordedStep: step => state.steps.push(step),
    scheduleRecorderSnapshotRefresh: id => state.refreshes.push(id), window: { electronAPI: api },
  };
  return { state, context };
}

test('a late recorded action remains on A and cannot append a step or clear the busy state of B', async () => {
  const pending = deferred(); const calls = [];
  const h = recorderContext({ taskStressRecordAction: args => { calls.push(args); return pending.promise; } });
  const action = handler('TaskCenter.jsx', 'recordAction', h.context)('tap');
  h.state.recorder = { deviceId: 'B', recording: true }; h.context.recorderContextRef.current = { deviceId: 'B', generation: 2 };
  pending.resolve({ ok: true, step: { type: 'tap', fixtureDevice: 'A' } });
  assert.equal(await action, null); assert.equal(calls[0].deviceId, 'A'); assert.equal(calls.length, 1);
  assert.deepEqual(h.state.steps, []); assert.equal(h.state.recorder.recording, true); assert.deepEqual(h.state.refreshes, []);
});

test('auto-switch clearing visual flags cannot admit another recorded action while one is still in flight', async () => {
  let calls = 0; const h = recorderContext({ taskStressRecordAction: async () => { calls++; return { ok: true, step: {} }; } });
  h.context.recorderActionInFlightRef.current = true;
  await handler('TaskCenter.jsx', 'recordAction', h.context)('tap'); assert.equal(calls, 0);
});

test('an A-to-B-to-A context round trip rejects the earlier A recorder screenshot', async () => {
  const pending = deferred(); const h = recorderContext({ taskStressUiSnapshot: () => pending.promise });
  const request = handler('TaskCenter.jsx', 'refreshRecorderSnapshot', h.context)();
  h.context.recorderContextRef.current = { deviceId: 'A', generation: 3 };
  pending.resolve({ ok: true, screenshotDataUrl: 'old-A-image', screenshotWidth: 100, screenshotHeight: 100, nodes: [] });
  assert.equal(await request, false); assert.notEqual(h.state.recorder.screenshotDataUrl, 'old-A-image');
});

test('late performance start/stop responses cannot replace B running state or refresh A into its request sequence', async () => {
  for (const name of ['startMonitor', 'stopMonitor']) {
    const pending = deferred(); const expected = name === 'stopMonitor'; const state = { running: expected, refreshes: [], calls: [] };
    const context = { selectedDeviceId: 'A', selectedDeviceOnline: true, intervalMs: 5000, hasVipAccess: true,
      selectedDeviceIdRef: { current: 'A' }, deviceContextRef: { current: { deviceId: 'A', generation: 1 } }, monitorActionRef: { current: null },
      stateRequestSeqRef: { current: 0 }, runningDeviceRef: { current: '' }, setLoading() {}, setIntervalMs() {}, showToast() {}, flushSync: callback => callback(),
      setRunning: value => { state.running = value; }, refreshPerformanceState: id => state.refreshes.push(id),
      window: { electronAPI: { perfStart: args => { state.calls.push(args); return pending.promise; }, perfStop: args => { state.calls.push(args); return pending.promise; } } },
    };
    const operation = handler('PerformanceDashboard.jsx', name, context)();
    context.selectedDeviceIdRef.current = 'B'; context.deviceContextRef.current = { deviceId: 'B', generation: 2 };
    pending.resolve({ ok: true }); await operation;
    assert.equal(state.calls[0].deviceId, 'A'); assert.equal(state.calls.length, 1);
    assert.equal(state.running, expected); assert.deepEqual(state.refreshes, []);
  }
});

test('late quality regression results are not displayed as results for the newly selected device', async () => {
  const pending = deferred(); const state = { result: null, calls: [] };
  const deviceContextRef = { current: { deviceId: 'A', generation: 1 } };
  const context = { selectedDevice: { id: 'A' }, selectedDeviceId: 'A', effectiveBaselinePath: 'fixture-A-baseline', reportName: '', includePerformance: false,
    deviceContextRef, deviceOperationRef: { current: null }, showToast() {}, setBusy() {}, setError() {}, setReportName() {},
    setLastResult: value => { state.result = value; }, window: { electronAPI: { regressionRun: args => { state.calls.push(args); return pending.promise; } } },
  };
  const operation = handler('QualityCenter.jsx', 'runRegression', context)();
  deviceContextRef.current = { deviceId: 'B', generation: 2 };
  pending.resolve({ ok: true, result: { deviceId: 'A', status: 'passed' } }); await operation;
  assert.equal(state.calls[0].deviceId, 'A'); assert.equal(state.calls.length, 1); assert.equal(state.result, null);
});

test('environment check results are hidden for a different device and late responses never repaint it', async () => {
  const pending = deferred(); const state = { result: null, error: '', calls: [] };
  const deviceContextRef = { current: { deviceId: 'A', generation: 1 } };
  const context = { selectedDeviceId: 'A', deviceContextRef, checkPendingRef: { current: null }, setRunning() {}, setError() {},
    setCheckError: value => { state.error = value; }, showToast() {}, setResult: value => { state.result = value; },
    window: { electronAPI: { envCheckRun: args => { state.calls.push(args); return pending.promise; } } },
  };
  const checking = handler('EnvironmentCheckWizard.jsx', 'runCheck', context)();
  deviceContextRef.current = { deviceId: 'B', generation: 2 };
  pending.resolve({ ok: true, checkedAt: 'fixture', device: { id: 'A' } }); await checking;
  assert.equal(state.calls[0].deviceId, 'A'); assert.equal(state.result, null);
  const old = { deviceId: 'A', value: { ok: true } };
  assert.equal(handler('EnvironmentCheckWizard.jsx', 'result', { storedResult: old, selectedDeviceId: 'B' }), null);
  assert.equal(handler('EnvironmentCheckWizard.jsx', 'result', { storedResult: old, selectedDeviceId: 'A' }), old.value);
});

test('switching devices cannot reset the global ADB restart in-flight guard', async () => {
  const pending = deferred(); let calls = 0; const transitions = []; const clearedCheckErrors = [];
  const context = { restartPendingRef: { current: false }, setRestarting: value => transitions.push(value), setError() {}, setCheckError: value => clearedCheckErrors.push(value), showToast() {}, onRefreshDevices() {},
    window: { electronAPI: { envCheckRestartAdb: () => { calls++; return pending.promise; } } },
  };
  const restart = handler('EnvironmentCheckWizard.jsx', 'restartAdb', context);
  const first = restart(); const overlapping = restart();
  pending.resolve({ ok: true }); await Promise.all([first, overlapping]);
  assert.equal(calls, 1); assert.deepEqual(transitions, [true, false]);
  assert.deepEqual(clearedCheckErrors, [null]);
  assert.equal(handler('EnvironmentCheckWizard.jsx', 'visibleError', { selectedDeviceId: 'A', checkError: { deviceId: 'A', message: 'old device error' }, error: 'global restart error' }), 'global restart error');
});

test('unchanged recording context still records the original target and refreshes only that target', async () => {
  const calls = []; const step = { type: 'tap', x: 1, y: 2 };
  const h = recorderContext({ taskStressRecordAction: async args => { calls.push(args); return { ok: true, step }; } });
  assert.equal(await handler('TaskCenter.jsx', 'recordAction', h.context)('tap'), step);
  assert.equal(calls[0].deviceId, 'A'); assert.deepEqual(h.state.steps, [step]); assert.deepEqual(h.state.refreshes, ['A']);
  assert.equal(h.state.recorder.recording, false);
});

test('quality recent task visibility uses the real backend deviceRuns field and never another device', () => {
  const task = { id: 'task-fixture', deviceRuns: [{ deviceId: 'A', status: 'running' }] };
  assert.equal(handler('QualityCenter.jsx', 'visibleAcceptanceTask', { lastAcceptanceTask: task, selectedDeviceId: 'A' }), task);
  assert.equal(handler('QualityCenter.jsx', 'visibleAcceptanceTask', { lastAcceptanceTask: task, selectedDeviceId: 'B' }), null);
});

test('previous performance exports and reports are hidden when the selected device changes', () => {
  const values = { exportResult: { deviceId: 'A', path: 'fixture-export' }, reportResult: { deviceId: 'A', path: 'fixture-report', aiSummary: { text: 'fixture-summary' } } };
  for (const selectedDeviceId of ['A', 'B']) {
    assert.equal(handler('PerformanceDashboard.jsx', 'lastExportPath', { ...values, selectedDeviceId }), selectedDeviceId === 'A' ? 'fixture-export' : '');
    assert.equal(handler('PerformanceDashboard.jsx', 'lastReportPath', { ...values, selectedDeviceId }), selectedDeviceId === 'A' ? 'fixture-report' : '');
    assert.equal(handler('PerformanceDashboard.jsx', 'lastReportAiSummary', { ...values, selectedDeviceId }), selectedDeviceId === 'A' ? values.reportResult.aiSummary : null);
  }
});
