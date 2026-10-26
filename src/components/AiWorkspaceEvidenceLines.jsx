import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateTime, formatNumber, tr, useLocale } from '../shared/i18n';
import { workspaceLinePage } from './AiWorkspaceState';

export default function AiWorkspaceEvidenceLines({ entry, first, highlight, theme }) {
  useLocale();
  const [expanded, setExpanded] = useState(first);
  const [position, setPosition] = useState({ page: 0, focusKey: '' });
  const container = useRef(null);
  const lines = useMemo(() => entry.text ? entry.text.split('\n') : [], [entry.text]);
  const focused = highlight?.evidenceId === entry.id;
  const focusKey = focused ? `${highlight.startLine}:${highlight.endLine}:${highlight.nonce}` : '';
  const requested = focused && focusKey !== position.focusKey ? Math.floor((highlight.startLine - 1) / 80) : position.page;
  const page = workspaceLinePage(lines.length, requested);
  useEffect(() => {
    if (focused) {
      const element = container.current?.querySelector('[data-highlight="true"]');
      element?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      container.current?.focus({ preventScroll: true });
    }
  }, [focused, focusKey]);
  const changePage = next => setPosition({ page: next, focusKey });
  return <details ref={container} open={expanded || focused} onToggle={event => setExpanded(event.currentTarget.open)} tabIndex={-1} className={`rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500/50 ${theme.input}`}>
    <summary className="cursor-pointer px-3 py-2.5 text-xs"><span className="mr-1 font-semibold text-emerald-500">[{entry.id}]</span><span className="font-medium">{entry.label || entry.source}</span>{entry.target && <span className={`ml-2 break-all ${theme.textMuted}`}>{entry.target}</span>}</summary>
    {(expanded || focused) && <div className="space-y-2 border-t border-slate-400/15 p-3">
      <div className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-5 ${theme.textMuted}`}>
        <span>{tr('采集于 {0}', { 0: formatDateTime(entry.capturedAt) })}</span><span>{entry.timeBasis}</span>
        <span>{tr('原始 {0} 行 · 选中 {1} 行 · 保留 {2} 行', { 0: formatNumber(entry.originalLineCount ?? lines.length), 1: formatNumber(entry.selectedLineCount ?? lines.length), 2: formatNumber(entry.retainedLineCount ?? lines.length) })}</span>
        {entry.redactions > 0 && <span>{tr('已脱敏 {0} 行', { 0: formatNumber(entry.redactions) })}</span>}
        {entry.truncated && <span className="text-amber-500">{tr('内容已截断')}</span>}
      </div>
      {entry.windowInfo && <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('本机读取窗口：{0} / {1} 条记录 · 上限 {2} KiB；筛选仅覆盖该窗口。', { 0: formatNumber(entry.windowInfo.retainedRecords), 1: formatNumber(entry.windowInfo.originalRecords), 2: formatNumber(entry.windowInfo.byteLimit / 1024) })}</p>}
      {entry.selectionWarning && <p className="text-[11px] leading-5 text-amber-600 dark:text-amber-400">{entry.selectionWarning}</p>}
      {entry.timeWarning && <p className="text-[11px] leading-5 text-amber-600 dark:text-amber-400">{entry.timeWarning}</p>}
      <div className="max-h-72 overflow-auto font-mono text-xs leading-5">
        {lines.slice(page.start, page.end).map((line, index) => {
          const number = page.start + index + 1;
          const marked = focused && number >= highlight.startLine && number <= highlight.endLine;
          const original = entry.originalLineNumbers?.[number - 1];
          return <div key={number} data-highlight={marked ? 'true' : undefined} className={`flex min-w-0 gap-3 px-1 ${marked ? 'bg-amber-400/20 ring-1 ring-inset ring-amber-500/30' : ''}`}>
            <span className={`w-10 shrink-0 select-none text-right ${theme.textMuted}`} title={original ? tr('来源原始第 {0} 行', { 0: original }) : undefined}>{number}</span>
            <span className="min-w-0 whitespace-pre-wrap break-all [tab-size:2]">{(entry.numbered ? line.replace(/^\[L\d+\] ?/, '') : line) || ' '}</span>
          </div>;
        })}
      </div>
      <div className={`flex flex-wrap items-center justify-between gap-2 text-[11px] ${theme.textMuted}`}>
        <span>{tr('显示第 {0}–{1} 行 / 共 {2} 行；页码只影响显示，不改变发送内容。', { 0: lines.length ? page.start + 1 : 0, 1: page.end, 2: lines.length })}</span>
        <div className="flex items-center gap-2"><button type="button" aria-label={tr('上一页证据')} disabled={page.page === 0} onClick={() => changePage(page.page - 1)} className={`rounded p-1 disabled:opacity-30 ${theme.button.secondary}`}><ChevronLeft size={14} /></button><span>{page.page + 1} / {page.count}</span><button type="button" aria-label={tr('下一页证据')} disabled={page.page + 1 >= page.count} onClick={() => changePage(page.page + 1)} className={`rounded p-1 disabled:opacity-30 ${theme.button.secondary}`}><ChevronRight size={14} /></button></div>
      </div>
    </div>}
  </details>;
}

export function AiWorkspaceEvents({ entries, onCitation, theme }) {
  useLocale();
  const rows = useMemo(() => entries.flatMap(entry => {
    const lines = entry.text.split('\n');
    return (entry.events || []).map(event => ({ ...event, evidenceId: entry.id, label: entry.label, text: lines[event.line - 1]?.slice(0, 200) || '' }));
  }).slice(0, 64), [entries]);
  if (!rows.length) return null;
  const basis = { 'explicit-offset': tr('带时区的来源时间'), 'source-local': tr('来源本地时间'), 'device-local-year-unknown': tr('设备时间（年份未知）'), 'host-receive': tr('本机接收时间'), unknown: tr('未知时间基础') };
  return <details className={`rounded-lg border p-3 ${theme.input}`}>
    <summary className="cursor-pointer text-xs font-medium">{tr('本地事件索引（最多 64 条）')}</summary>
    <p className={`my-2 text-[11px] leading-5 ${theme.textMuted}`}>{tr('按证据来源排列，不是跨设备统一时间线；点击行号核验原文。')}</p>
    <div className="max-h-64 overflow-auto"><table className="w-full text-left text-[11px]"><thead><tr className={theme.textMuted}><th className="px-1 py-2">{tr('来源 / 行号')}</th><th className="px-1 py-2">{tr('观察到的时间')}</th><th className="px-1 py-2">{tr('原文片段')}</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.evidenceId}-${row.line}-${index}`} className="border-t border-slate-400/15"><td className="px-1 py-2 align-top"><button type="button" className="text-emerald-600 dark:text-emerald-400" onClick={() => onCitation?.({ evidenceId: row.evidenceId, startLine: row.line, endLine: row.line })}>{row.evidenceId}:{row.line}</button></td><td className="px-1 py-2 align-top"><span className="block break-all">{row.timestamp}</span><span className={theme.textMuted}>{basis[row.clockBasis] || basis.unknown}</span></td><td className="max-w-xs break-all px-1 py-2 align-top">{row.text}</td></tr>)}</tbody></table></div>
  </details>;
}
