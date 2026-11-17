import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogDisplayInfo({ expanded = false, onExpandedChange, title, sourceIdentity, captureState, paused = false,
  diagnosticIssue = false, sourceMismatch = false, timeWarningCount = 0, filterCount = 0, notice, controls, children, isDark = false }) {
  useLocale();
  const bodyId = useId();
  const badge = 'rounded px-1.5 py-0.5 text-[11px] font-normal';
  return <section aria-label={tr('日志显示信息')} className={`shrink-0 border-b ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
    <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs">
      <button type="button" aria-label={expanded ? tr('收起日志信息') : tr('展开日志信息')} aria-expanded={expanded} aria-controls={bodyId}
        onClick={() => onExpandedChange(!expanded)} className="flex min-w-0 flex-[1_1_22rem] flex-wrap items-center gap-x-2 gap-y-1 rounded py-1 text-left focus-visible:outline-2 focus-visible:outline-emerald-500">
        <ChevronDown size={14} aria-hidden="true" className={`shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className={`min-w-0 max-w-full truncate text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{title}</span>
        {sourceIdentity && <span title={sourceIdentity} className="max-w-[min(14rem,35vw)] truncate font-mono text-[11px] opacity-70">{sourceIdentity}</span>}
        <span aria-live="polite" className="contents">
          {captureState === 'running' && <span className={`${badge} bg-emerald-500/10 text-emerald-500`}>{tr('抓取中')}</span>}
          {captureState === 'stopped' && <span className={`${badge} bg-slate-400/10`}>{tr('已停止抓取')}</span>}
          {paused && <span className={`${badge} bg-amber-500/10 text-amber-500`}>{tr('查看已暂停')}</span>}
          {sourceMismatch && <span className={`${badge} bg-amber-500/10 text-amber-500`}>{tr('显示原来源')}</span>}
          {diagnosticIssue && <span className={`${badge} bg-amber-500/10 text-amber-500`}>{tr('诊断异常')}</span>}
          {timeWarningCount > 0 && <span className={`${badge} bg-amber-500/10 text-amber-500`}>{tr('时间需核对')}</span>}
          {filterCount > 0 && <span className={`${badge} bg-emerald-500/10 text-emerald-500`}>{tr('已筛选 {0} 项', { 0: filterCount })}</span>}
          {notice && <span title={notice} className="max-w-[min(18rem,40vw)] truncate text-[11px] font-normal opacity-80">{notice}</span>}
        </span>
        <span className="ml-auto shrink-0 text-[11px] opacity-70">{expanded ? tr('收起') : tr('详情')}</span>
      </button>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{controls}</div>
    </header>
    <div id={bodyId} hidden={!expanded}>
      {expanded && <div role="region" aria-label={tr('日志信息详情')} className={`space-y-2 border-t border-slate-400/15 px-4 py-2 text-xs ${isDark ? 'bg-black/10' : 'bg-slate-50/70'}`}>{children}</div>}
    </div>
  </section>;
}
