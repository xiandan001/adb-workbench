import { AlertTriangle, BookmarkPlus, LocateFixed, Sparkles } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { logClockLabel, logTimeText } from '../shared/logTimeLabels.js';

export default function LogIssueInbox({ groups = [], onSelect, onAnalyze, onMark, selectedId = '', busy = false, ungroupedIssueCount = 0, theme }) {
  useLocale(); const dark = isDarkTheme(theme);
  const panel = theme?.card || (dark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800');
  const muted = theme?.textMuted || (dark ? 'text-slate-400' : 'text-slate-500');
  const secondary = `rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme?.button?.secondary || 'border-slate-400/30'}`;
  return <section aria-label={tr('本地问题收件箱')} className={`min-w-0 rounded-xl border p-3 ${panel}`}>
    <header className="flex items-center gap-2"><AlertTriangle size={16} className="shrink-0 text-amber-500" /><h3 className="min-w-0 flex-1 text-sm font-semibold">{tr('本地问题收件箱')}</h3><span className={`text-xs ${muted}`}>{tr('{0} 组', { 0: groups.length })}</span></header>
    <p className={`mt-2 text-xs leading-5 ${muted}`}>{tr('规则命中与错误日志只是排查线索，不代表已确认根因；原始日志保持不变。')}</p>
    {!groups.length && <p className={`py-4 text-center text-xs ${muted}`}>{tr('当前范围没有匹配的问题线索，不等于设备没有问题。')}</p>}
    <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
      {groups.slice(0, 100).map(group => {
        const entry = group.representative, summary = String(entry?.message || entry?.raw || '').slice(0, 240).split(/\r?\n/)[0];
        return <article key={group.id} className={`min-w-0 rounded-lg border p-3 ${group.id === selectedId ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-slate-400/20'}`}>
          <button type="button" disabled={!entry} onClick={() => onSelect?.(group)} className="w-full min-w-0 text-left disabled:opacity-40"><span className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words text-xs font-medium">{summary || tr('错误日志线索')}</span><span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600">×{group.count}</span></span>
            <span className={`mt-1 block break-all text-[11px] ${muted}`}>{[entry?.pkg || entry?.processName, entry?.tag].filter(Boolean).join(' · ')}</span></button>
          <p className={`mt-2 text-[11px] leading-5 ${muted}`}>{logClockLabel(group.timeBasis)}<br />{logTimeText(group.firstTime, group.reliableDate)} → {logTimeText(group.lastTime, group.reliableDate)}</p>
          {group.label && <p className={`mt-1 text-[11px] ${muted}`}>{group.label}</p>}
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={!entry} onClick={() => onSelect?.(group)} className={secondary}><LocateFixed size={12} className="mr-1 inline" />{tr('查看原文与上下文')}</button>
            <button type="button" disabled={busy || !entry || !onMark} onClick={() => onMark(group)} className={secondary}><BookmarkPlus size={12} className="mr-1 inline" />{tr('标记此问题')}</button>
            <button type="button" disabled={busy || !group.context?.length || !onAnalyze} onClick={() => onAnalyze(group)} className={secondary}><Sparkles size={12} className="mr-1 inline" />{tr('分析此问题')}</button></div>
        </article>;
      })}
    </div>
    {ungroupedIssueCount > 0 && <p role="status" className="mt-2 text-xs leading-5 text-amber-600">{tr('另有 {0} 条问题日志未列入前 100 组，原文仍可筛选查看。', { 0: ungroupedIssueCount })}</p>}
  </section>;
}
