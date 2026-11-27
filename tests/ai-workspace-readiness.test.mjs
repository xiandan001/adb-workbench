import test from 'node:test';
import assert from 'node:assert/strict';
import { clearWorkspaceApplicationSelection, workspaceApplicationChecks, workspaceHasAlternateEvidence, workspaceReadiness, workspacePrimaryBlock, workspaceTaskTarget, focusWorkspaceRequiredField } from '../src/components/AiWorkspaceFlow.js';
import { createWorkspaceCase, editWorkspaceCase, prepareWorkspaceContext } from '../src/components/AiWorkspaceState.js';

const devices = [{ id: 'test-device', status: 'device' }];
const context = { devices, sources: [{ id: 'current-log' }], entitled: true };
const newCase = mode => createWorkspaceCase(mode, '', 'test-case');

test('diagnostic readiness lists independent missing fields in order without changing the first-block API', () => {
  const initial = { ...newCase('diagnose'), checks: [] };
  assert.deepEqual(workspaceReadiness(initial, context), { missing: ['question', 'device', 'checks'], status: '' });
  assert.equal(workspacePrimaryBlock(initial, context), 'question');
  const diagnostic = { ...initial, checks: ['app_process'] };
  assert.deepEqual(workspaceReadiness(diagnostic, context).missing, ['question', 'device', 'package']);
  const ready = { ...diagnostic, question: 'Analyze', deviceId: devices[0].id, diagnostic: { packageName: 'qa.fixture' } };
  assert.deepEqual(workspaceReadiness(ready, context), { missing: [], status: '' });
});

test('target application is optional for device checks and required only while an application check is selected', () => {
  const initial = { ...newCase('diagnose'), question: 'Analyze', deviceId: devices[0].id, checks: ['device_info', 'logcat_snapshot', 'performance_snapshot'] };
  assert.deepEqual(workspaceApplicationChecks(initial.checks), []);
  assert.deepEqual(workspaceReadiness(initial, context).missing, []);
  const appChecks = { ...initial, checks: [...initial.checks, 'app_memory', 'app_process'] };
  assert.deepEqual(workspaceApplicationChecks(appChecks.checks), ['app_memory', 'app_process']);
  assert.deepEqual(workspaceReadiness(appChecks, context).missing, ['package']);
  assert.deepEqual(workspaceReadiness({ ...appChecks, diagnostic: { packageName: 'qa.target' } }, context).missing, []);
  assert.deepEqual(workspaceReadiness({ ...appChecks, checks: ['logcat_snapshot'] }, context).missing, []);
});

test('explicit no-app selection drops only app checks and never auto-adds checks or keeps stale review', () => {
  const current = { ...newCase('diagnose'), question: 'Device is slow', deviceId: devices[0].id,
    diagnostic: { packageName: 'qa.target', symptom: 'slow' }, checks: ['device_info', 'app_process', 'performance_snapshot', 'app_memory'],
    plan: { checks: ['app_memory'] }, preview: { id: 'previous' } };
  const ready = editWorkspaceCase(current, clearWorkspaceApplicationSelection(current));
  assert.deepEqual(ready.checks, ['device_info', 'performance_snapshot']);
  assert.deepEqual(ready.diagnostic, { packageName: '', symptom: '' });
  assert.equal(ready.plan, null);
  assert.equal(ready.preview, null);
  assert.equal(ready.deviceId, current.deviceId);
  assert.equal(ready.question, current.question);
  assert.deepEqual(workspaceReadiness(ready, context).missing, []);
  const appOnly = { ...current, checks: ['app_process'] };
  const cleared = editWorkspaceCase(appOnly, clearWorkspaceApplicationSelection(appOnly));
  assert.deepEqual(workspaceReadiness(cleared, context).missing, ['checks']);
});

test('analysis accepts each alternative material and separates stale selections from missing evidence', () => {
  const initial = { ...newCase('analysis'), question: 'Analyze' };
  const available = new Set(['current-log']);
  assert.deepEqual(workspaceReadiness(initial, context).missing, ['source']);
  for (const material of [{ sourceIds: ['current-log'] }, { text: 'local text' }, { contextRef: {} }, { handoffId: 'fixture' }, { basketItems: [{ id: 'fixture' }] }]) {
    assert.deepEqual(workspaceReadiness({ ...initial, ...material }, context).missing, []);
    assert.equal(workspaceHasAlternateEvidence({ ...initial, ...material }, available), !material.text);
  }
  assert.equal(workspaceHasAlternateEvidence({ ...initial, sourceIds: ['gone'], text: 'only evidence' }, available), false);
  assert.deepEqual(workspaceReadiness({ ...initial, sourceIds: ['gone'] }, context).missing, ['stale', 'source']);
  assert.deepEqual(workspaceReadiness({ ...initial, sourceIds: ['gone', 'current-log'] }, context).missing, ['stale']);
});

