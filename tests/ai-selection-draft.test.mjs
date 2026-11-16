import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_DRAFT_KEY, aiSelectionDraft, normalizeAiSelectionDraft, readAiSelectionDraft, saveAiSelectionDraft, restoreAiSelectionDraft } from '../src/shared/aiSelectionDraft.js';
import { createWorkspaceCase, editWorkspaceCase } from '../src/components/AiWorkspaceState.js';
import { adoptWorkspaceDefaults, collectedPreviewCanReview } from '../src/components/AiWorkspaceFlow.js';

const modes = ['diagnose', 'analysis', 'task'];
const cases = () => Object.fromEntries(modes.map(mode => [mode, createWorkspaceCase(mode, '', `old-${mode}`)]));
const memory = () => { const values = new Map(); let writes = 0; return { values, get writes() { return writes; }, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes++; } }; };
const devices = [{ id: 'A', status: 'device' }, { id: 'B', status: 'device' }];

test('automatic draft projection includes selection metadata only, never text/evidence/results/commands/authorization', () => {
  const current = cases(); current.diagnose = { ...current.diagnose, deviceId: 'A', diagnostic: { packageName: 'com.fixture', symptom: 'slow' },
    question: 'sensitive question', text: 'raw secret', preview: { id: 'permission-token', entries: [{ text: 'raw' }] },
    contextRef: { turnId: 'old-turn' }, context: { summary: 'secret' }, handoffId: 'token', targetSelection: { tokens: ['target'] },
    draft: { steps: [{ command: 'reboot' }] }, savedTask: { id: 'saved' }, turns: [{ result: 'secret' }], result: { summary: 'secret' }, usage: { total: 123 } };
  const selection = aiSelectionDraft('diagnose', current), serialized = JSON.stringify(selection);
  assert.deepEqual(Object.keys(selection.cases.diagnose), ['deviceId', 'checks', 'diagnostic']);
  for (const value of ['sensitive', 'raw secret', 'permission-token', 'old-turn', 'reboot', 'targetSelection', 'savedTask', 'usage']) assert.equal(serialized.includes(value), false);
  assert.equal(selection.cases.diagnose.diagnostic.packageName, 'com.fixture');
});

test('draft restore creates fresh cases without reusable evidence or grants and keeps restored targets pinned', () => {
  const current = cases(); current.diagnose.deviceId = 'A'; current.task.deviceId = 'A'; current.task.diagnostic.packageName = 'com.task';
  const selection = aiSelectionDraft('task', current); let nextId = 0;
  const restored = restoreAiSelectionDraft(selection, (mode, id) => createWorkspaceCase(mode, id, `fresh-${++nextId}`));
  assert.equal(restored.mode, 'task'); assert.notEqual(restored.cases.diagnose.caseId, current.diagnose.caseId);
  assert.equal(restored.cases.diagnose.pristine, false); assert.equal(restored.cases.analysis.pristine, true);
  assert.equal(restored.cases.task.requirements.application, 'com.task');
  for (const item of Object.values(restored.cases)) {
    assert.equal(item.question, ''); assert.equal(item.text, ''); assert.equal(item.preview, null); assert.equal(item.contextRef, null);
    assert.equal(item.draft, null); assert.equal(item.result, null); assert.deepEqual(item.targetSelection.tokens, []); assert.equal(item.busy, '');
  }
  assert.equal(adoptWorkspaceDefaults(restored.cases.diagnose, devices, 'B', { deviceId: 'B', packageName: 'com.other' }), restored.cases.diagnose);
});

test('draft readers are exact, bounded and preserve corrupt originals; identical metadata avoids repeated writes', () => {
  const storage = memory(), selection = aiSelectionDraft('analysis', cases());
  saveAiSelectionDraft(selection, storage); saveAiSelectionDraft(selection, storage); assert.equal(storage.writes, 1);
  assert.deepEqual(readAiSelectionDraft(storage), selection);
  for (const mutate of [value => { value.extra = true; }, value => { value.cases.analysis.question = 'secret'; },
    value => { value.cases.task.diagnostic.packageName = 'x'.repeat(201); }, value => { value.cases.task.deviceId = 'space id'; },
    value => { value.cases.task.checks = ['unknown']; }, value => { value.cases.task.diagnostic.symptom = 'arbitrary'; },
    value => { value.cases.task.checks = ['app_memory', 'app_memory']; }]) {
    const invalid = structuredClone(selection); mutate(invalid); assert.throws(() => normalizeAiSelectionDraft(invalid));
  }
  for (const corrupt of ['{bad', ' '.repeat(16385)]) {
    storage.values.set(AI_DRAFT_KEY, corrupt); assert.throws(() => saveAiSelectionDraft(selection, storage)); assert.equal(storage.values.get(AI_DRAFT_KEY), corrupt);
  }
  const before = JSON.stringify(selection); storage.values.set(AI_DRAFT_KEY, before); storage.setItem = () => { throw new Error('quota'); };
  const changed = structuredClone(selection); changed.mode = 'task'; assert.throws(() => saveAiSelectionDraft(changed, storage), /quota/);
  assert.equal(storage.values.get(AI_DRAFT_KEY), before);
});

test('shared application defaults seed only untouched idle unbound cases with the exact online device', () => {
  const fresh = createWorkspaceCase('diagnose', '', 'case');
  const seeded = adoptWorkspaceDefaults(fresh, devices, 'A', { deviceId: 'A', packageName: 'com.fixture' });
  assert.equal(seeded.deviceId, 'A'); assert.equal(seeded.diagnostic.packageName, 'com.fixture'); assert.equal(seeded.question, '');
  assert.equal(adoptWorkspaceDefaults(fresh, devices, 'A', { deviceId: 'B', packageName: 'com.wrong' }).diagnostic.packageName, '');
  for (const patch of [{ pristine: false }, { busy: 'collect' }, { handoffId: 'bound' }, { contextRef: { turnId: 'bound' } }, { reportView: { report: {} } },
    { preview: { id: 'frozen' } }, { result: { summary: 'bound' } }, { draft: { id: 'draft' } }]) {
    const locked = { ...seeded, ...patch }; assert.equal(adoptWorkspaceDefaults(locked, devices, 'B', { deviceId: 'B', packageName: 'com.other' }), locked);
  }
  const edited = editWorkspaceCase(seeded, { question: 'work in progress' });
  assert.equal(adoptWorkspaceDefaults(edited, devices, 'B', { deviceId: 'B', packageName: 'com.other' }), edited);
  const task = adoptWorkspaceDefaults(createWorkspaceCase('task', '', 'task'), devices, 'A', { deviceId: 'A', packageName: 'com.fixture' });
  assert.equal(task.requirements.application, 'com.fixture');
});

test('automatic transition to final review rejects stale, cancelled, replaced or expired collection results', () => {
  const token = { caseId: 'case', revision: 2 }, current = { ...createWorkspaceCase('diagnose', 'A', 'case'), revision: 2,
    preview: { id: 'preview', expiresAt: new Date(Date.now() + 60000).toISOString() } };
  assert.equal(collectedPreviewCanReview(current, token, 'preview'), true);
  for (const patch of [{ revision: 3 }, { caseId: 'new' }, { busy: 'collect' }, { preview: { id: 'different', expiresAt: current.preview.expiresAt } },
    { preview: { id: 'preview', expiresAt: new Date(0).toISOString() } }, { preview: null }]) assert.equal(collectedPreviewCanReview({ ...current, ...patch }, token, 'preview'), false);
});
