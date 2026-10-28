import { useEffect, useState } from 'react';
import { CheckCircle2, FileCheck2, Save, TriangleAlert } from 'lucide-react';
import { formatDateTime, tr, useLocale } from '../shared/i18n';
import AiWorkspaceEvidence, { AiWorkspaceUsage } from './AiWorkspaceEvidence';
import { workspaceCitation, workspacePreviewFresh } from './AiWorkspaceState';
import AiWorkspaceHandoff from './AiWorkspaceHandoff';

function ResultList({ title, items, theme }) {
  if (!items?.length) return null;
  return <section><h4 className="mb-2 text-xs font-semibold">{title}</h4><ul className={`space-y-1.5 pl-4 text-sm leading-6 ${theme.textMuted}`}>{items.map((item, index) => <li key={index} className="list-disc whitespace-pre-wrap break-words">{item}</li>)}</ul></section>;
}

export function AiWorkspaceReport({ preview, result, usage, cached, theme, readOnly, busy, entitled, onAnalyze, onRegression }) {
  const [highlight, setHighlight] = useState(null);
  const citation = value => {
    const valid = workspaceCitation(preview, value);
    if (valid) setHighlight(current => ({ ...valid, nonce: (current?.nonce || 0) + 1 }));
  };
  return <>
    <AiWorkspaceEvidence preview={preview} theme={theme} readOnly={readOnly} busy={busy} entitled={entitled} onAnalyze={onAnalyze} highlight={highlight} onCitation={citation} />
    {result && <AiWorkspaceAnalysis result={result} preview={preview} usage={usage} cached={cached} theme={theme} onCitation={citation} onRegression={onRegression} />}
  </>;
}

export function AiWorkspaceAnalysis({ result, preview, usage, cached, theme, onCitation, onRegression }) {
  useLocale();
  const verdicts = { improved: tr('有所改善'), unchanged: tr('未见明显变化'), regressed: tr('出现退化'), inconclusive: tr('无法判断') };
  return <section aria-label={tr('分析结果')} className={`space-y-4 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-center gap-2"><CheckCircle2 size={19} className="text-emerald-500" /><h3 className="text-sm font-semibold">{tr('分析结果')}</h3></div>
    {result.verdict && <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm">{tr('对比结论：{0}', { 0: verdicts[result.verdict] || verdicts.inconclusive })}<span className={`mt-1 block text-xs leading-5 ${theme.textMuted}`}>{tr('变化不等于问题已经完全修复，仍需按验收条件验证。')}</span></p>}
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{result.summary}</p>
    {result.findings?.length > 0 && <section className="space-y-2"><h4 className="text-xs font-semibold">{tr('证据与发现')}</h4>{result.findings.map((finding, index) => <article key={index} className={`rounded-lg border p-3 ${theme.input}`}>
      <h5 className="text-sm font-medium">{finding.title}</h5><p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${theme.textMuted}`}>{finding.detail}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">{finding.evidenceIds.map(id => <button key={id} type="button" onClick={() => onCitation?.({ evidenceId: id, startLine: 1, endLine: 1 })} aria-label={tr('查看证据 {0}', { 0: id })} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-300">[{id}]</button>)}
        {(finding.citations || []).filter(item => workspaceCitation(preview, item)).map((item, i) => <button key={i} type="button" onClick={() => onCitation?.(item)} className="rounded border border-amber-500/30 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">{tr('{0} 第 {1}–{2} 行', { 0: item.evidenceId, 1: item.startLine, 2: item.endLine })}</button>)}
        {onRegression && <button type="button" onClick={() => onRegression(index)} className={`rounded px-2 py-0.5 text-xs ${theme.button.secondary}`}>{tr('以此发现准备回归')}</button>}
      </div>
    </article>)}</section>}
    <ResultList title={tr('待验证的推测')} items={result.hypotheses} theme={theme} />
    <ResultList title={tr('建议的下一步')} items={result.nextSteps} theme={theme} />
    <ResultList title={tr('分析限制')} items={result.limitations} theme={theme} />
    <div className="space-y-2 border-t border-slate-400/15 pt-3"><p className={`flex items-start gap-2 text-xs leading-5 ${theme.textMuted}`}><TriangleAlert size={14} className="mt-0.5 shrink-0" />{tr('AI 结论需要结合证据验证；此处的建议不会自动执行。')}</p><AiWorkspaceUsage usage={usage} cached={cached} theme={theme} /></div>
  </section>;
}

function stepDetails(step) {
  if (step.targetId) return tr('已选控件：{0}', { 0: step.targetId });
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
  const [expiredId, setExpiredId] = useState('');
  useEffect(() => {
    const expiresAt = typeof draft.expiresAt === 'string' ? Date.parse(draft.expiresAt) : draft.expiresAt;
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => setExpiredId(draft.id), Math.max(0, expiresAt - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [draft.id, draft.expiresAt]);
  const fresh = expiredId !== draft.id && workspacePreviewFresh(draft);
  const observationOnly = draft.steps.every(step => ['screenshot', 'perfSnapshot', 'delay'].includes(step.type));
  return <section aria-label={tr('测试任务草案')} className={`space-y-4 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-center gap-2"><FileCheck2 size={19} className="text-emerald-500" /><h3 className="text-sm font-semibold">{tr('测试任务草案')}</h3></div>
    <div><h4 className="text-base font-semibold">{draft.name}</h4><p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${theme.textMuted}`}>{draft.description}</p></div>
    {draft.targets?.length > 0 && <><AiWorkspaceHandoff targets={draft.targets} theme={theme} /><div className="space-y-1">{draft.targets.map(target => <p key={target.id} className={`break-all text-[11px] leading-5 ${theme.textMuted}`}>{target.id}: {Object.entries(target.selector || {}).map(([key, value]) => `${key}=${value}`).join(', ')}</p>)}</div></>}
    <p className={`text-xs leading-5 ${fresh ? theme.textMuted : 'text-amber-600 dark:text-amber-400'}`}>{fresh ? tr('草案有效至 {0}', { 0: formatDateTime(draft.expiresAt) }) : tr('草案已过期，不能保存；请保留目标并手动重新生成。')}</p>
    {(observationOnly || draft.missingInformation?.length > 0) && <div className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5">
      {observationOnly && <p>{tr('此草案仅包含观察步骤，尚不能证明交互目标通过。可保存后在任务中心补充。')}</p>}
      <ResultList title={tr('仍需补充的信息')} items={draft.missingInformation} theme={theme} />
    </div>}
    <ol className="space-y-2">{draft.steps.map((step, index) => <li key={index} className={`flex items-start gap-3 rounded-lg border p-3 ${theme.input}`}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-semibold text-emerald-500">{index + 1}</span>
      <div className="min-w-0"><p className="text-sm font-medium">{step.label}</p><p className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{stepDetails(step)}</p></div>
    </li>)}</ol>
    <p className={`rounded-lg bg-amber-500/5 p-3 text-xs leading-5 ${theme.textMuted}`}>{tr('请核对坐标、输入内容和验证条件。保存后可在任务中心编辑，并明确选择设备执行；不会自动运行。')}</p>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-400/15 pt-3"><AiWorkspaceUsage usage={usage} theme={theme} /><button type="button" onClick={onSave} disabled={Boolean(busy) || !fresh} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Save size={15} />{tr('保存到任务中心')}</button></div>
  </section>;
}
