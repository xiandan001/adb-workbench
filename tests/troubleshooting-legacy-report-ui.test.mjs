import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';

const source = readFileSync(new URL('../src/components/TroubleshootingReportSummary.jsx', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '').replaceAll('export function ', 'function ');
const { code } = transformSync('TroubleshootingReportSummary.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } });
const { parse } = createRequire(import.meta.url)('@babel/parser');
const flatten = node => node && typeof node === 'object'
  ? [node, ...node.children.flat(Infinity).flatMap(flatten)] : [];
const label = node => typeof node === 'string' ? node : node?.children?.flat(Infinity).map(label).join('') || '';
const fixture = {
  taskId: 'legacy-fixture',
  filename: 'offline-report.md',
  legacy: true,
  aiSummaryAvailable: true,
  reportPath: 'C:/fixture/offline-report.md',
  reportRef: { importId: 'scoped-selection' },
  evidenceSources: { report: true, summary: false, logs: false, performance: false },
};

function mount(componentName, electronAPI, overrides = {}) {
  const hooks = [];
  const activity = [];
  let cursor = 0;
  const props = {
    result: fixture,
    canGenerateSummary: true,
    onOpenPath: path => activity.push(['open', path]),
    onOpenSummaryMembership: report => activity.push(['membership', report.taskId]),
    onAiSummary: (...args) => activity.push(['complete', ...args]),
    ...overrides,
  };
  const runtime = {
    window: { electronAPI },
    tr: value => value,
    useLocale: () => 'zh-CN',
    useId: () => 'report-title',
    useRef: value => (hooks[cursor++] ??= { current: value }),
    useState(value) {
      const slot = hooks[cursor++] ??= { value };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    jsx: (type, attributes, ...children) => ({ type, props: attributes || {}, children }),
  };
  for (const icon of ['FileText', 'FolderOpen', 'Loader2', 'Lock', 'Sparkles']) runtime[icon] = icon;
  const api = runInNewContext(`(function(){${code};return { ${componentName}, ReportSummaryAction, LegacyEvidence };})()`, runtime);
  const tree = () => { cursor = 0; return api[componentName](props); };
  return {
    props, activity, tree,
    button: name => flatten(tree()).find(node => node.type === 'button' && label(node) === name),
    summary: () => flatten(tree()).find(node => node.type === api.ReportSummaryAction),
    evidence: () => label(api.LegacyEvidence(flatten(tree()).find(node => node.type === api.LegacyEvidence)?.props || {})),
  };
}

test('an offline Markdown selection can open the untouched report; a cancelled picker keeps the selection', async () => {
  let available = { ok: true, report: fixture };
  const ui = mount('LegacyReportSummary', { troubleshootingChooseReport: async () => available });
  await ui.button('选择 Markdown 报告').props.onClick();
  assert.match(label(ui.tree()), /offline-report\.md/);
  assert.equal(ui.summary().props.result.reportRef, fixture.reportRef);
  ui.button('打开报告').props.onClick();
  assert.deepEqual(ui.activity, [['open', fixture.reportPath]]);
  available = { ok: false, cancelled: true };
  await ui.button('选择 Markdown 报告').props.onClick();
  assert.equal(ui.summary().props.result, fixture);
  assert.doesNotMatch(label(ui.tree()), /未能读取所选报告/);

  const final = { ok: true, summary: 'Generated text' };
  ui.summary().props.onAiSummary('different-report', final, 'C:/different.md');
  assert.equal(ui.summary().props.result, fixture);
  ui.summary().props.onAiSummary(fixture.taskId, final, 'C:/fixture/separate-ai-summary.md');
  assert.equal(ui.summary().props.result.reportPath, fixture.reportPath);
  assert.equal(ui.summary().props.result.aiSummaryPath, 'C:/fixture/separate-ai-summary.md');
});

test('one-click preview uses only the selected report reference and can retry after cancellation', async () => {
  const pending = [];
  const cancelCalls = [];
  const final = { ok: true, summary: 'Generated text' };
  const summaryPath = 'C:/fixture/separate-ai-summary.md';
  const ui = mount('ReportSummaryAction', {
    troubleshootingGenerateSummary: ref => new Promise(resolve => pending.push({ ref, resolve })),
    troubleshootingCancelSummary: async id => { cancelCalls.push(id); return { ok: true }; },
  });
  assert.match(ui.evidence(), /报告正文/);
  assert.doesNotMatch(ui.evidence(), /报告摘要|命中日志片段|性能快照/);
  const first = ui.button('生成 AI 总结').props.onClick();
  assert.equal(ui.button('正在生成 AI 总结').props.disabled, true);
  await ui.button('正在生成 AI 总结').props.onClick();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ref, fixture.reportRef);
  await ui.button('取消').props.onClick();
  assert.deepEqual(cancelCalls, [fixture.taskId]);
  pending[0].resolve({ ok: false, cancelled: true });
  await first;
  assert.match(label(ui.tree()), /AI 发送已取消/);
  assert.deepEqual(ui.activity, []);

  const second = ui.button('重试 AI 总结').props.onClick();
  assert.equal(pending[1].ref, fixture.reportRef);
  pending[1].resolve({ ok: true, taskId: fixture.taskId, aiSummary: final, summaryPath });
  await second;
  assert.deepEqual(ui.activity, [['complete', fixture.taskId, final, summaryPath]]);
  ui.props.result = { ...fixture, aiSummary: final, aiSummaryPath: summaryPath,
    reportRef: { taskId: 'legacy-fixture', directory: 'existing' },
    evidenceSources: { report: true, summary: true, logs: true, performance: true } };
  assert.ok(ui.button('重新生成 AI 总结'));
  assert.match(ui.evidence(), /报告摘要.*命中日志片段.*性能快照/);
  ui.button('打开 AI 总结').props.onClick();
  assert.deepEqual(ui.activity.at(-1), ['open', summaryPath]);
});

test('membership gate does not generate or replace the loaded report', async () => {
  const ui = mount('ReportSummaryAction', {
    troubleshootingGenerateSummary: () => { assert.fail('Unentitled UI generated AI'); },
  }, { canGenerateSummary: false });
  await ui.button('生成 AI 总结').props.onClick();
  assert.deepEqual(ui.activity, [['membership', fixture.taskId]]);
  assert.ok(ui.button('生成 AI 总结'));
});

test('the existing recent-result card offers old-report summary by saved reference', () => {
  const wizard = readFileSync(new URL('../src/components/TroubleshootingWizard.jsx', import.meta.url), 'utf8');
  const declaration = parse(wizard, { sourceType: 'module', plugins: ['jsx'] }).program.body
    .find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'ResultPanel');
  const renderSource = wizard.slice(declaration.start, declaration.end);
  const resultCode = transformSync('ResultPanel.jsx', renderSource, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
  const render = runInNewContext(`(function(){${resultCode};return ResultPanel;})()`, {
    tr: value => value,
    useLocale: () => 'zh-CN',
    ReportSummaryAction: 'ReportSummaryAction',
    FileText: 'FileText',
    FolderOpen: 'FolderOpen',
    CheckCircle2: 'CheckCircle2',
    AlertCircle: 'AlertCircle',
    jsx: (type, attributes, ...children) => ({ type, props: attributes || {}, children }),
  });
  const opened = [];
  const recent = { ...fixture, ok: true, reportRef: { taskId: fixture.taskId, directory: 'existing' } };
  const tree = flatten(render({ result: recent, onOpenPath: value => opened.push(value), canGenerateSummary: true }));
  assert.equal(tree.find(node => node.type === 'ReportSummaryAction').props.result.reportRef, recent.reportRef);
  tree.find(node => node.type === 'button' && label(node) === '打开报告').props.onClick();
  assert.deepEqual(opened, [fixture.reportPath]);
});
