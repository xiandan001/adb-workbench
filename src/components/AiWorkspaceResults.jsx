import { CheckCircle2, FileCheck2, Save, TriangleAlert } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { AiWorkspaceUsage } from './AiWorkspaceEvidence';

function ResultList({ title, items, theme }) {
  if (!items?.length) return null;
  return <section><h4 className="mb-2 text-xs font-semibold">{title}</h4><ul className={`space-y-1.5 pl-4 text-sm leading-6 ${theme.textMuted}`}>{items.map((item, index) => <li key={index} className="list-disc whitespace-pre-wrap break-words">{item}</li>)}</ul></section>;
}

export function AiWorkspaceAnalysis({ result, preview, usage, cached, theme }) {
  useLocale();
  const evidence = id => {
    const element = document.getElementById(`ai-evidence-${preview.id}-${id}`);
    if (!element) return;
    element.open = true; element.scrollIntoView({ block: 'nearest', behavior: 'auto' }); element.focus({ preventScroll: true });
  };
  return <section aria-label={tr('分析结果')} className={`space-y-4 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-center gap-2"><CheckCircle2 size={19} className="text-emerald-500" /><h3 className="text-sm font-semibold">{tr('分析结果')}</h3></div>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{result.summary}</p>
    {result.findings?.length > 0 && <section className="space-y-2"><h4 className="text-xs font-semibold">{tr('证据与发现')}</h4>{result.findings.map((finding, index) => <article key={index} className={`rounded-lg border p-3 ${theme.input}`}>
      <h5 className="text-sm font-medium">{finding.title}</h5><p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${theme.textMuted}`}>{finding.detail}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">{finding.evidenceIds.map(id => <button key={id} type="button" onClick={() => evidence(id)} aria-label={tr('查看证据 {0}', { 0: id })} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-300">[{id}]</button>)}</div>
    </article>)}</section>}
    <ResultList title={tr('待验证的推测')} items={result.hypotheses} theme={theme} />
    <ResultList title={tr('建议的下一步')} items={result.nextSteps} theme={theme} />
    <ResultList title={tr('分析限制')} items={result.limitations} theme={theme} />
    <div className="space-y-2 border-t border-slate-400/15 pt-3"><p className={`flex items-start gap-2 text-xs leading-5 ${theme.textMuted}`}><TriangleAlert size={14} className="mt-0.5 shrink-0" />{tr('AI 结论需要结合证据验证；此处的建议不会自动执行。')}</p><AiWorkspaceUsage usage={usage} cached={cached} theme={theme} /></div>
  </section>;
}

function stepDetails(step) {
  switch (step.type) {
    case 'tap': return tr('坐标：{0}, {1}', { 0: step.x, 1: step.y });
    case 'longPress': return tr('坐标：{0}, {1} · 时长 {2} ms', { 0: step.x, 1: step.y, 2: step.durationMs });
    case 'swipe': return tr('从 {0}, {1} 滑到 {2}, {3} · {4} ms', { 0: step.x, 1: step.y, 2: step.endX, 3: step.endY, 4: step.durationMs });
    case 'input': return tr('输入：{0}', { 0: step.text });
    case 'keyevent': return tr('按键：{0}', { 0: step.keyCode });
    case 'waitText': case 'assertText': return tr('文本：{0} · 超时 {1} ms', { 0: step.text, 1: step.timeoutMs });
    case 'delay': return tr('等待 {0} ms', { 0: step.durationMs });
    case 'screenshot': return tr('保存当前设备画面');
    case 'perfSnapshot': return tr('采集一次性能快照');
    default: return '';
  }
}

export function AiWorkspaceTask({ draft, busy, onSave, usage, theme }) {
  useLocale();
  return <section aria-label={tr('测试任务草案')} className={`space-y-4 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-center gap-2"><FileCheck2 size={19} className="text-emerald-500" /><h3 className="text-sm font-semibold">{tr('测试任务草案')}</h3></div>
    <div><h4 className="text-base font-semibold">{draft.name}</h4><p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${theme.textMuted}`}>{draft.description}</p></div>
    <ol className="space-y-2">{draft.steps.map((step, index) => <li key={index} className={`flex items-start gap-3 rounded-lg border p-3 ${theme.input}`}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-semibold text-emerald-500">{index + 1}</span>
      <div className="min-w-0"><p className="text-sm font-medium">{step.label}</p><p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{stepDetails(step)}</p></div>
    </li>)}</ol>
    <p className={`rounded-lg bg-amber-500/5 p-3 text-xs leading-5 ${theme.textMuted}`}>{tr('请核对坐标、输入内容和验证条件。保存后可在任务中心编辑，并明确选择设备执行；不会自动运行。')}</p>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-400/15 pt-3"><AiWorkspaceUsage usage={usage} theme={theme} /><button type="button" onClick={onSave} disabled={Boolean(busy)} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Save size={15} />{tr('保存到任务中心')}</button></div>
  </section>;
}
