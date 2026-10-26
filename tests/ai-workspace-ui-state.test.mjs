import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import { createWorkspaceCase, editWorkspaceCase, toggleWorkspaceSelection, workspaceDeviceOnline, workspacePreviewFresh, workspaceRequestCurrent } from '../src/components/AiWorkspaceState.js';

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
  }
});
