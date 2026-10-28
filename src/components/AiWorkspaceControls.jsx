import { Filter, Link2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

export function AiWorkspaceSelection({ selection, onChange, disabled, theme }) {
  useLocale();
  const input = `w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs disabled:opacity-50 ${theme.input}`;
  const number = (key, value, min, max) => onChange({ ...selection, [key]: Math.min(max, Math.max(min, Number(value) || min)) });
  return <details className={`rounded-lg border p-3 ${theme.input}`}>
    <summary className="cursor-pointer text-xs font-medium"><Filter size={13} className="mr-2 inline" />{tr('本机证据筛选')}</summary>
    <div className="mt-3 space-y-3">
      <label className="block space-y-1.5"><span className="text-xs">{tr('关键词（逗号分隔，按文字匹配）')}</span><input value={selection.keywords} maxLength={500} disabled={disabled} onChange={event => onChange({ ...selection, keywords: event.target.value })} className={input} /></label>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <label className="min-w-0 space-y-1.5"><span className="text-xs">{tr('开始时间（来源本地时间）')}</span><input type="datetime-local" value={selection.from} disabled={disabled} onChange={event => onChange({ ...selection, from: event.target.value })} className={input} /></label>
        <label className="min-w-0 space-y-1.5"><span className="text-xs">{tr('结束时间（来源本地时间）')}</span><input type="datetime-local" value={selection.to} disabled={disabled} onChange={event => onChange({ ...selection, to: event.target.value })} className={input} /></label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5"><span className="text-xs">{tr('命中前后保留行数')}</span><input type="number" min={0} max={20} value={selection.contextLines} disabled={disabled} onChange={event => number('contextLines', event.target.value, 0, 20)} className={input} /></label>
        <label className="space-y-1.5"><span className="text-xs">{tr('每份最多保留行数')}</span><input type="number" min={1} max={2000} value={selection.maxLines} disabled={disabled} onChange={event => number('maxLines', event.target.value, 1, 2000)} className={input} /></label>
      </div>
      <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('先在本机筛选，再脱敏并生成预览。未知时间会明确标注，不代表不同设备时钟已对齐。')}</p>
    </div>
  </details>;
}

export function AiWorkspaceContext({ context, onClear, disabled, theme }) {
  useLocale();
  if (!context) return null;
  return <section className="space-y-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
    <div className="flex items-center gap-2"><Link2 size={14} className="text-emerald-500" /><h4 className="flex-1 text-xs font-medium">{tr('已选择的分析上下文')}</h4>{onClear && <button type="button" disabled={disabled} onClick={onClear} aria-label={tr('移除分析上下文')} className="rounded p-1 disabled:opacity-40"><X size={14} /></button>}</div>
    <p className="whitespace-pre-wrap break-words text-xs leading-5">{context.question}</p>
    <p className={`max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{context.summary}</p>
    {context.finding && <div className="border-t border-emerald-500/15 pt-2"><p className="text-xs font-medium">{context.finding.title}</p><p className={`max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{context.finding.detail}</p></div>}
    {context.caseReview && <div className="space-y-1 border-t border-emerald-500/15 pt-2 text-xs leading-5"><p>{tr('案例人工记录：{0} · 适用 {1} {2}', { 0: { verified: tr('已人工验证'), rejected: tr('已确认误判'), unverified: tr('待验证') }[context.caseReview.status], 1: context.caseReview.packageName, 2: context.caseReview.version })}</p><p className="whitespace-pre-wrap break-words">{context.caseReview.rootCause}</p><p className="whitespace-pre-wrap break-words">{context.caseReview.solution}</p><p className="whitespace-pre-wrap break-words">{context.caseReview.verification}</p></div>}
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('仅带入已选择内容；不会自动采集、发送或执行。')}</p>
  </section>;
}

export function AiWorkspaceRequirements({ requirements, onChange, disabled, theme }) {
  useLocale();
  const fields = [
    { key: 'application', label: tr('目标应用'), max: 200 },
    { key: 'target', label: tr('目标坐标、控件或文本'), max: 200 },
    { key: 'preconditions', label: tr('前置条件'), max: 1000 },
    { key: 'expectedResult', label: tr('预期结果 / 验收条件'), max: 1000 },
  ];
  return <div className="space-y-3">
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('补充实际参数能提高草案可用性；未知坐标不会由 AI 猜测，可保存后在任务中心补录。')}</p>
    {fields.map(field => <label key={field.key} className="block space-y-1.5"><span className="text-xs">{field.label}</span><textarea rows={field.max > 200 ? 2 : 1} maxLength={field.max} value={requirements[field.key]} disabled={disabled} onChange={event => onChange({ ...requirements, [field.key]: event.target.value })} className={`w-full resize-y rounded-lg border px-3 py-2 text-xs leading-5 disabled:opacity-50 ${theme.input}`} /></label>)}
  </div>;
}