test('busy, loading and membership are statuses; the task device stays optional except for a disconnected HDC target', () => {
  const task = newCase('task');
  assert.deepEqual(workspaceReadiness(task, { ...context, loading: true }), { missing: [], status: 'loading' });
  assert.deepEqual(workspaceReadiness(task, { ...context, reportBusy: 'load' }), { missing: [], status: 'busy' });
  assert.deepEqual(workspaceReadiness(task, { ...context, entitled: false }), { missing: ['question'], status: 'membership' });
  assert.equal(workspacePrimaryBlock(task, { ...context, entitled: false }), 'question');
  const ready = { ...task, question: 'Test' };
  assert.deepEqual(workspaceReadiness(ready, context), { missing: [], status: '' });
  assert.deepEqual(workspaceReadiness({ ...ready, deviceId: 'hdc:disconnected' }, context).missing, ['device']);
  assert.equal(workspacePrimaryBlock(ready, { ...context, entitled: false }), 'membership');
});

test('a plain Android draft is unbound; regression inherits only the report device and gates offline Harmony', () => {
  const initial = { ...newCase('task'), question: 'Test' };
  const reportDevice = 'hdc:report-device';
  assert.deepEqual(workspaceTaskTarget(initial), { deviceId: '', source: '' });
  assert.deepEqual(workspaceReadiness(initial, context).missing, []);
  const view = { reportRef: { historyId: 'saved' }, report: { preview: { deviceId: reportDevice, handoff: { deviceId: 'another-device' } } } };
  const regression = { ...prepareWorkspaceContext(initial, view, 'task'), question: 'Repeat it' };
  assert.equal(regression.deviceId, '');
  assert.equal(regression.context.deviceId, reportDevice);
  assert.deepEqual(workspaceTaskTarget(regression), { deviceId: reportDevice, source: 'report' });
  assert.deepEqual(workspaceReadiness(regression, context).missing, ['device']);
  assert.deepEqual(workspaceReadiness(regression, { ...context, devices: [{ id: reportDevice, status: 'device' }] }).missing, []);
  const cleared = { ...regression, context: null, contextRef: null };
  assert.deepEqual(workspaceTaskTarget(cleared), { deviceId: '', source: '' });
  assert.deepEqual(workspaceReadiness(cleared, context).missing, []);
  const explicitlySelected = { ...regression, deviceId: devices[0].id };
  assert.deepEqual(workspaceTaskTarget(explicitlySelected), { deviceId: devices[0].id, source: 'selected' });

  const unrelatedView = { ...view, report: { preview: { handoff: { deviceId: reportDevice } } } };
  const withoutReportDevice = prepareWorkspaceContext(initial, unrelatedView, 'task');
  assert.deepEqual(workspaceTaskTarget(withoutReportDevice), { deviceId: '', source: '' });
});

test('selected controls retain their backend target precedence and a conflicting explicit selection blocks', () => {
  const controlDevice = 'hdc:controls-device';
  const ready = { ...newCase('task'), question: 'Test', deviceId: devices[0].id, contextRef: { historyId: 'saved' }, context: { deviceId: 'other-report' },
    targetSelection: { tokens: ['chosen'] }, targets: [{ token: 'unused', deviceId: 'different-device' }, { token: 'chosen', deviceId: controlDevice }] };
  const online = { ...context, devices: [...devices, { id: controlDevice, status: 'device' }] };
  assert.deepEqual(workspaceTaskTarget(ready), { deviceId: controlDevice, source: 'controls' });
  assert.deepEqual(workspaceReadiness(ready, online).missing, ['device']);
  assert.deepEqual(workspaceReadiness({ ...ready, deviceId: '' }, online).missing, []);
  assert.deepEqual(workspaceReadiness({ ...ready, deviceId: '' }, context).missing, ['device']);
});

test('field navigation unfolds ancestor details, then scrolls and focuses without activating controls', () => {
  const visits = [];
  const details = [{ open: false }, { open: false }];
  const control = {
    click: () => assert.fail('Navigation must not activate the control'),
    scrollIntoView: options => { assert.ok(details.every(item => item.open)); visits.push(['scroll', options]); },
    focus: options => visits.push(['focus', options]),
  };
  const field = { closest: () => details.find(item => !item.open), querySelector: () => control };
  const root = { querySelector: selector => selector === '#ai-workspace-required-package' ? field : null };
  focusWorkspaceRequiredField(root, 'package');
  assert.deepEqual(visits, [['scroll', { block: 'center' }], ['focus', { preventScroll: true }]]);
  focusWorkspaceRequiredField(root, 'device');
  assert.equal(visits.length, 2);
});

test('field navigation falls back to the field container when no usable control is available', () => {
  let focused = false;
  const fallback = { closest: () => null, querySelector: () => null, scrollIntoView: () => {}, focus: () => { focused = true; } };
  focusWorkspaceRequiredField({ querySelector: () => fallback }, 'device');
  assert.ok(focused);
});

test('an explicit no-candidate hint takes focus instead of an empty picker', () => {
  let focused = false;
  const hint = { scrollIntoView: () => {}, focus: () => { focused = true; } };
  const field = { closest: () => null, querySelector(selector) {
    assert.equal(selector, '[data-ai-required-input]');
    return hint;
  } };
  focusWorkspaceRequiredField({ querySelector: () => field }, 'device');
  assert.ok(focused);
});
