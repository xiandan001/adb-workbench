import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as stateHelpers from '../src/components/AiWorkspaceState.js';

function harness(overrides = {}) {
  const slots = []; let cursor = 0;
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
    .replace(/^import .+;\n/gm, '').replace('export default function useAiWorkspace', 'function useAiWorkspace');
  const controller = vm.runInNewContext(`${source}\nuseAiWorkspace`, {
    ...stateHelpers, crypto: { randomUUID }, window: { electronAPI }, navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    tr: text => text, useLocale: () => 'zh-CN', useCallback: fn => fn, useEffect: () => {},
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  });
  const render = () => { cursor = 0; return controller({ active: true, activeDeviceId: '', showToast() {}, onOpenTasks: id => opened.push(id) }); };
  const complete = async () => { let ui = render(); ui.setMode('analysis'); ui = render(); ui.edit({ question: 'synthetic question', text: 'fixture' }); await render().collect(); await render().analyze(); return render(); };
  return { render, complete, calls, clipboard, opened, preview, turn };
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
