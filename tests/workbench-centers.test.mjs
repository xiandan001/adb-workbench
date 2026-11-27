import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';
import {
  WORKBENCH_CENTER_PAGES_KEY, centerPage, getWorkbenchCenter, nextWorkbenchCenterPage,
  readWorkbenchCenterPages, rememberWorkbenchCenterPage,
} from '../src/shared/workbenchCenters.js';

test('centers use the original leaf routes and default to the first visible tab', () => {
  const groups = [
    ['test-center', '测试中心', ['quality', 'tasks', 'artifacts'], ['质量', '任务', '产物']],
    ['diagnostics-center', '诊断中心', ['troubleshoot', 'performance'], ['问题排查', '性能监控']],
    ['ai-center', 'AI 中心', ['ai-workspace', 'ai-tools'], ['AI 工作区', '工具管理']],
  ];
  for (const [id, title, leaves, labels] of groups) {
    assert.equal(centerPage(id), leaves[0]);
    for (const leaf of leaves) {
      const center = getWorkbenchCenter(leaf);
      assert.equal(center.id, id);
      assert.equal(center.title, title);
      assert.deepEqual(center.pages.map(page => page.id), leaves);
      assert.deepEqual(center.pages.map(page => page.label), labels);
    }
  }
  for (const page of ['logs', 'devices', 'firmware', 'serial', 'ssh', 'member', 'settings', 'test-center']) {
    assert.equal(getWorkbenchCenter(page), null);
  }
  assert.equal(centerPage('__proto__'), null);
});

test('each center remembers a separate actual leaf without replacing the others', () => {
  const disk = new Map(), writes = [];
  const storage = {
    getItem: key => disk.get(key),
    setItem: (key, value) => { disk.set(key, value); writes.push(key); },
  };
  let pages = readWorkbenchCenterPages(storage);
  for (const leaf of ['tasks', 'performance', 'ai-tools', 'firmware', 'logs', 'ai-tools']) {
    pages = rememberWorkbenchCenterPage(pages, leaf, storage);
  }
  assert.deepEqual(writes, Array(3).fill(WORKBENCH_CENTER_PAGES_KEY));
  assert.deepEqual(readWorkbenchCenterPages(storage), pages);
  assert.equal(centerPage('test-center', pages), 'tasks');
  assert.equal(centerPage('diagnostics-center', pages), 'performance');
  assert.equal(centerPage('ai-center', pages), 'ai-tools');
});

test('bad storage and wrong-center routes cannot break fallback or session memory', () => {
  for (const bad of ['{', 'null', '[]', 'false', 'x'.repeat(4097)]) {
    assert.deepEqual(readWorkbenchCenterPages({ getItem: () => bad }), {});
  }
  const mixed = readWorkbenchCenterPages({ getItem: () =>
    '{"test-center":"performance","diagnostics-center":"performance","ai-center":"logs","__proto__":{"member":true}}' });
  assert.deepEqual(mixed, { 'diagnostics-center': 'performance' });
  assert.equal(centerPage('test-center', mixed), 'quality');
  assert.equal(centerPage('ai-center', mixed), 'ai-workspace');
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const session = rememberWorkbenchCenterPage(readWorkbenchCenterPages(blocked), 'artifacts', blocked);
  assert.equal(centerPage('test-center', session), 'artifacts');
  assert.deepEqual(readWorkbenchCenterPages(blocked), {});
});

test('arrow keys and Home/End stay in the active center', () => {
  const center = getWorkbenchCenter('quality');
  assert.equal(nextWorkbenchCenterPage(center, 'quality', 'ArrowLeft'), 'artifacts');
  assert.equal(nextWorkbenchCenterPage(center, 'artifacts', 'ArrowRight'), 'quality');
  assert.equal(nextWorkbenchCenterPage(center, 'tasks', 'End'), 'artifacts');
  assert.equal(nextWorkbenchCenterPage(center, 'tasks', 'Home'), 'quality');
  assert.equal(nextWorkbenchCenterPage(center, 'tasks', 'Tab'), null);
  assert.equal(nextWorkbenchCenterPage(center, 'performance', 'Home'), null);
});

test('the actual tab component selects pages with clicks and unmodified keys', () => {
  const source = readFileSync(new URL('../src/components/WorkbenchCenterTabs.jsx', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function');
  const code = transformSync('WorkbenchCenterTabs.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
  const glyphs = Object.fromEntries(['ClipboardCheck', 'ClipboardList', 'FolderOpen', 'Gauge',
    'ShieldCheck', 'SlidersHorizontal', 'Sparkles'].map(name => [name, 'icon']));
  const render = runInNewContext(`(function(){${code};return WorkbenchCenterTabs;})()`, {
    ...glyphs, jsx: (type, props, ...children) => ({ type, props, children }),
    isDarkTheme: () => true, nextWorkbenchCenterPage,
  });
  const changes = [], focused = [];
  const tree = render({ center: getWorkbenchCenter('tasks'), activeTab: 'tasks', onChange: leaf => changes.push(leaf),
    theme: { button: { secondary: 'secondary' } } });
  assert.equal(tree.props.role, 'tablist');
  assert.equal(tree.props['aria-label'], '测试中心');
  const [buttons] = tree.children;
  for (const button of buttons) {
    const page = button.props['data-center-page'];
    assert.equal(button.props.id, 'workbench-center-tab-' + page);
    assert.equal(button.props['aria-controls'], 'workbench-center-panel');
    assert.equal(button.props['aria-selected'], page === 'tasks');
    assert.equal(button.props.tabIndex, page === 'tasks' ? 0 : -1);
  }
  buttons[0].props.onClick();
  let prevented = 0;
  const event = {
    target: { closest: () => ({ dataset: { centerPage: 'tasks' } }) },
    currentTarget: { ownerDocument: { getElementById: id => ({ focus: () => focused.push(id) }) } },
    key: 'ArrowRight', preventDefault() { prevented++; },
  };
  tree.props.onKeyDown({ ...event, altKey: true });
  tree.props.onKeyDown(event);
  assert.equal(prevented, 1);
  assert.deepEqual(changes, ['quality', 'artifacts']);
  assert.deepEqual(focused, ['workbench-center-tab-artifacts']);
});
