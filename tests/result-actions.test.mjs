import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactTechnicalActions, nextEnabledActionIndex, taskTechnicalActions } from '../src/shared/resultActions.js';

test('more-menu keyboard movement wraps and skips disabled actions', () => {
  const actions = [{}, { disabled: true }, {}, {}];
  assert.equal(nextEnabledActionIndex(actions, -1, 'ArrowDown'), 0);
  assert.equal(nextEnabledActionIndex(actions, -1, 'ArrowUp'), 3);
  assert.equal(nextEnabledActionIndex(actions, 0, 'ArrowDown'), 2);
  assert.equal(nextEnabledActionIndex(actions, 0, 'ArrowUp'), 3);
  assert.equal(nextEnabledActionIndex(actions, 3, 'ArrowDown'), 0);
  assert.equal(nextEnabledActionIndex(actions, 2, 'Home'), 0);
  assert.equal(nextEnabledActionIndex(actions, 0, 'End'), 3);
  assert.equal(nextEnabledActionIndex([{ disabled: true }], 0, 'Home'), -1);
});
test('artifact technical actions capture the original opaque item and paths before confirmation or refresh', async () => {
  const calls = [], item = { id: 'original-id', title: 'Original', reportPath: 'report', summaryPath: 'data', rootPath: 'directory' };
  const actions = artifactTechnicalActions(item, { onOpenPath: value => calls.push(value), onDelete: value => calls.push(value) });
  assert.deepEqual(actions.map(action => action.id), ['report', 'data', 'directory', 'delete']);
  item.id = 'replacement'; item.reportPath = 'different';
  await actions[0].onSelect(); await actions[3].onSelect();
  assert.equal(calls[0], 'report'); assert.equal(calls[1].id, 'original-id'); assert.equal(calls[1].title, 'Original');
  assert.equal(actions[3].danger, true); assert.equal(Object.isFrozen(calls[1]), true);
});
test('task result technical actions bind reference IDs and never execute a task or send AI themselves', async () => {
  const calls = [], task = { id: 'run-original', parentTaskId: 'run-parent', mode: 'replay', status: 'failed', runResultPath: 'original-data',
    analysisOrigin: { historyId: 'original-history', question: 'not needed by navigation' } };
  const actions = taskTechnicalActions(task, { onOpenPath: value => calls.push(value), onOpenAnalysis: value => calls.push(value), onCompareParent: value => calls.push(value) });
  task.id = 'different'; task.parentTaskId = 'different-parent'; task.runResultPath = 'different-data'; task.analysisOrigin.historyId = 'different-history';
  await actions.find(action => action.id === 'analysis-origin').onSelect(); await actions.find(action => action.id === 'compare').onSelect();
  await actions.find(action => action.id === 'data').onSelect();
  assert.equal(calls[0].historyId, 'original-history'); assert.ok(!Object.hasOwn(calls[0], 'question'));
  assert.deepEqual(calls[1], { id: 'run-original', parentTaskId: 'run-parent' }); assert.equal(calls[2], 'original-data');
  assert.equal(taskTechnicalActions({ id: 'running', status: 'running', mode: 'replay', parentTaskId: 'parent' }, { onCompareParent() {} }).some(action => action.id === 'compare'), false);
});
