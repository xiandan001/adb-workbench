import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as stateHelpers from '../src/components/AiWorkspaceState.js';
import * as flowHelpers from '../src/components/AiWorkspaceFlow.js';
import * as editingHelpers from '../src/components/AiWorkspaceTaskEditing.js';

function harness(overrides = {}) {
  const slots = []; let cursor = 0;
  let handoffCallback;
  const calls = []; const clipboard = []; const opened = [];
  const preview = { id: 'synthetic-preview', question: 'synthetic question', entries: [{ id: 'E1', text: '[L1] synthetic', numbered: true }], expiresAt: new Date(Date.now() + 60000).toISOString() };
  const result = { summary: 'synthetic finding', findings: [{ title: 'fixture', detail: 'fixture detail', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }], hypotheses: [], nextSteps: [], limitations: [] };
  const turn = { id: 'synthetic-turn', kind: 'analysis', createdAt: new Date().toISOString(), preview, result, usage: null };
  const handlers = {
    aiWorkspaceSources: async () => ({ ok: true, entitled: true, sources: [], checks: [] }),
    aiWorkspaceHistoryList: async () => ({ ok: true, items: [{ id: 'saved-report', name: 'saved', createdAt: turn.createdAt }] }),
    aiWorkspaceCollect: async () => ({ ok: true, preview }),
    aiWorkspaceAnalyze: async () => ({ ok: true, turn, result, usage: null }),
    aiWorkspaceGenerateTask: async () => ({ ok: true, draft: { id: 'draft', name: 'test', expiresAt: preview.expiresAt, steps: [{ type: 'screenshot', label: 'capture' }] } }),
    aiWorkspaceSaveTask: async () => ({ ok: true, script: { id: 'saved-task' } }),
    aiWorkspaceHistoryLoad: async () => ({ ok: true, report: { ...turn, id: 'saved-report', turnId: turn.id, name: 'saved' } }),
    aiWorkspaceComparisonPreview: async () => ({ ok: true, preview: { ...preview, id: 'compare-preview', comparison: { beforeIds: ['E1'], afterIds: ['E2'], comparable: false, warnings: [] } } }),
    aiWorkspaceCancel: async () => ({ ok: true, cancelled: true }),
    aiWorkspaceReportText: async () => ({ ok: true, text: '# synthetic report' }),
    aiWorkspaceHistoryExport: async () => ({ ok: true, cancelled: true }),
    aiWorkspaceHistorySave: async () => ({ ok: true, item: { id: 'saved-report' } }),
    ...overrides,
  };
  const electronAPI = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async args => { calls.push({ name, args }); return fn(args); }]));
  const source = fs.readFileSync(new URL('../src/components/AiWorkspaceController.js', import.meta.url), 'utf8')
    .replace(/^import .+;\n/gm, '').replace('export default function useAiWorkspace', 'function useAiWorkspace')
    // Capture the actual private callback without altering its implementation.
    .replace('  return { mode, setMode, cases,', '  captureHandoff(acceptHandoff);\n  return { mode, setMode, cases,');
  const controller = vm.runInNewContext(`${source}\nuseAiWorkspace`, {
    ...stateHelpers, ...flowHelpers, ...editingHelpers, crypto: { randomUUID }, window: { electronAPI }, navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    tr: text => text, useLocale: () => 'zh-CN', useCallback: fn => fn, useEffect: () => {},
    captureHandoff: callback => { handoffCallback = callback; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  });
  const render = () => { cursor = 0; return controller({ active: true, activeDeviceId: '', showToast() {}, onOpenTasks: id => opened.push(id) }); };
  const complete = async () => { let ui = render(); ui.setMode('analysis'); ui = render(); ui.edit({ question: 'synthetic question', text: 'fixture' }); await render().collect(); await render().analyze(); return render(); };
  return { render, complete, calls, clipboard, opened, preview, turn, get acceptHandoff() { return handoffCallback; } };
}

test('follow-up and task buttons transfer context without collecting, inferring, or executing', async () => {
  const h = harness(); let ui = await h.complete(); const count = h.calls.length;
  ui.useContext('followup'); ui = h.render();
  assert.equal(h.calls.length, count); assert.equal(ui.mode, 'analysis'); assert.equal(ui.current.preview, null);
  assert.equal(ui.current.contextRef.turnId, h.turn.id); assert.equal(ui.current.question, '');
  ui.edit({ question: 'followup question' }); await h.render().collect();
  assert.equal(h.calls.at(-1).name, 'aiWorkspaceCollect'); assert.equal(h.calls.at(-1).args.contextRef.turnId, h.turn.id);
  assert.equal(Object.hasOwn(h.calls.at(-1).args, 'selection'), false);
  assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceAnalyze').length, 1);
  ui = h.render(); ui.selectTurn(h.turn.id); h.render().useContext('task', 0); ui = h.render();
  const before = h.calls.length; assert.equal(ui.mode, 'task'); assert.equal(ui.current.findingIndex, 0);
  ui.edit({ question: 'regression goal', requirements: { application: 'fixture.app', target: 'known text', preconditions: '', expectedResult: 'visible' } });
  assert.equal(h.calls.length, before); await h.render().generate();
  assert.equal(h.calls.at(-1).args.contextRef.turnId, h.turn.id); assert.equal(h.calls.at(-1).args.requirements.application, 'fixture.app');
  assert.deepEqual(h.opened, []); await h.render().save(); assert.deepEqual(h.opened, ['saved-task']);
});

