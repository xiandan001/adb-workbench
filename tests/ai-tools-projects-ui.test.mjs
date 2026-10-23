import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDraft, projectInput, projectLaunchProvider } from '../src/components/ai-tools/aiProjectsModel.js';

test('AI project saves carry native directory grants, never an arbitrary renderer path or command', () => {
  const tools = [{ id: 'codex', command: 'codex' }];
  const draft = { ...projectDraft(null, 'codex'), name: 'Project', path: 'C:/fake-path' };
  assert.throws(() => projectInput(draft, tools), /选择/);
  const input = projectInput({ ...draft, directoryToken: 'native-token', command: 'not-allowed' }, tools);
  assert.deepEqual(input, { name: 'Project', toolId: 'codex', pinned: false, directoryToken: 'native-token' });
  const existing = projectInput(projectDraft({ id: 'one', name: 'Old', path: 'C:/workspace', toolId: 'codex', pinned: true }), tools);
  assert.equal(Object.hasOwn(existing, 'path'), false); assert.equal(Object.hasOwn(existing, 'directoryToken'), false);
});
test('AGY managed launch only offers explicitly targeted Gemini credentials and a model', () => {
  const provider = { protocol: 'gemini', hasCredential: true, model: 'model', targetApps: ['agy'] };
  assert.equal(projectLaunchProvider(provider), true);
  for (const change of [{ protocol: 'openai-chat' }, { hasCredential: false }, { model: '' }, { targetApps: ['gemini'] }]) assert.equal(Boolean(projectLaunchProvider({ ...provider, ...change })), false);
});
test('migrated project origin is informational and only a native directory grant is submitted on relocation', () => {
  const imported = { id: 'imported', name: 'Imported', path: '', oldPath: 'C:/old-machine/project', needsRelocation: true, pinned: false, toolId: 'codex' };
  const draft = projectDraft(imported); assert.equal(draft.path, ''); assert.equal(draft.oldPath, imported.oldPath); assert.equal(draft.needsRelocation, true);
  const input = projectInput({ ...draft, directoryToken: 'native-relocation', path: 'C:/new-machine/project' }, [{ id: 'codex' }]);
  assert.deepEqual(input, { id: 'imported', name: 'Imported', toolId: 'codex', pinned: false, directoryToken: 'native-relocation' });
  assert.equal(Object.hasOwn(input, 'oldPath'), false); assert.equal(Object.hasOwn(input, 'needsRelocation'), false);
});
