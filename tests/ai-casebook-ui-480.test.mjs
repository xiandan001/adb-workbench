import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { casebookPrefill } from '../src/shared/aiCasebookPrefill.js';

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(' ');
const tr = (value, args = {}) => value.replace(/\{(\d+)\}/g, (whole, key) => args[key] ?? whole);
function component(filename, name, runtime) {
  const source = fs.readFileSync(new URL('../src/components/' + filename + '.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const compiled = transformSync(filename + '.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code;
  return vm.runInNewContext(compiled + '\n' + name, { useLocale() {}, tr, SelectMenu: 'select', BookCheck: 'icon', Search: 'icon',
    Fragment: 'fragment', isDarkTheme: () => false, formatNumber: String, jsx: (type, props, ...children) => ({ type, props: { ...props, children } }), ...runtime });
}
const theme = { input: '', textMuted: '', card: '', button: { primary: '', secondary: '' } };
test('quick case form keeps action/evidence in primary area and never guesses human validation', () => {
  const slots = []; let cursor = 0, props, saved, tree;
  const form = component('AiWorkspaceCasebook', 'ReviewForm', { casebookPrefill,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }]; } });
  props = { view: { report: { id: 'report', preview: { question: 'Keep original name', entries: [] }, result: { summary: 'AI guessed cause' } }, reportRef: {} }, theme, onSave: (name, review) => { saved = { name, review }; } };
  const render = () => { cursor = 0; return (tree = form(props)); };
  const field = label => nodes(tree).find(node => node.type === 'label' && text(node.props.children[0]) === label)?.props.children[1];
  render(); const advanced = nodes(tree).find(node => node.type === 'details' && text(node.props.children[0]) === '高级适用信息（可选）');
  assert.ok(advanced); assert.ok(!nodes(advanced).includes(field('实际处理方法'))); assert.ok(!nodes(advanced).includes(field('人工验证依据')));
  assert.ok(nodes(advanced).includes(field('实际根因'))); assert.equal(field('实际根因').props.value, '');
  assert.equal(nodes(tree).find(node => node.type === 'select').props.value, 'unverified');
  field('实际处理方法').props.onChange({ target: { value: 'Actual action' } }); render();
  field('人工验证依据').props.onChange({ target: { value: 'Measured after the action' } }); render();
  nodes(tree).find(node => node.type === 'select').props.onChange('verified'); render();
  props = { ...props, disabled: true }; render(); props = { ...props, disabled: false }; render();
  assert.equal(field('实际处理方法').props.value, 'Actual action'); assert.equal(field('人工验证依据').props.value, 'Measured after the action');
  const save = nodes(tree).find(node => node.type === 'button' && text(node) === '保存案例记录'); assert.equal(save.props.disabled, false); save.props.onClick();
  assert.equal(saved.name, 'Keep original name'); assert.equal(saved.review.status, 'verified'); assert.equal(saved.review.rootCause, '');
  assert.equal(saved.review.solution, 'Actual action'); assert.equal(saved.review.verification, 'Measured after the action');
});
test('budget presentation distinguishes unknown/lower-bound data from exact collection and plan estimates', () => {
  let adjusted = 0; const budget = component('AiMaterialBudget', 'AiMaterialBudget', {});
  const draft = { status: 'over-limit', minimumBytes: 20971547, limitBytes: 20971520, unknownSources: 2, complete: false };
  let tree = budget({ draft, onAdjust: () => adjusted++, theme }); assert.match(text(tree), /至少/); assert.match(text(tree), /2 项来源尚未采集/);
  assert.match(text(tree), /原文没有替换或截断/); nodes(tree).find(node => node.type === 'button').props.onClick(); assert.equal(adjusted, 1);
  tree = budget({ draft, collected: { local: { localBytes: 1000, limitBytes: 20971520, complete: true },
    plan: { requestCount: 33, initialBatchCount: 3, needsSummary: true, estimated: true } }, theme });
  assert.match(text(tree), /完整本地证据/); assert.doesNotMatch(text(tree), /超过 20 MiB/); assert.match(text(tree), /33 个请求/); assert.match(text(tree), /3 批/); assert.match(text(tree), /不是费用保证/);
});

test('a budget-worker failure has an explicit local retry without changing retained material or invoking collect', () => {
  let retries = 0; const budget = component('AiMaterialBudget', 'AiMaterialBudget', {});
  const tree = budget({ draft: { status: 'unavailable' }, onRetry: () => retries++, onAdjust() {}, theme });
  const retry = nodes(tree).find(node => node.type === 'button' && text(node) === '重试预算核算'); assert.ok(retry); retry.props.onClick(); assert.equal(retries, 1);
});
