import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/utils';
import { Check, Circle, CircleX, Clock, Image, Minus, SkipForward } from 'lucide-react';
import { getTaskStatusLabel } from '../src/shared/taskCenterWorkspace.js';
import * as model from '../src/shared/taskResultMatrix.js';

const step = (id, index, status, extra = {}) => ({ id, index, status, ...extra });
const example = {
  id: 'task-example', status: 'failed', mode: 'replay',
  scriptSteps: [{ id: 'launch', label: '启动' }, { id: 'image', label: '对比截图' }, { id: 'collect', label: '采证' }],
  deviceRuns: [
    { deviceId: 'A-reconnected', originalDeviceId: 'A', status: 'failed',
      steps: [step('image', 1, 'failed', { error: 'A error', screenshotArtifact: 'A.png', artifact: 'A.report' }), step('launch', 0, 'success')] },
    { deviceId: 'B', status: 'success', steps: [step('launch', 0, 'success'), step('image', 1, 'skipped'), step('collect', 2, 'success')] },
    { deviceId: 'C', status: 'success', steps: [step('launch', 0, 'success'), step('image', 1, 'success'), step('collect', 2, 'passed')] },
  ],
  logs: [
    { deviceId: 'A', stepId: 'image', stepIndex: 1, roundIndex: null, message: 'A matched' },
    { deviceId: 'A', stepId: 'launch', stepIndex: 0, roundIndex: null, message: 'A unrelated' },
    { deviceId: 'B', stepId: 'image', stepIndex: 1, roundIndex: null, message: 'B unrelated' },
    { message: '[A] 相似标签不足以确认' },
  ],
};

test('execution snapshot orders columns and distinguishes failed, skipped and not executed', () => {
  const matrix = model.buildTaskResultMatrix(example);
  assert.deepEqual(matrix.columns.map(col => col.label), ['启动', '对比截图', '采证']);
  assert.deepEqual(matrix.rows.map(row => row.cells.map(cell => cell.status)),
    [['passed', 'failed', 'not-run'], ['passed', 'skipped', 'passed'], ['passed', 'passed', 'passed']]);
  const filtered = model.buildTaskResultMatrix(example, { onlyAbnormal: true });
  assert.deepEqual(filtered.rows.map(row => row.deviceId), ['A', 'B']);
  assert.deepEqual(filtered.columns.map(col => col.label), ['对比截图', '采证']);
  assert.equal(filtered.rows[1].cells[1].abnormal, false);
});

test('rounds never inherit another run result; historical discarded rows are not called unexecuted', () => {
  const task = {
    id: 'task-stress', mode: 'stress', status: 'failed', scriptSteps: example.scriptSteps,
    deviceRuns: [
      { deviceId: 'one', status: 'failed', steps: [
        step('image', 1, 'failed', { roundIndex: 1 }), step('image', 1, 'success', { roundIndex: 2 }),
      ] },
      { deviceId: 'two', status: 'success', stressRounds: [{ index: 2, steps: [step('image', 1, 'success')] }] },
    ],
  };
  const latest = model.buildTaskResultMatrix(task);
  assert.deepEqual(latest.rounds, [2, 1]);
  assert.equal(latest.rows[0].cells[1].status, 'passed');
  assert.equal(latest.rows[1].cells[1].status, 'passed');
  const older = model.buildTaskResultMatrix(task, { requestedRound: 1 });
  assert.equal(older.rows[0].cells[1].status, 'failed');
  assert.equal(older.rows[1].cells[1].status, 'unavailable');
  const reference = model.buildTaskStepEvidenceReference(task.id, latest.rows[0], latest.rows[0].cells[1], latest.roundIndex);
  assert.equal(reference.roundIndex, 2);
  assert.deepEqual(model.taskStepLogs([
    { ...reference, roundIndex: 1, message: 'another round' },
    { ...reference, message: 'wanted' },
    { ...reference, deviceId: 'two', message: 'another device' },
  ], reference).map(line => line.message), ['wanted']);
});

test('pending rows do not become anomalies before execution; old snapshot-less records keep only reported steps', () => {
  const pending = model.buildTaskResultMatrix({ ...example, status: 'running', deviceRuns: [{ deviceId: 'wait', status: 'queued', steps: [] }] }, { onlyAbnormal: true });
  assert.deepEqual(pending.rows, []);
  const old = model.buildTaskResultMatrix({ ...example, scriptSteps: undefined, deviceRuns: [{ deviceId: 'A', status: 'failed', steps: [{ id: 'read', label: 'read', status: 'failed' }] }] });
  assert.equal(old.columns[0].label, 'read');
});

const source = fs.readFileSync(new URL('../src/components/TaskResultMatrix.jsx', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
const transpiled = transformSync('TaskResultMatrix.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;

test('rendered result table opens exact cell evidence, only abnormalities hides normal cells', async () => {
  const states = [], effects = [], requested = [];
  let cursor = 0;
  const sample = 'data:image/png;base64,iVBORw0KGgo=';
  const Component = vm.runInNewContext(transpiled + '\nTaskResultMatrix', {
    ...model, Check, Circle, CircleX, Clock, Image, Minus, SkipForward, getTaskStatusLabel,
    jsx: createElement, useMemo: fn => fn(), useId: () => 'matrix-test',
    useEffect: run => effects.push(run),
    useState(value) {
      const index = cursor++;
      if (!(index in states)) states[index] = value;
      return [states[index], next => { states[index] = next; }];
    },
    tr: (value, args = {}) => value.replace(/\{(\d+)\}/g, (key, index) => args[index] ?? key),
    window: { electronAPI: { taskStepEvidence(input) { requested.push(input); return { ok: true, screenshot: sample }; } } },
  });
  function render() {
    cursor = 0;
    const tree = Component({ task: example, isDark: true, muted: 'muted' });
    return { tree, html: renderToStaticMarkup(tree) };
  }
  function findElement(node, predicate) {
    if (!node || !isValidElement(node)) return null;
    if (predicate(node)) return node;
    return [node.props.children].flat(Infinity).map(child => findElement(child, predicate)).find(Boolean);
  }

  const first = render();
  assert.match(first.html, /scope="col"/);
  assert.match(first.html, /scope="row"/);
  assert.match(first.html, /B · 对比截图 · 已跳过/);
  assert.match(first.html, /A-reconnected · 采证 · 未执行/);
  assert.equal(requested.length, 0);
  findElement(first.tree, node => node.props['aria-label'] === 'A-reconnected · 对比截图 · 失败').props.onClick();
  const selected = render();
  assert.match(selected.html, /A error/);
  assert.match(selected.html, /A matched/);
  assert.doesNotMatch(selected.html, /unrelated|相似标签不足以确认/);
  assert.match(selected.html, /aria-pressed="true"/);
  effects.pop()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(requested)), [{ taskId: example.id, deviceId: 'A', stepIndex: 1, stepId: 'image', roundIndex: null }]);
  assert.match(render().html, /<img src="data:image\/png;base64,[^"]+" alt="该步骤截图"/);
  findElement(selected.tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  const filtered = render().html;
  assert.doesNotMatch(filtered, /C ·|A-reconnected · 启动/);
  assert.match(filtered, /已隐藏正常结果/);
});
