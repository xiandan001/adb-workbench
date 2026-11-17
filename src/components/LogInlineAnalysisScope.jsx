import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogInlineAnalysisScope({ scope, isDark = false, expanded, onExpandedChange }) {
  useLocale(); const bodyId = useId(), [localExpanded, setLocalExpanded] = useState(false);
  const open = typeof expanded === 'boolean' ? expanded : localExpanded;
  function toggle() { const next = !open; if (typeof expanded !== 'boolean') setLocalExpanded(next); onExpandedChange?.(next); }
  if (!scope) return null;
  return <div role="status" className={`min-w-0 space-y-1 break-words rounded-lg border px-3 py-2 text-xs leading-5 ${isDark ? 'border-slate-600/70 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {scope.label && <span title={scope.label} className="max-w-40 truncate opacity-75">{scope.label}</span>}
      <p className="min-w-0 flex-1">{tr('分析范围：{0}/{1} 条 · {2} KiB', { 0: scope.retainedEntries, 1: scope.totalEntries, 2: (scope.bytes / 1024).toFixed(1) })}</p>
      {scope.partial && <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-amber-600">{tr('局部范围')}</span>}
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle} className="inline-flex shrink-0 items-center gap-1 rounded px-1 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"><span>{open ? tr('收起范围说明') : tr('展开范围说明')}</span><ChevronDown size={13} aria-hidden="true" className={open ? 'rotate-180' : ''} /></button></div>
    <div id={bodyId} hidden={!open} className="max-h-36 space-y-1 overflow-y-auto">{open && <>
      <p>{tr('本次已冻结 {0} 条原始记录、{1} 行；后续新增日志不会自动加入。', { 0: scope.retainedEntries, 1: scope.retainedLines })}</p>
      {scope.partial && <p>{tr('只分析以上局部范围，不代表全部日志；未修改或静默截断原文。')}</p>}
      {scope.omittedOversized > 0 && <p>{tr('{0} 条记录因单条超出范围预算未纳入，可在原文详情中查看。', { 0: scope.omittedOversized })}</p>}
      <p>{tr('新增日志或修改筛选不会改变本次冻结内容，最终以完整发送确认预览为准。')}</p>
    </>}</div>
  </div>;
}
