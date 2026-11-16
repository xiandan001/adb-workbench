import { tr, useLocale } from '../shared/i18n.js';

export default function LogInlineAnalysisScope({ scope, isDark = false }) {
  useLocale(); if (!scope) return null;
  return <div role="status" className={`min-w-0 space-y-1 break-words rounded-lg border p-3 text-xs leading-5 ${scope.partial ? 'border-amber-500/35 text-amber-600' : isDark ? 'border-slate-600 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
    <p>{scope.label ? `${scope.label} · ` : ''}{tr('本次已冻结 {0}/{1} 条记录，{2} 行，{3} KiB。', { 0: scope.retainedEntries, 1: scope.totalEntries, 2: scope.retainedLines, 3: (scope.bytes / 1024).toFixed(1) })}</p>
    {scope.partial && <p>{tr('只分析以上局部范围，不代表全部日志；未修改或静默截断原文。')}</p>}
    {scope.omittedOversized > 0 && <p>{tr('{0} 条记录因单条超出范围预算未纳入，可在原文详情中查看。', { 0: scope.omittedOversized })}</p>}
    <p>{tr('新增日志或修改筛选不会改变本次冻结内容，最终以完整发送确认预览为准。')}</p>
  </div>;
}
