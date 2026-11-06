import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createWorkspaceCase, editWorkspaceCase, prepareWorkspaceHandoff } from '../src/components/AiWorkspaceState.js';
import { adoptWorkspaceDefaults, workspacePhase, workspacePrimaryBlock, prepareWorkspaceVerification, normalizeWorkspaceReportRequest, workspaceRelatedTasks } from '../src/components/AiWorkspaceFlow.js';

const devices = [{ id: 'A', status: 'device' }, { id: 'B', status: 'device' }];
const checks = [{ id: 'device_info' }, { id: 'logcat_snapshot' }, { id: 'app_process' }];
const historyId = '11111111-1111-4111-8111-111111111111';
const caseId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333';
const report = { id: turnId, preview: { question: 'Why did the app close?', deviceId: 'A', diagnostic: { packageName: 'qa.fixture', symptom: 'crash' } }, result: { summary: 'One observed failure' } };
const view = { report, reportRef: { caseId, turnId } };
const card = { title: 'Check process', checkIds: ['app_process'], expectedObservation: 'Observe whether the process remains present.' };

test('untouched drafts adopt an explicit current or first online device and a small local plan', () => {
  const initial = createWorkspaceCase('diagnose', '', caseId);
  const next = adoptWorkspaceDefaults(initial, devices, 'B');
  assert.equal(next.deviceId, 'B'); assert.deepEqual(next.checks, ['device_info', 'logcat_snapshot']);
  assert.equal(next.question, ''); assert.equal(next.preview, null); assert.equal(next.pristine, true);
  assert.equal(adoptWorkspaceDefaults(initial, devices, 'missing').deviceId, 'A');
  const edited = editWorkspaceCase(next, { question: 'Keep my chosen target' });
  assert.equal(adoptWorkspaceDefaults(edited, [{ id: 'A', status: 'device' }], 'A'), edited);
  const busy = { ...initial, busy: 'collect' }; assert.equal(adoptWorkspaceDefaults(busy, devices, 'B'), busy);
});

test('handoff preserves the explicit target and question without restoring consent or clearing selected target tokens', () => {
  const next = prepareWorkspaceHandoff(createWorkspaceCase('task', 'B', caseId), { id: 'handoff', deviceId: 'A', question: 'Observe settings', taskTargets: [{ token: 'token', deviceId: 'A', label: 'Settings' }] });
  assert.equal(next.deviceId, 'A'); assert.equal(next.question, 'Observe settings'); assert.deepEqual(next.targetSelection.tokens, ['token']);
  assert.equal(next.preview, null); assert.equal(next.pristine, false);
});

test('phase and disabled explanation follow actual preparation, preview and readonly result state', () => {
  const initial = createWorkspaceCase('diagnose', 'A', caseId);
  assert.equal(workspacePhase(initial), 'prepare');
  assert.equal(workspacePrimaryBlock(initial, { devices, loading: false, entitled: true, sources: [] }), 'question');
  const ready = editWorkspaceCase(initial, { question: 'fixture' });
  assert.equal(workspacePrimaryBlock(ready, { devices, entitled: true, sources: [] }), '');
  assert.equal(workspacePrimaryBlock({ ...ready, deviceId: 'offline' }, { devices, entitled: true }), 'device');
  assert.equal(workspacePrimaryBlock({ ...ready, checks: ['app_process'] }, { devices, entitled: true }), 'package');
  assert.equal(workspacePhase({ ...ready, preparing: false, preview: { id: 'preview' } }), 'review');
  assert.equal(workspacePhase({ ...ready, preparing: false, reportView: view }), 'result');
});

test('a verification card only prepares known checks with frozen context and the original target', () => {
  const current = createWorkspaceCase('diagnose', 'B', 'new-case');
  const prepared = prepareWorkspaceVerification(current, view, card, checks);
  assert.equal(prepared.reason, ''); const next = prepared.state;
  assert.equal(next.deviceId, 'A'); assert.equal(next.question, report.preview.question);
  assert.deepEqual(next.checks, ['app_process']); assert.deepEqual(next.contextRef, view.reportRef);
  assert.equal(next.context.summary, report.result.summary); assert.equal(next.diagnostic.packageName, 'qa.fixture');
  assert.equal(next.preview, null); assert.equal(next.busy, ''); assert.equal(next.preparing, true);
  assert.deepEqual(current.checks, ['device_info', 'logcat_snapshot']);
});