test('only an explicit follow-up filter change reselects prior frozen evidence', async () => {
  const h = harness(); let ui = await h.complete(); ui.useContext('followup'); ui = h.render();
  ui.edit({ question: 'focus on errors', selection: { ...ui.current.selection, keywords: 'error,timeout', contextLines: 2 } });
  await h.render().collect();
  assert.equal(h.calls.at(-1).args.selection.keywords, 'error,timeout');
  assert.equal(h.calls.at(-1).args.selection.contextLines, 2);
});

test('history opens read-only without restoring a preview token or calling AI', async () => {
  const h = harness(); await h.render().loadHistory('saved-report'); const ui = h.render();
  assert.equal(ui.current.preview, null); assert.equal(ui.current.reportView.reportRef.historyId, 'saved-report');
  assert.deepEqual(h.calls.map(call => call.name), ['aiWorkspaceHistoryLoad']);
  await ui.exportReport(true); assert.deepEqual(h.clipboard, ['# synthetic report']);
  assert.equal(h.calls.at(-1).args.reportRef.historyId, 'saved-report');
});

test('comparison freezes a new preview without automatically analyzing it', async () => {
  const h = harness(); let ui = await h.complete(); ui.setBaseline('history:saved-report'); await h.render().compare(); ui = h.render();
  assert.equal(ui.current.preview.id, 'compare-preview'); assert.equal(ui.current.reportView, null);
  assert.equal(h.calls.at(-1).name, 'aiWorkspaceComparisonPreview'); assert.equal(h.calls.at(-1).args.beforeRef.historyId, 'saved-report');
  assert.equal(h.calls.at(-1).args.afterRef.turnId, h.turn.id);
  assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceAnalyze').length, 1);
});

test('cancelled analysis cannot append a late completed turn', async () => {
  let finish;
  const h = harness({ aiWorkspaceAnalyze: () => new Promise(resolve => { finish = resolve; }) });
  let ui = h.render(); ui.setMode('analysis'); ui = h.render(); ui.edit({ question: 'fixture', text: 'fixture' });
  await h.render().collect(); const pending = h.render().analyze(); await h.render().cancel();
  finish({ ok: true, turn: h.turn, result: h.turn.result }); await pending;
  assert.equal(h.render().current.turns.length, 0); assert.equal(h.render().current.busy, '');
});

