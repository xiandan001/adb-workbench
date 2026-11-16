import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { defaultArtifactView, readArtifactView, saveArtifactView, ARTIFACT_VIEW_KEY } from '../src/shared/artifactViewState.js';
import { activityPresentation } from '../src/shared/activityPresentation.js';
import { nextEnabledActionIndex } from '../src/shared/resultActions.js';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const read = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');

function hookFixture(storage) {
  const source = read('shared/useArtifactViewState.js').replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  let current;
  const hook = new Function('useState', 'defaultArtifactView', 'readArtifactView', 'saveArtifactView', 'tr', source + '\nreturn useArtifactViewState;')(
    initialize => { current ??= initialize(); return [current, value => { current = value; }]; }, defaultArtifactView, readArtifactView, saveArtifactView, text => text);
  return id => hook(id, storage);
}
test('actual artifact view hook restores a scope on navigation and leaves failed-save inputs usable for retry', () => {
  const values = new Map(); let writable = true;
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { if (!writable) throw new Error('disk full'); values.set(key, value); } };
  const render = hookFixture(storage);
  render('A').setQuery('saved search'); render('A').setVisibleCount(90);
  render('B').setTypeFilter('inspection'); render('B').setSortOrder('size');
  assert.equal(render('A').query, 'saved search'); assert.equal(render('A').visibleCount, 90);
  assert.equal(render('B').typeFilter, 'inspection'); assert.equal(render('B').sortOrder, 'size');
  writable = false; render('B').setQuery('keep this input');
  assert.equal(render('B').query, 'keep this input'); assert.equal(render('B').saveError, '查看条件未能保存，当前筛选仍可使用。');
  writable = true; render('B').retrySave(); assert.equal(render('B').saveError, '');
  assert.equal(readArtifactView('B', storage).query, 'keep this input');
});
test('actual view hook preserves corrupt originals, never autosaves defaults, and retries the current user input', () => {
  const values = new Map([[ARTIFACT_VIEW_KEY, '{broken']]); let writes = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { writes++; values.set(key, value); } };
  const render = hookFixture(storage); assert.match(render('A').saveError, /原数据已保留/); assert.equal(writes, 0);
  render('A').setQuery('new input'); assert.equal(render('A').query, 'new input');
  assert.equal(values.get(ARTIFACT_VIEW_KEY), '{broken'); assert.equal(writes, 0);
  values.set(ARTIFACT_VIEW_KEY, '{"version":1,"entries":[]}'); render('A').retrySave();
  assert.equal(readArtifactView('A', storage).query, 'new input'); assert.equal(render('A').saveError, '');
});
test('actual artifact refresh releases loading after an IPC failure and leaves the current list available for retry', async () => {
  const source = read('components/ArtifactCenter.jsx'); let callback;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) { if (node.id.name === 'refresh') callback = node.init.arguments[0]; } });
  const calls = [], scope = { setLoading: value => calls.push(['loading', value]), setError: value => calls.push(['error', value]),
    setItems: value => calls.push(['items', value]), setListReady: value => calls.push(['ready', value]), tr: value => value,
    window: { electronAPI: { async artifactsList() { throw new Error('private failure'); } } } };
  const refresh = runInNewContext(`(${source.slice(callback.start, callback.end)})`, scope);
  await refresh();
  assert.deepEqual(calls, [['loading', true], ['error', ''], ['error', '产物列表加载失败'], ['loading', false]]);
  calls.length = 0; scope.window.electronAPI.artifactsList = async () => ({ ok: true, items: [{ id: 'current' }] });
  await refresh(); assert.deepEqual(calls, [['loading', true], ['error', ''], ['items', [{ id: 'current' }]], ['ready', true], ['loading', false]]);
});
function menuHandler(name) {
  const source = read('components/ResultActionsMenu.jsx'); let node;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node: candidate }) { if (candidate.id.name === name) node = candidate.init; } });
  assert.ok(node, name); return source.slice(node.start, node.end);
}
test('actual More menu Escape and Tab preserve contextual focus and do not close the containing dialog', () => {
  const calls = [], item = { getClientRects: () => [{}] };
  const control = name => ({ getClientRects: () => [{}], focus: () => calls.push(name) });
  const before = control('before'), trigger = control('trigger'), after = control('after');
  const host = { querySelectorAll: () => [before, trigger, item, after] }; trigger.closest = () => host;
  const scope = { close: restore => { calls.push(['close', restore]); }, trigger: { current: trigger },
    menu: { current: { contains: node => node === item } }, document: {}, actions: [], nextEnabledActionIndex };
  const handler = runInNewContext(`(${menuHandler('onMenuKey')})`, scope);
  const event = (key, shiftKey = false) => ({ key, shiftKey, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  handler(event('Escape')); assert.deepEqual(calls, ['prevent', 'stop', ['close', true]]);
  calls.length = 0; handler(event('Tab')); assert.deepEqual(calls, ['prevent', 'stop', ['close', false], 'after']);
  calls.length = 0; handler(event('Tab', true)); assert.deepEqual(calls, ['prevent', 'stop', ['close', false], 'before']);
});
test('actual More menu closes and restores the stable trigger before invoking a captured action', async () => {
  const calls = [], errors = [];
  const select = runInNewContext(`(${menuHandler('select')})`, { close: restore => calls.push(['close', restore]), setError: value => errors.push(value), tr: text => text });
  const action = { onSelect: () => calls.push('original-target-action') };
  select(action); assert.deepEqual(calls, [['close', true]]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['close', true], 'original-target-action']); assert.deepEqual(errors, []);
  select({ onSelect() { throw new Error('private path should not escape the menu'); } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['操作未完成，请重试。']);
});
test('activity dialog presentation follows light/dark/custom themes and preserves default dark callers', () => {
  assert.equal(activityPresentation().dark, true);
  const light = activityPresentation({ card: 'bg-white border-pink-100', text: 'text-pink-900' });
  assert.equal(light.dark, false); assert.equal(light.panel, 'bg-white border-pink-100'); assert.equal(light.text, 'text-pink-900');
  assert.equal(light.muted, 'text-slate-500'); assert.equal(light.hover, 'hover:bg-slate-100');
  const dark = activityPresentation({ card: 'bg-[#202124]', text: 'text-slate-100' });
  assert.equal(dark.dark, true); assert.equal(dark.heading, 'text-slate-300');
  assert.equal(activityPresentation(undefined, false).panel, 'border-slate-200 bg-white');
  const source = read('components/WorkbenchActivity.jsx');
  assert.match(source, /SidebarConnectionStatus isDark=\{colors.dark\}/);
  assert.match(source, /bg-white\/5 px-3 py-2.5 text-left text-xs text-slate-200/);
});
test('results keep primary actions while technical and destructive actions use the shared menu', () => {
  const artifact = read('components/ArtifactCenter.jsx'), drawer = read('components/TaskCenterResultDrawer.jsx');
  assert.match(artifact, /ResultActionsMenu isDark=\{isDark\} disabled=\{disabled\} actions=\{artifactTechnicalActions/);
  assert.match(artifact, /if \(selectionScope !== deviceId\)[\s\S]*setSelectedIds\(new Set\(\)\)/);
  assert.match(drawer, /运行结果概览/); assert.ok(drawer.indexOf('运行结果概览') < drawer.indexOf('原分析上下文'));
  assert.match(drawer, /taskTechnicalActions\(task, \{ onOpenPath, onOpenAnalysis, onCompareParent \}\)/);
});
