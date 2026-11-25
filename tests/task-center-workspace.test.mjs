import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_DRAFT_KEY, draftFingerprint, readTaskDraft, writeTaskDraft,
  getMatchingBaseline, getAcceptanceErrors, qualityErrorMessage, resolveScriptAfterSave
} from '../src/shared/taskCenterWorkspace.js';
import { createSingleReplayScript } from '../src/shared/taskCenterOnboarding.js';

test('draft and saved checkpoint survive storage round-trip', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const saved = { id: 'one', name: '原脚本', steps: [] };
  const draft = { ...saved, steps: [{ id: 'tap', type: 'tap', x: 1, y: 2 }] };
  const workspace = { draft, savedFingerprint: draftFingerprint(saved), workspaceView: 'recording' };
  assert.equal(writeTaskDraft(workspace, storage), '');
  const restored = readTaskDraft(storage).workspace;
  assert.deepEqual(restored.draft, draft);
  assert.notEqual(draftFingerprint(restored.draft), restored.savedFingerprint);
  assert.equal(restored.workspaceView, 'recording');
  assert.ok(entries.has(TASK_DRAFT_KEY));
});

test('recording draft restoration keeps long-press duration and curved replay waypoints', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const steps = [
    { id: 'hold', type: 'longPress', x: 20, y: 30, durationMs: 800 },
    { id: 'curve', type: 'swipe', x: 28, y: 32, endX: 91, endY: 58, durationMs: 480,
      points: [{ x: 28, y: 32 }, { x: 51, y: 92 }, { x: 91, y: 58 }] },
  ];
  assert.equal(writeTaskDraft({ draft: { steps }, workspaceView: 'recording' }, storage), '');
  const replay = createSingleReplayScript(readTaskDraft(storage).workspace.draft);
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.loop.count, 1);
  assert.deepEqual(replay.steps, steps);
});

test('save then continue to the same script uses the fresh saved object, not the captured old selection', () => {
  const capturedScript = { id: 'A', name: '旧名称', steps: [{ id: 'old-step' }] };
  const savedScript = { id: 'A', name: '刚保存的新名称', steps: [{ id: 'new-step' }], updatedAt: 'new' };
  const pendingSelection = (saved) => resolveScriptAfterSave(capturedScript, saved);
  assert.equal(pendingSelection(savedScript), savedScript);
  assert.equal(draftFingerprint(pendingSelection(savedScript)), draftFingerprint(savedScript));
  const otherScript = { id: 'B', name: '另一脚本', steps: [] };
  assert.equal(resolveScriptAfterSave(otherScript, savedScript), otherScript);
  assert.equal(pendingSelection(), capturedScript);
});

test('storage failures are visible and corrupt data is not deleted', () => {
  const storage = { getItem: () => '{broken', setItem: () => { throw new Error('quota'); } };
  assert.match(readTaskDraft(storage).error, /读取失败/);
  assert.match(writeTaskDraft({ draft: { steps: [] } }, storage), /保存失败.*quota/);
});

test('changing device never silently retains another device baseline', () => {
  const baselines = [{ deviceId: 'A', path: 'a' }, { deviceId: 'B', path: 'b' }];
  assert.equal(getMatchingBaseline(baselines, 'B', 'a').path, 'b');
  assert.equal(getMatchingBaseline(baselines, 'offline', 'a'), null);
});

test('acceptance validates only selected suite inputs with useful messages', () => {
  const empty = { packageName: '', apkPath: '', baselineImagePath: '', rounds: 5, launchWaitMs: 5000, threshold: 98 };
  assert.deepEqual(getAcceptanceErrors({ ...empty, suiteId: 'smoke' }), {});
  const install = getAcceptanceErrors({ ...empty, suiteId: 'install-launch' });
  assert.ok(install.packageName);
  assert.ok(install.apkPath);
  assert.equal(Object.keys(getAcceptanceErrors({ ...empty, suiteId: 'install-launch', packageName: 'com.example.app', apkPath: 'app.apk' })).length, 0);
  assert.ok(getAcceptanceErrors({ ...empty, suiteId: 'visual-compare', threshold: 101 }).threshold);
  assert.match(qualityErrorMessage('file_not_found:C:/missing.apk'), /重新选择.*missing/);
});
