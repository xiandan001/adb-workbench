import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import { transformSync } from 'rolldown/utils';

const source = readFileSync(new URL('../src/components/TaskCenterRecordingWorkspace.jsx', import.meta.url), 'utf8')
  .replace(/^import\b[\s\S]*?;\r?\n/gm, '').replace('export default TaskCenterRecordingWorkspace;', '');
const code = transformSync('TaskCenterRecordingWorkspace.jsx', source, {
  jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' },
}).code;
const component = runInNewContext(`${code}\nTaskCenterRecordingWorkspace`, {
  ...icons,
  jsx: createElement,
  Fragment: 'div',
  tr: (key, values = {}) => key.replace(/\{(\d+)\}/g, (part, n) => values[n] ?? part),
  useId: () => 'recording-step-editor',
  useLocale: () => {},
  isDarkTheme: theme => theme.isDark,
});
const descendants = node => !isValidElement(node) ? [] : [node, ...[node.props.children].flat(Infinity).flatMap(descendants)];
const draft = { name: '设置页测试', steps: [
  { id: 'tap', type: 'tap', label: '点击设置', x: 10, y: 12 },
  { id: 'curve', type: 'swipe', label: '曲线滑动', x: 10, y: 12, endX: 33, endY: 20, points: [{ x: 10, y: 12 }, { x: 22, y: 30 }, { x: 33, y: 20 }] },
] };

function render(props = {}) {
  return component({ theme: { isDark: true, button: { secondary: 'secondary' } }, draft,
    recorderPanel: createElement('div', null, '设备画面'), ...props });
}

test('recording selection opens the existing per-step fields in place and changes only that step', () => {
  let selectedStepIndex = -1;
  const changes = [], moves = [], removals = [];
  const onUpdateStep = (index, patch) => changes.push([index, { ...patch }]);
  const props = {
    onSelectStep: index => { selectedStepIndex = index; }, onUpdateStep,
    onMoveStep: (...args) => moves.push(args), onRemoveStep: index => removals.push(index),
    renderSelectedStep: (step, index) => createElement('input', { 'aria-label': '轨迹时长', value: step.durationMs ?? 400,
      onChange: event => onUpdateStep(index, { durationMs: Number(event.target.value) }) }),
  };
  const firstTree = descendants(render({ ...props, selectedStepIndex }));
  assert.equal(firstTree.some(node => node.props['aria-label'] === '轨迹时长'), false);
  firstTree.filter(node => node.props['aria-pressed'] === false)[1].props.onClick();
  assert.equal(selectedStepIndex, 1);

  const secondTree = render({ ...props, selectedStepIndex });
  assert.match(renderToStaticMarkup(secondTree), /id="recording-step-editor"/);
  const nodes = descendants(secondTree);
  nodes.find(node => node.props['aria-label'] === '轨迹时长').props.onChange({ target: { value: '850' } });
  nodes.find(node => node.type === 'input' && node.props.value === '曲线滑动').props.onChange({ target: { value: '滑到设置' } });
  nodes.find(node => node.props['aria-label'] === '上移').props.onClick();
  assert.equal(nodes.find(node => node.props['aria-label'] === '下移').props.disabled, true);
  nodes.find(node => node.props['aria-label'] === '删除步骤').props.onClick();
  assert.deepEqual(changes, [[1, { durationMs: 850 }], [1, { label: '滑到设置' }]]);
  assert.deepEqual(moves, [[1, -1]]);
  assert.deepEqual(removals, [1]);
});

test('manual replay and tutorial anchor remain explicit and blocked replay cannot dispatch', () => {
  const calls = [];
  const onReplay = () => calls.push('replay');
  const replay = tree => descendants(tree).find(node => node.props['data-task-center-guide'] === 'replay');
  const guided = render({ guided: true, onReplay });
  const html = renderToStaticMarkup(guided);
  assert.match(html, /设备画面/);
  assert.match(html, /sticky bottom-2/);
  assert.match(html, /开始回放/);
  assert.equal(replay(guided).props.disabled, false);
  replay(guided).props.onClick();
  assert.deepEqual(calls, ['replay']);
  const blocked = render({ canReplay: false, replayBlock: '选择在线设备', onReplay });
  assert.match(renderToStaticMarkup(blocked), /选择在线设备/);
  assert.equal(replay(blocked).props.disabled, true);
  const running = render({ task: { status: 'running' }, onReplay });
  assert.equal(replay(running), undefined);
  assert.match(renderToStaticMarkup(running), /取消回放/);
});
