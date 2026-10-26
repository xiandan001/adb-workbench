import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import taskParameters from '../electron/lib/ai-workspace-task.cjs';
import { AI_WORKSPACE_TURN_LIMIT, completeWorkspaceTurn, createWorkspaceCase, editWorkspaceCase, prepareWorkspaceContext, toggleWorkspaceSelection, workspaceCitation, workspaceDeviceOnline, workspaceLinePage, workspacePreviewFresh, workspaceReportKey, workspaceReportRef, workspaceRequestCurrent } from '../src/components/AiWorkspaceState.js';

test('AI workspace modes keep independent identities and snapshots', () => {
  const diagnosis = createWorkspaceCase('diagnose', 'device-a', 'case-a');
  const analysis = createWorkspaceCase('analysis', 'device-b', 'case-b');
  const changed = editWorkspaceCase(diagnosis, { question: 'synthetic question', checks: ['device_info'] });
  assert.equal(changed.deviceId, 'device-a');
  assert.equal(analysis.deviceId, 'device-b');
  assert.deepEqual(analysis.checks, []);
  assert.notEqual(changed.caseId, analysis.caseId);
});

test('changing evidence inputs invalidates consent preview and prior result', () => {
  const state = { ...createWorkspaceCase('analysis', '', 'a'), preview: { id: 'p' }, result: { summary: 'old' }, draft: { id: 'd' }, usage: { totalTokens: 12 }, plan: { checks: [] } };
  const next = editWorkspaceCase(state, { sourceIds: ['ssh:one'] });
  assert.equal(next.preview, null); assert.equal(next.result, null); assert.equal(next.draft, null); assert.equal(next.usage, null);
  assert.equal(next.revision, 1); assert.equal(state.revision, 0);
  assert.equal(editWorkspaceCase(next, { deviceId: 'another-device' }).plan, null);
});

test('completed reports survive edits while current send authorization is invalidated', () => {
  const base = createWorkspaceCase('analysis', '', 'case-a');
  const turn = { id: 'turn-a', preview: { id: 'preview-a', question: 'before', entries: [] }, result: { summary: 'frozen result' } };
  const completed = completeWorkspaceTurn({ ...base, preview: turn.preview }, { turn, result: turn.result, usage: null });
  const edited = editWorkspaceCase(completed, { question: 'after', selection: { ...base.selection, keywords: 'error' } });
  assert.equal(edited.preview, null);
  assert.equal(edited.result, null);
  assert.equal(edited.turns[0], turn);
  assert.equal(edited.reportView.report, turn);
  assert.equal(edited.reportView.report.preview.question, 'before');
});

test('completed turns are deduplicated and limited without changing frozen reports', () => {
  let state = createWorkspaceCase('analysis', '', 'case-a');
  for (let i = 0; i < 12; i++) state = completeWorkspaceTurn(state, { turn: { id: `turn-${i}` }, result: { summary: String(i) } });
  assert.equal(state.turns.length, AI_WORKSPACE_TURN_LIMIT);
  state = completeWorkspaceTurn(state, { turn: state.turns[0], result: state.result, cached: true });
  assert.equal(state.turns.length, AI_WORKSPACE_TURN_LIMIT);
  assert.equal(state.reportView.cached, true);
});

test('follow-up and regression handoffs only prepare state and do not reuse send tokens', () => {
  const report = { preview: { id: 'old-consent', question: 'original' }, result: { summary: 'summary', findings: [{ detail: 'one finding' }] } };
  const view = { report, reportRef: { historyId: 'saved' } };
  const task = prepareWorkspaceContext(createWorkspaceCase('task', '', 'task-case'), view, 'task', 0);
  assert.equal(task.preview, null); assert.equal(task.draft, null); assert.equal(task.question, '');
  assert.deepEqual(task.contextRef, { historyId: 'saved' }); assert.equal(task.findingIndex, 0);
  assert.equal(task.context.summary, 'summary'); assert.equal(task.context.finding.detail, 'one finding'); assert.equal(task.reportView, null);
  const followup = prepareWorkspaceContext(createWorkspaceCase('analysis', '', 'case'), view, 'followup');
  assert.deepEqual(followup.sourceIds, []); assert.equal(followup.text, ''); assert.equal(followup.busy, '');
  assert.equal(followup.reportView, view); assert.equal(followup.preview, null);
});

test('report selection only accepts declared reference forms', () => {
  for (const ref of [{ historyId: 'saved' }, { caseId: 'case', turnId: 'turn' }]) assert.deepEqual(workspaceReportRef(workspaceReportKey(ref)), ref);
  for (const key of ['', 'preview:token', 'history:', 'turn:one', 'turn:one:two:extra']) assert.equal(workspaceReportRef(key), null);
});

