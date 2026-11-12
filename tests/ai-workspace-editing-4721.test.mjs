import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { editableTask, newEditableStep, moveEditableStep } from '../src/components/AiWorkspaceTaskEditing.js';
import { appendWorkspaceBasket, createWorkspaceCase } from '../src/components/AiWorkspaceState.js';
import { normalizeLogFilter, normalizeLogBuffers } from '../src/shared/logWorkspace.js';

test('local step editing clones only editable fields and deterministically adds and orders steps', () => {
  const original = { id: 'opaque', targetPlatform: 'harmony', steps: [{ type: 'screenshot', label: 'Shot' }], name: 'Draft', description: '' };
  const edited = editableTask(original); assert.equal(edited.id, undefined); assert.equal(edited.targetPlatform, undefined);
  edited.steps[0].label = 'Changed'; assert.equal(original.steps[0].label, 'Shot');
  const second = newEditableStep('delay'); assert.equal(second.durationMs, 1000);
  const ordered = moveEditableStep([...edited.steps, second], 1, -1); assert.equal(ordered[0], second);
  assert.equal(moveEditableStep(ordered, 0, -1), ordered); assert.equal(newEditableStep('keyevent', 'harmony').keyCode, 'Back');
});

test('basket appends preserve existing problem, reports and draft and cannot mutate a busy case', () => {
  const current = { ...createWorkspaceCase('analysis', 'original', 'case'), question: 'Keep problem', draft: { id: 'draft' },
    reportView: { report: { id: 'completed' } }, preview: { id: 'old-preview' } };
  const next = appendWorkspaceBasket(current, { revision: 2, items: [{ id: 'two' }] }, { question: 'Incoming' });
  assert.equal(next.question, current.question); assert.equal(next.draft, current.draft); assert.equal(next.reportView, current.reportView);
  assert.equal(next.preview, null); assert.equal(next.deviceId, 'original'); assert.equal(next.basketRevision, 2);
  const busy = { ...current, busy: 'analyze' }; assert.equal(appendWorkspaceBasket(busy, { revision: 3, items: [] }), busy);
});

test('editing a generated task labels original missing-information notes as historical rather than current validation', () => {
  const require = createRequire(import.meta.url), parser = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = fs.readFileSync(new URL('../src/components/AiWorkspaceResults.jsx', import.meta.url), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }); let changed, title;
  traverse(ast, {
    VariableDeclarator({ node }) { if (node.id.name === 'locallyEdited') changed = source.slice(node.init.start, node.init.end); },
    JSXOpeningElement({ node }) {
      if (node.name.name !== 'ResultList') return;
      const value = node.attributes.find(item => item.name?.name === 'title')?.value?.expression;
      if (value && source.slice(value.start, value.end).includes('locallyEdited')) title = source.slice(value.start, value.end);
    }
  });
  assert.ok(changed); assert.ok(title);
  const draft = { name: 'Draft', description: '', steps: [{ type: 'delay', label: 'Observe', durationMs: 100 }], missingInformation: ['original model guidance'] };
  const unchanged = editableTask(draft), edited = { ...unchanged, steps: [...unchanged.steps, newEditableStep('tap')] };
  assert.equal(vm.runInNewContext(changed, { edited: unchanged, draft, editableTask }), false);
  assert.equal(vm.runInNewContext(changed, { edited, draft, editableTask }), true);
  assert.equal(vm.runInNewContext(title, { locallyEdited: true, tr: value => value }), '生成时的补充提示（请按当前编辑结果重新核对）');
  assert.deepEqual(draft.missingInformation, ['original model guidance']);
});

test('log workset context only updates local selections and queues running captures for explicit application', () => {
  const require = createRequire(import.meta.url), parser = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }); let body;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === 'applyContext') body = source.slice(node.init.arguments[0].start, node.init.arguments[0].end); } });
  assert.ok(body); const changes = [], runningRef = { current: true }, aiAnalyzingRef = { current: false };
  const context = { deviceId: 'workset-device', worksetLogs: { filter: { text: 'error', tag: 'Fixture' }, buffers: ['crash'] } };
  const apply = vm.runInNewContext(`(${body})`, { runningRef, aiAnalyzingRef, clearTimeout() {}, filterDebounceRef: {}, tr: value => value,
    normalizeLogFilter, normalizeLogBuffers, setPendingLogContext: value => changes.push(['pending', value]), setNote() {},
    setDeviceId: value => changes.push(['device', value]), setFilter: value => changes.push(['filter', value]),
    setFilterTextInput: value => changes.push(['text', value]), setBuffers: value => changes.push(['buffers', value]) });
  apply(context); assert.deepEqual(changes, [['pending', context]]);
  changes.length = 0; runningRef.current = false; apply(context);
  assert.deepEqual(changes[0], ['device', 'workset-device']); assert.deepEqual(changes[1], ['filter', context.worksetLogs.filter]);
  assert.deepEqual(changes[3], ['buffers', ['crash']]); assert.deepEqual(changes[4], ['pending', null]);
  assert.doesNotMatch(body, /logAnalyzerStart|aiAnalyze|connect|runAdb/);
  assert.match(source, /useLogWorksetMemory\(\{ deviceId, filter, buffers \}\)/);
  assert.match(source, /disabled=\{running \|\| aiAnalyzing\} onClick=\{\(\) => applyContext\(pendingLogContext\)\}/);
});