test('late history load cannot overwrite a newly edited case', async () => {
  let finish;
  const h = harness({ aiWorkspaceHistoryLoad: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.render().loadHistory('saved-report'); h.render().edit({ question: 'new input' });
  finish({ ok: true, report: h.turn }); await pending;
  assert.equal(h.render().current.question, 'new input'); assert.equal(h.render().current.reportView, null);
});

test('verification click prepares the original question and device without collecting or sending', async () => {
  const h = harness({ aiWorkspaceSources: async () => ({ ok: true, entitled: true, sources: [], checks: [{ id: 'device_info' }, { id: 'logcat_snapshot' }] }) });
  h.preview.deviceId = 'fixture-A'; h.turn.result.verificationChecks = [{ title: 'Check device', checkIds: ['device_info'], expectedObservation: 'Compare identity.' }];
  let ui = await h.complete(); await ui.refresh(); ui = h.render(); const before = h.calls.length;
  ui.prepareVerification(0); ui = h.render();
  assert.equal(h.calls.length, before); assert.equal(ui.mode, 'diagnose'); assert.equal(ui.current.deviceId, 'fixture-A');
  assert.equal(ui.current.question, h.preview.question); assert.deepEqual(Array.from(ui.current.checks), ['device_info']);
  assert.equal(ui.current.contextRef.turnId, h.turn.id); assert.equal(ui.current.preview, null);
  await ui.collect(); assert.equal(h.calls.at(-1).name, 'aiWorkspaceCollect'); assert.equal(h.calls.at(-1).args.deviceId, 'fixture-A');
  assert.equal(h.calls.at(-1).args.contextRef.turnId, h.turn.id); assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceAnalyze').length, 1);
});

test('external report requests queue while collecting and require explicit opening afterwards', async () => {
  let release;
  const h = harness({ aiWorkspaceCollect: () => new Promise(resolve => { release = resolve; }) });
  let ui = h.render(); ui.edit({ question: 'Preserve this draft' }); const collecting = h.render().collect();
  const request = { requestId: 'request', historyId: '11111111-1111-4111-8111-111111111111' };
  await h.render().openRequestedReport(request); assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceHistoryLoad').length, 0);
  assert.equal(h.render().pendingReport.requestId, 'request');
  release({ ok: true, preview: h.preview }); await collecting;
  assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceHistoryLoad').length, 0);
  await h.render().acceptPendingReport(); ui = h.render();
  assert.equal(ui.mode, 'analysis'); assert.equal(ui.current.reportView.reportRef.historyId, request.historyId);
  assert.equal(ui.current.preview, null); assert.equal(ui.cases.diagnose.question, 'Preserve this draft');
  assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceAnalyze').length, 0);
});

test('a late external report load cannot replace newly edited analysis input', async () => {
  let release;
  const h = harness({ aiWorkspaceHistoryLoad: () => new Promise(resolve => { release = resolve; }) });
  h.render().setMode('analysis'); h.render().edit({ question: 'before' });
  const pending = h.render().openRequestedReport({ requestId: 'request', historyId: '11111111-1111-4111-8111-111111111111' });
  h.render().edit({ question: 'after' }); release({ ok: true, report: h.turn }); await pending;
  assert.equal(h.render().current.question, 'after'); assert.equal(h.render().current.reportView, null);
});

test('basket restore and removal preserve the question and completed report while revoking the current preview', async () => {
  const item = { id: 'basket-item', title: 'Frozen logs' };
  const h = harness({ aiHandoffList: async () => ({ ok: true, basket: { revision: 1, items: [item] } }),
    aiHandoffRemove: async () => ({ ok: true, basket: { revision: 2, items: [] } }) });
  await h.complete(); await h.render().refresh();
  let ui = h.render(); assert.equal(ui.current.question, 'synthetic question'); assert.equal(ui.current.basketItems[0].id, item.id);
  assert.equal(ui.current.preview, null); assert.equal(ui.current.reportView.report.id, h.turn.id);
  await ui.collect(); assert.equal(h.calls.at(-1).args.basketRevision, 1);
  await h.render().removeBasketItem(item.id); ui = h.render();
  assert.equal(ui.current.basketItems.length, 0); assert.equal(ui.current.question, 'synthetic question'); assert.equal(ui.current.preview, null);
  assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceAnalyze').length, 1);
});

test('busy collection queues basket refresh and leaves the frozen operation untouched until explicit apply', async () => {
  let finish;
  const h = harness({ aiHandoffList: async () => ({ ok: true, basket: { revision: 1, items: [{ id: 'one' }] } }),
    aiWorkspaceCollect: () => new Promise(resolve => { finish = resolve; }) });
  h.render().setMode('analysis'); h.render().edit({ question: 'Keep problem', text: 'fixture' });
  const pending = h.render().collect(); await h.render().refreshBasket();
  assert.equal(h.render().pendingBasket, true); assert.equal(h.render().current.basketRevision, null);
  finish({ ok: true, preview: h.preview }); await pending;
  assert.equal(h.render().current.preview.id, h.preview.id);
  await h.render().refreshBasket(); assert.equal(h.render().current.preview, null); assert.equal(h.render().current.question, 'Keep problem');
});

test('edited task parameters survive mode changes and failed saves without any new model call', async () => {
  const h = harness({ aiWorkspaceSaveTask: async () => ({ ok: false, error: 'Invalid edited parameter' }) });
  h.render().setMode('task'); h.render().edit({ question: 'Fixture goal' }); await h.render().generate();
  const edited = { name: 'Edited name', description: 'Manual values', steps: [{ type: 'delay', label: 'Manual wait', durationMs: 300 }] };
  h.render().editDraft(edited); h.render().setMode('analysis'); h.render().setMode('task');
  assert.equal(h.render().current.draftEdits.name, edited.name);
  await h.render().save(h.render().current.draftEdits);
  assert.equal(h.render().current.error, 'Invalid edited parameter'); assert.equal(h.render().current.draftEdits.name, edited.name);
  assert.equal(h.calls.at(-1).args.editedDraft.name, edited.name); assert.equal(h.calls.filter(call => call.name === 'aiWorkspaceGenerateTask').length, 1);
});

test('out-of-order basket lists cannot replace a newer revision or resurrect removed metadata', async () => {
  const pending = [];
  const h = harness({ aiHandoffList: () => new Promise(resolve => pending.push(resolve)) });
  h.render().setMode('analysis'); h.render().edit({ question: 'Keep current problem' });
  const first = h.render().refreshBasket(), second = h.render().refreshBasket();
  pending[1]({ ok: true, basket: { revision: 2, items: [{ id: 'new-item' }] } }); await second;
  pending[0]({ ok: true, basket: { revision: 1, items: [{ id: 'removed-old-item' }] } }); await first;
  const current = h.render().current;
  assert.equal(current.basketRevision, 2); assert.equal(current.basketItems[0].id, 'new-item'); assert.equal(current.question, 'Keep current problem');
});

for (const operation of ['remove', 'clear', 'reset']) test(`a late list crossing ${operation} cannot restore cleared basket metadata`, async () => {
  let finishList;
  const h = harness({ aiHandoffList: () => new Promise(resolve => { finishList = resolve; }),
    aiHandoffRemove: async () => ({ ok: true, basket: { revision: 3, items: [] } }),
    aiHandoffClear: async () => ({ ok: true, basket: { revision: 3, items: [] } }) });
  h.render().setMode('analysis'); h.render().edit({ question: 'Original problem' });
  const pending = h.render().refreshBasket();
  await (operation === 'remove' ? h.render().removeBasketItem('old') : operation === 'clear' ? h.render().clearBasket() : h.render().reset());
  finishList({ ok: true, basket: { revision: 2, items: [{ id: 'removed' }] } }); await pending;
  assert.equal(h.render().current.basketRevision, 3); assert.equal(h.render().current.basketItems.length, 0);
  assert.equal(h.render().current.question, operation === 'reset' ? '' : 'Original problem');
});

test('a later lower-revision list and stale errors cannot downgrade or overwrite the current basket', async () => {
  const pending = [];
  const h = harness({ aiHandoffList: () => new Promise(resolve => pending.push(resolve)) });
  h.render().setMode('analysis');
  const old = h.render().refreshBasket(), current = h.render().refreshBasket();
  pending[1]({ ok: true, basket: { revision: 7, items: [{ id: 'current' }] } }); await current;
  pending[0]({ ok: false, error: 'Old list error' }); await old;
  assert.equal(h.render().sourceError, '');
  const stale = h.render().refreshBasket(); pending[2]({ ok: true, basket: { revision: 6, items: [{ id: 'old' }] } }); await stale;
  assert.equal(h.render().current.basketRevision, 7); assert.equal(h.render().current.basketItems[0].id, 'current');
});

test('older handoff completion cannot replace the question or mode chosen by a newer handoff', async () => {
  const pending = [];
  const h = harness({ aiHandoffList: () => new Promise(resolve => pending.push(resolve)) });
  h.render();
  const first = h.acceptHandoff({ id: 'first', basketItem: true, question: 'First problem' });
  h.render(); const second = h.acceptHandoff({ id: 'second', basketItem: true, question: 'Second problem' });
  pending[1]({ ok: true, basket: { revision: 2, items: [{ id: 'first' }, { id: 'second' }] } }); await second;
  pending[0]({ ok: true, basket: { revision: 1, items: [{ id: 'first' }] } }); await first;
  assert.equal(h.render().mode, 'analysis'); assert.equal(h.render().current.question, 'Second problem');
  assert.equal(h.render().current.basketRevision, 2); assert.equal(h.render().pendingHandoff, null);
});

test('clearing the basket while a handoff loads prevents late question or material restoration', async () => {
  let finish;
  const h = harness({ aiHandoffList: () => new Promise(resolve => { finish = resolve; }),
    aiHandoffClear: async () => ({ ok: true, basket: { revision: 3, items: [] } }) });
  h.render().setMode('analysis'); h.render().edit({ question: 'Keep existing problem' });
  const handoff = h.acceptHandoff({ id: 'removed', basketItem: true, question: 'Removed material question' });
  await h.render().clearBasket(); finish({ ok: true, basket: { revision: 2, items: [{ id: 'removed' }] } }); await handoff;
  assert.equal(h.render().current.question, 'Keep existing problem'); assert.equal(h.render().current.basketRevision, 3);
  assert.equal(h.render().current.basketItems.length, 0); assert.equal(h.render().pendingHandoff, null);
});

test('superseded source or locale refresh cannot start a later stale basket request', async () => {
  const sources = [];
  const h = harness({ aiWorkspaceSources: () => new Promise(resolve => sources.push(resolve)),
    aiHandoffList: async () => ({ ok: true, basket: { revision: 2, items: [{ id: 'current' }] } }) });
  const first = h.render().refresh(), second = h.render().refresh();
  sources[1]({ ok: true, sources: [], checks: [], entitled: true }); await second;
  sources[0]({ ok: true, sources: [], checks: [], entitled: true }); await first;
  assert.equal(h.calls.filter(call => call.name === 'aiHandoffList').length, 1); assert.equal(h.render().cases.analysis.basketRevision, 2);
});