test('verification preparation rejects unknown/duplicate checks, absent package and busy target without side effects', () => {
  const current = createWorkspaceCase('diagnose', 'B', 'case');
  for (const checkIds of [['shell'], ['app_process', 'app_process'], []]) assert.equal(prepareWorkspaceVerification(current, view, { ...card, checkIds }, checks).reason, 'checks');
  assert.equal(prepareWorkspaceVerification(current, { ...view, report: { ...report, preview: { question: 'fixture', deviceId: 'A' } } }, card, checks).reason, 'package');
  const busy = { ...current, busy: 'collect' }; assert.equal(prepareWorkspaceVerification(busy, view, card, checks).state, busy);
});

test('unknown report targets never inherit an unrelated default diagnosis device', () => {
  const current = createWorkspaceCase('diagnose', 'B', 'case');
  const unknown = { ...view, report: { ...report, preview: { question: 'Examine this SSH text', entries: [{ source: 'ssh', target: 'server', targetKey: null }] } } };
  const prepared = prepareWorkspaceVerification(current, unknown, { ...card, checkIds: ['device_info'] }, checks);
  assert.equal(prepared.reason, ''); assert.equal(prepared.state.deviceId, ''); assert.equal(prepared.state.pristine, false);
  assert.equal(workspacePrimaryBlock(prepared.state, { devices, entitled: true }), 'device');
  assert.equal(adoptWorkspaceDefaults(prepared.state, devices, 'B'), prepared.state);
});

test('external report navigation accepts only a single recognized reference and never a preview token', () => {
  assert.deepEqual(normalizeWorkspaceReportRequest({ requestId: 'request', historyId }), { historyId });
  assert.deepEqual(normalizeWorkspaceReportRequest({ requestId: 'request', caseId, turnId }), { caseId, turnId });
  for (const value of [{ requestId: 'r', previewId: historyId }, { requestId: 'r', historyId, casebookId: historyId }, { requestId: 'r', caseId }, { historyId }, { requestId: 'r', historyId: '../file' }]) assert.equal(normalizeWorkspaceReportRequest(value), null);
});

test('related records match stored origin IDs, never similar titles or a successful status', () => {
  const snapshot = { scripts: [{ id: 'script', name: 'Related script', analysisOrigin: { caseId, turnId } }], activeTasks: [], history: [
    { id: 'run', scriptName: 'Related run', status: 'success', analysisOrigin: { caseId, turnId } },
    { id: 'unrelated', scriptName: 'Related run', status: 'success', analysisOrigin: { question: report.preview.question } },
  ] };
  const related = workspaceRelatedTasks(view, snapshot);
  assert.equal(related.length, 2); assert.equal(related[0].scriptId, 'script'); assert.equal(related[1].runId, 'run');
  assert.equal(related[1].status, 'success'); assert.equal(related[1].verified, undefined);
  assert.equal(workspaceRelatedTasks({ report: { ...report, turnId }, reportRef: { historyId } }, snapshot).length, 2);
});

test('phase disclosure cannot hide current errors or cancellation and completed conclusions precede evidence', () => {
  const require = createRequire(import.meta.url), parser = require('@babel/parser');
  const source = fs.readFileSync(new URL('../src/components/AiWorkspace.jsx', import.meta.url), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }); const found = new Set();
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'LogicalExpression' && node.operator === '&&' && node.left?.object?.name === 'current' && ['error', 'busy'].includes(node.left?.property?.name)) {
      found.add(node.left.property.name); assert.ok(!ancestors.some(parent => parent.type === 'JSXElement' && parent.openingElement.name.name === 'details'));
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item => visit(item, [...ancestors, node])); else if (value && typeof value === 'object') visit(value, [...ancestors, node]);
  }
  visit(ast); assert.deepEqual([...found].sort(), ['busy', 'error']);
  const report = fs.readFileSync(new URL('../src/components/AiWorkspaceResults.jsx', import.meta.url), 'utf8');
  assert.ok(report.indexOf('<AiWorkspaceAnalysis') < report.indexOf('<AiWorkspaceEvidence'));
  assert.match(report, /setEvidenceOpen\(true\)/);
});
