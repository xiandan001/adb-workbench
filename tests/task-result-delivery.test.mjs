import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskArtifact, exportTaskResult, exportTaskComparison } from '../src/shared/taskResultDelivery.js';
import { compareTaskRuns, taskComparisonSummary } from '../src/shared/taskRunComparison.js';
const items = [{ type: 'task', id: 'task:trusted-before', taskId: 'task-before' }, { type: 'task', id: 'task:trusted-after', taskId: 'task-after' }];

test('result delivery re-queries the index and passes opaque IDs only, never renderer paths', async () => {
  const calls = [];
  const api = { artifactsList: async () => ({ ok: true, items }), artifactExport: async id => { calls.push(id); return { ok: true }; }, artifactExportComparison: async args => { calls.push(args); return { ok: true }; } };
  await exportTaskResult('task-before', api); await exportTaskComparison('task-before', 'task-after', api);
  assert.deepEqual(calls, ['task:trusted-before', { beforeId: 'task:trusted-before', afterId: 'task:trusted-after' }]);
  assert.throws(() => resolveTaskArtifact(items, '../arbitrary-path'), /未找到唯一/);
  assert.throws(() => resolveTaskArtifact([...items, { ...items[0], id: 'duplicate' }], 'task-before'), /未找到唯一/);
  await assert.rejects(exportTaskResult('task-before', { artifactsList: async () => ({ ok: false, error: 'offline-index' }) }), /offline-index/);
});

test('comparison summary identifies both runs and excludes raw output, paths and private script data', () => {
  const definition = { id: 'step', type: 'assertText', label: 'Check' };
  const make = (id, status) => ({ id, scriptName: 'Script', mode: 'replay', status, comparisonVersion: 1, scriptId: 'script', scriptHash: 'hash', scriptSteps: [definition],
    rerunSnapshot: { secret: 'private-input' }, artifactDir: 'C:/private-path', deviceRuns: [{ deviceId: 'device', comparisonIdentity: { androidId: 'digest' }, steps: [{ ...definition, index: 0, status, output: 'raw-output', artifact: 'C:/secret-file' }] }] });
  const before = make('task-before', 'failed'), after = make('task-after', 'success');
  const summary = taskComparisonSummary(before, after, compareTaskRuns(before, after));
  assert.match(summary, /task-before/); assert.match(summary, /task-after/); assert.match(summary, /恢复 1/);
  assert.doesNotMatch(summary, /private-input|private-path|raw-output|secret-file|rerunSnapshot/);
  assert.throws(() => taskComparisonSummary(before, before, compareTaskRuns(before, before)), /不同/);
});
