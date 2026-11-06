import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSearchItems, searchDestinations, searchRecords, selectedSearchIndex } from '../src/shared/workbenchSearch.js';

test('settings search leads to the existing field and tool tab without an executable command', () => {
  const items = searchDestinations();
  assert.deepEqual(filterSearchItems(items, '截图路径')[0].destination, { kind: 'settings', id: 'settings-paths', field: 'screenshotPath' });
  assert.deepEqual(filterSearchItems(items, 'MCP')[0].destination, { kind: 'ai-tool', tab: 'mcp' });
  assert.ok(items.every(item => !item.action));
});

test('reports and tasks keep exact IDs even when their titles are identical', () => {
  const items = searchRecords({ reports: [{ id: 'report-1', name: '同名' }], tasks: [{ id: 'run-1', scriptName: '同名' }] });
  assert.deepEqual(filterSearchItems(items, '同名').map(item => item.destination), [{ kind: 'history', id: 'report-1' }, { kind: 'task', id: 'run-1' }]);
  assert.equal(new Set(items.map(item => item.id)).size, 2);
  assert.equal(filterSearchItems(items, '上次报告')[0].destination.id, 'report-1');
});

test('metadata search is bounded, searches all terms and prioritizes a matching title', () => {
  const records = searchRecords({ artifacts: Array.from({ length: 500 }, (_, id) => ({ id: String(id), title: `报告 ${id}`, deviceId: 'device-A' })) });
  assert.equal(records.length, 200);
  assert.ok(filterSearchItems(records, '报告 device-a').length <= 60);
  assert.equal(filterSearchItems(records, '不存在').length, 0);
  assert.deepEqual(filterSearchItems([{ id: 'a', title: '其他', description: '报告' }, { id: 'b', title: '报告' }], '报告').map(item => item.id), ['b', 'a']);
  assert.deepEqual(searchRecords({ tasks: [null, { id: 1 }, { id: 'valid', scriptName: '有效' }] }).map(item => item.destination.id), ['valid']);
});

test('late metadata keeps the explicitly selected record; a removed record cannot open its replacement', () => {
  const initial = [{ id: 'report:a' }, { id: 'report:b' }];
  const selectedId = initial[1].id;
  const refreshed = [{ id: 'report:new' }, ...initial];
  assert.equal(refreshed[selectedSearchIndex(refreshed, selectedId)].id, 'report:b');
  const removed = [{ id: 'report:new' }, { id: 'report:a' }];
  assert.equal(selectedSearchIndex(removed, selectedId), -1);
  assert.equal(removed[selectedSearchIndex(removed, selectedId)], undefined);
  assert.equal(selectedSearchIndex(initial, null), 0);
  assert.equal(selectedSearchIndex([], null), -1);
});
