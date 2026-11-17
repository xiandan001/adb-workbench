import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const source = fs.readFileSync(new URL('../src/components/LogDisplayInfo.jsx', import.meta.url), 'utf8');
const code = transformSync('LogDisplayInfo.jsx', source.replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function'),
  { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
const component = vm.runInNewContext(code + '\nLogDisplayInfo', {
  useLocale() {}, useId: () => 'display-info-body', ChevronDown: 'icon',
  tr: (text, values = {}) => text.replace(/\{(\d+)\}/g, (whole, key) => values[key] ?? whole),
  jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
});
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');

test('expanded advanced settings remain scrollable and height-bounded in a short localized viewport', () => {
  const toolbar = fs.readFileSync(new URL('../src/components/LogWorkbenchToolbar.jsx', import.meta.url), 'utf8');
  assert.match(toolbar, /aria-label=\{tr\('日志高级设置'\)\}[^\n]*max-h-\[min\(12rem,15vh\)\]/);
  assert.match(toolbar, /aria-label=\{tr\('日志高级设置'\)\}[^\n]*overflow-y-auto/);
  assert.ok(toolbar.includes('{advancedControls}'), 'Advanced actions remain mounted, reachable and under the existing explicit fold');
});

test('collapsed summary keeps actual source, capture and specific warnings while details do not occupy space', () => {
  const detail = { type: 'p', props: { children: 'Full source and diagnostic details' } }, controls = { type: 'button', props: { children: 'Time range' } };
  const tree = component({ title: 'Live logs', sourceIdentity: 'actual-A', captureState: 'stopped', paused: true,
    sourceMismatch: true, diagnosticIssue: true, timeWarningCount: 1, filterCount: 2, notice: 'Export finished', controls, children: detail, onExpandedChange() {} });
  assert.match(text(tree), /actual-A/); assert.match(text(tree), /已停止抓取/); assert.match(text(tree), /查看已暂停/);
  for (const label of ['显示原来源', '诊断异常', '时间需核对', '已筛选 2 项']) assert.match(text(tree), new RegExp(label));
  assert.doesNotMatch(text(tree), /Full source/); assert.equal(nodes(tree).find(node => node.props.id === 'display-info-body').props.hidden, true);
  assert.match(text(tree), /Export finished/, 'Ordinary action feedback is still visible in the compact header');
  const toggle = nodes(tree).find(node => node.type === 'button' && node.props['aria-controls']);
  assert.equal(toggle.props['aria-expanded'], false); assert.equal(nodes(toggle).filter(node => node.type === 'button').length, 1);
  assert.ok(nodes(tree).includes(controls), 'Frequently used time controls remain outside the disclosure button');
});

test('only the controlled fold callback runs; title updates never auto-expand or run controls', () => {
  const changes = [], mutations = [];
  const props = { title: 'File logs', sourceIdentity: 'source.log', onExpandedChange: value => changes.push(value),
    controls: { type: 'button', props: { onClick: () => mutations.push('filter'), children: 'Time range' } }, children: 'Original detail text' };
  let tree = component(props), toggle = nodes(tree).find(node => node.type === 'button' && node.props['aria-controls']);
  toggle.props.onClick(); assert.deepEqual(changes, [true]); assert.deepEqual(mutations, []);
  tree = component({ ...props, expanded: true, title: 'Search result' });
  assert.match(text(tree), /Original detail text/); toggle = nodes(tree).find(node => node.type === 'button' && node.props['aria-controls']);
  assert.equal(toggle.props['aria-expanded'], true); toggle.props.onClick(); assert.deepEqual(changes, [true, false]); assert.deepEqual(mutations, []);
  component({ ...props, diagnosticIssue: true }); assert.deepEqual(changes, [true, false], 'New warnings cannot change saved fold state');
});

test('actual analyzer wiring only changes the view boolean and leaves critical retry alerts outside the fold', () => {
  const analyzer = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  let element;
  traverseModule.default(parse(analyzer, { sourceType: 'module', plugins: ['jsx'] }), { JSXElement({ node }) {
    if (node.openingElement.name.name === 'LogDisplayInfo') element = node;
  } });
  assert.ok(element, 'The actual analyzer uses one controlled summary rather than leaving duplicate information rows');
  const attributes = new Map(element.openingElement.attributes.filter(item => item.type === 'JSXAttribute').map(item => [item.name.name, item.value]));
  const expression = name => analyzer.slice(attributes.get(name).expression.start, attributes.get(name).expression.end);
  assert.equal(expression('expanded'), '!focusMode && viewPreferences.view.infoExpanded');
  assert.match(expression('sourceIdentity'), /captureDeviceId/); assert.doesNotMatch(expression('sourceIdentity'), /\bdeviceId\b/);
  const calls = [], toggle = vm.runInNewContext('(' + expression('onExpandedChange') + ')', { focusMode: false, setViewField: (field, update) => calls.push({ field, update }) });
  toggle(); assert.equal(calls.length, 1); assert.equal(calls[0].field, 'infoExpanded');
  assert.equal(calls[0].update(false), true); assert.equal(calls[0].update(true), false);
  const focusCalls = [], exit = vm.runInNewContext('(' + expression('onExpandedChange') + ')', { focusMode: true, setViewField: (field, update) => focusCalls.push({ field, update }) });
  exit(); assert.equal(focusCalls.length, 1); assert.equal(focusCalls[0].field, 'focusMode'); assert.equal(focusCalls[0].update, false);
  for (const marker of ['{hydrateError &&', '{viewPreferences.error &&', '{viewEngine.error &&', '{worksetMemory.error &&']) {
    const index = analyzer.indexOf(marker); assert.ok(index >= 0); assert.ok(index < element.start || index > element.end, marker + ' stays directly visible');
  }
});
