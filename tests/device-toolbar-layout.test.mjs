import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { tr, setLanguage } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const attribute = (node, name) => node.openingElement.attributes.find(item => item.type === 'JSXAttribute' && item.name.name === name)?.value;
const translatedAttribute = (node, name, label) => attribute(node, name)?.expression?.arguments?.[0]?.value === label;
let density, search, toolbar;
traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXElement(path) {
  if (translatedAttribute(path.node, 'aria-label', '设备卡片视图')) density = path;
  if (translatedAttribute(path.node, 'aria-label', '搜索设备')) search = path;
  if (attribute(path.node, 'className')?.value === 'mb-4 flex flex-wrap items-center gap-3') toolbar = path;
} });

test('device summary and density controls share a right-aligned wrapping group while search stays left', () => {
  assert.ok(density && search && toolbar);
  const group = density.parentPath;
  assert.equal(group.type, 'JSXElement');
  const classes = attribute(group.node, 'className')?.value?.split(/\s+/) || [];
  for (const name of ['ml-auto', 'flex', 'flex-wrap', 'items-center', 'justify-end']) assert.ok(classes.includes(name), `display group needs ${name}`);
  assert.equal(group.parentPath, toolbar);
  assert.equal(search.findParent(path => path === group), null, 'search must not enter the right-aligned group');
  assert.match(source.slice(group.node.start, group.node.end), /tr\("常用设备优先 · "\)/);
});

const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const walk = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => walk(child, predicate))];
const text = node => node === false || node == null ? '' : typeof node === 'object' ? node.children.map(text).join('') : String(node);

test('grouping preserves five-language labels, counts, search callbacks and both density actions', async () => {
  const code = await transformWithOxc('globalThis.draw = () => (' + source.slice(toolbar.node.start, toolbar.node.end) + ');', 'DeviceToolbar.jsx', { jsx: { runtime: 'classic' } });
  const searches = [], modes = [];
  const sandbox = { React: { createElement: element }, tr, Search: 'Search', Star: 'Star', X: 'X', deviceQuery: 'fixture',
    visibleDevices: [{}, {}], eligibleDevices: [{}, {}, {}], deviceCardDensity: 'full',
    setDeviceQuery: value => searches.push(value), setDeviceCardDensity: value => modes.push(value),
    t: { textMuted: 'muted', input: 'input', card: 'card', button: { primary: 'primary' } } };
  runInNewContext(code.code, sandbox);
  try {
    for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
      await setLanguage(locale);
      const tree = sandbox.draw(), input = walk(tree, node => node.type === 'input')[0];
      assert.equal(input.props['aria-label'], tr('搜索设备'));
      assert.equal(input.props.value, 'fixture');
      assert.equal(input.props.maxLength, 300);
      input.props.onChange({ target: { value: locale } });
      assert.equal(searches.at(-1), locale);
      walk(tree, node => node.props['aria-label'] === tr('清空设备搜索'))[0].props.onClick();
      assert.equal(searches.at(-1), '');
      assert.ok(text(tree).includes(tr('常用设备优先 · ') + '2 / 3' + tr(' 台')));
      const buttons = walk(tree, node => node.type === 'button' && 'aria-pressed' in node.props);
      assert.equal(buttons.length, 2);
      for (const [index, value, label] of [[0, 'full', '完整视图'], [1, 'compact', '紧凑视图']]) {
        assert.equal(text(buttons[index]), tr(label));
        assert.equal(buttons[index].props['aria-pressed'], index === 0);
        buttons[index].props.onClick();
        assert.equal(modes.at(-1), value);
      }
    }
  } finally { await setLanguage('zh-CN'); }
});
