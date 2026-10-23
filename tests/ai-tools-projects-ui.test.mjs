import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDraft, projectInput, projectLaunchProvider, projectQuickStartAvailable, createProjectScope, projectPreviewFor } from '../src/components/ai-tools/aiProjectsModel.js';

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
test('detected-tool quick start requires a real detected path, exact tool identity and every existing permission', () => {
  const tools = [{ id: 'claude' }, { id: 'codex' }]; const detected = { id: 'codex', path: 'C:/fixture/codex.cmd' };
  assert.equal(projectQuickStartAvailable(detected, tools, () => true), true);
  assert.equal(projectDraft(null, detected.id).toolId, 'codex');
  for (const path of [null, '', ' ']) assert.equal(projectQuickStartAvailable({ ...detected, path }, tools, () => true), false);
  assert.equal(projectQuickStartAvailable({ ...detected, id: 'unknown' }, tools, () => true), false);
  for (const denied of ['projects_pick', 'projects_save', 'projects_launch_preview', 'projects_launch']) assert.equal(projectQuickStartAvailable(detected, tools, command => command !== denied), false, denied);
});
test('project scopes discard old save/picker/preview replies even when the user leaves and returns before they finish', async () => {
  const scope = createProjectScope(); const initial = scope.capture(); assert.equal(scope.current(initial), true);
  let resolve; const calls = []; const pending = new Promise(done => { resolve = done; });
  const continuation = pending.then(saved => { if (scope.current(initial)) calls.push(saved); });
  scope.setActive(false); assert.equal(scope.capture(), null); assert.equal(scope.current(initial), false);
  scope.setActive(true); resolve({ id: 'saved-on-background' }); await continuation; assert.deepEqual(calls, []);
  const current = scope.capture(); scope.setActive(true); assert.equal(scope.current(current), true);
  scope.setActive(false); assert.equal(scope.current(current), false);
});
test('launch preview belongs to the saved project and remains read-only until a separate explicit launch', () => {
  const project = { id: 'saved-project', toolId: 'codex' };
  const preview = { token: 'one-use', projectId: project.id, toolId: project.toolId, cwd: 'C:/fixture', executable: 'C:/fixture/codex.cmd', expiresAt: 100 };
  assert.equal(projectPreviewFor(project, preview, 10), preview);
  for (const change of [{ projectId: 'other' }, { toolId: 'agy' }, { token: '' }, { executable: '' }, { cwd: '' }, { expiresAt: 1 }, { expiresAt: undefined }]) assert.throws(() => projectPreviewFor(project, { ...preview, ...change }, 10), /预览/);
});