test('line citations validate retained lines and page navigation remains bounded', () => {
  const preview = { entries: [{ id: 'E1', text: Array.from({ length: 2000 }, (_, index) => `[L${index + 1}] synthetic`).join('\n') }] };
  const valid = { evidenceId: 'E1', startLine: 1950, endLine: 1960 };
  assert.deepEqual(workspaceCitation(preview, valid), valid);
  for (const citation of [{ ...valid, evidenceId: 'E2' }, { ...valid, startLine: 0 }, { ...valid, endLine: 2001 }, { ...valid, endLine: 1900 }, { ...valid, startLine: '1' }]) assert.equal(workspaceCitation(preview, citation), null);
  assert.equal(workspaceCitation({ entries: [{ id: 'E1', text: '' }] }, { evidenceId: 'E1', startLine: 1, endLine: 1 }), null);
  assert.deepEqual(workspaceLinePage(2000, 24), { page: 24, count: 25, start: 1920, end: 2000 });
  assert.equal(workspaceLinePage(2000, 999).page, 24); assert.equal(workspaceLinePage(2000, -1).page, 0);
});

test('inputs cannot mutate during collection or a model request', () => {
  const busy = { ...createWorkspaceCase('diagnose', 'a', 'case-a'), busy: 'collect' };
  assert.equal(editWorkspaceCase(busy, { deviceId: 'b' }), busy);
});

test('late responses cannot enter another case or a cancelled generation', () => {
  const state = { ...createWorkspaceCase('diagnose', 'a', 'case-a'), busy: 'analyze', revision: 4 };
  const token = { caseId: 'case-a', revision: 4, operation: 'analyze' };
  assert.equal(workspaceRequestCurrent(state, token), true);
  assert.equal(workspaceRequestCurrent({ ...state, caseId: 'case-b' }, token), false);
  assert.equal(workspaceRequestCurrent({ ...state, revision: 5 }, token), false);
  assert.equal(workspaceRequestCurrent({ ...state, busy: '' }, token), false);
});

test('device checks never substitute another online target', () => {
  const devices = [{ id: 'old', status: 'offline' }, { id: 'new', status: 'device' }];
  assert.equal(workspaceDeviceOnline(devices, 'old'), false);
  assert.equal(workspaceDeviceOnline(devices, 'new'), true);
  assert.equal(workspaceDeviceOnline(devices, ''), false);
});

test('selection and expired previews have explicit behavior', () => {
  assert.deepEqual(toggleWorkspaceSelection(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleWorkspaceSelection(['a', 'b'], 'a'), ['b']);
  assert.equal(workspacePreviewFresh({ id: 'p', expiresAt: 101 }, 100), true);
  assert.equal(workspacePreviewFresh({ id: 'p', expiresAt: '2026-10-26T12:00:00.000Z' }, Date.parse('2026-10-26T11:59:00.000Z')), true);
  assert.equal(workspacePreviewFresh({ id: 'p', expiresAt: 100 }, 100), false);
  assert.equal(workspacePreviewFresh({ id: 'p' }, 100), false);
});

test('AI workspace values interpolate through real catalogs in every language', () => {
  const locales = { 'en-US': 'en', 'zh-TW': 'tw', 'ja-JP': 'ja', 'ko-KR': 'ko' };
  const catalogs = Object.fromEntries(Object.entries(locales).map(([locale, prefix]) => [locale,
    ['core', 'workspace', 'tools', 'backend'].flatMap(domain => Object.entries(JSON.parse(fs.readFileSync(new URL(`../electron/locales/${prefix}-${domain}.json`, import.meta.url), 'utf8')))),
  ]));
  const translate = createMessageTranslator(catalogs);
  for (const locale of ['zh-CN', ...Object.keys(locales)]) {
    const coordinate = translate('坐标：{0}, {1}', { 0: 100, 1: 200 }, locale);
    assert.match(coordinate, /100, 200/); assert.doesNotMatch(coordinate, /\{[^}]+\}/);
    const usage = translate('本次用量：输入 {0} · 输出 {1} · 合计 {2} tokens', { 0: 5, 1: 4, 2: 9 }, locale);
    assert.match(usage, /5/); assert.match(usage, /4/); assert.match(usage, /9/); assert.doesNotMatch(usage, /\{[^}]+\}/);
    assert.match(translate('查看证据 {0}', { 0: 'E1' }, locale), /E1/);
    const example = translate('例如：等待首页出现“设置”，点击坐标 (100, 200)，截图并采集性能。请给出可核对的参数。', {}, locale);
    assert.match(example, /\(100, 200\)/);
    assert.doesNotThrow(() => taskParameters.validateInteractions({ steps: [{ type: 'tap', x: 100, y: 200 }] }, example));
  }
});
