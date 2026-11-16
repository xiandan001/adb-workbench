import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Copy, Sparkles, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';
import { logEntryTimestamp } from '../shared/logWorkbenchModel.js';
import { logClockLabel, logTimeText } from '../shared/logTimeLabels.js';

export default function LogEntryDetail({ entry, context = [], scopeLabel = '', onClose, onFilter, onTimeWindow, onAnalyze, onMark, busy = false, theme, wrap: preferredWrap, onWrapChange }) {
  useLocale(); const dialog = useRef(null), [localWrap, setLocalWrap] = useState(true), [contextOpen, setContextOpen] = useState(false), [message, setMessage] = useState('');
  const wrap = preferredWrap ?? localWrap;
  useEffect(() => { if (!entry) return; const element = dialog.current, previous = document.activeElement; element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }; }, [entry]);
  if (!entry) return null;
  const dark = isDarkTheme(theme), sourceTime = logEntryTimestamp(entry), received = logEntryTimestamp(entry, 'received');
  const panel = theme?.card || (dark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800');
  const muted = theme?.textMuted || (dark ? 'text-slate-400' : 'text-slate-500');
  const button = `max-w-full break-all rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-40 ${theme?.button?.secondary || 'border-slate-400/30'}`;
  const filter = (field, value) => { onFilter?.({ field, value, mode: 'include' }); onClose(); };
  const pkg = entry.pkg || entry.processName || '';
  return <dialog ref={dialog} aria-label={tr('日志原文详情')} onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); onClose(); }}
    className={`m-auto max-h-[90vh] w-[min(64rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border p-0 shadow-2xl backdrop:bg-black/55 ${panel}`}>
    <header className="flex items-center gap-3 border-b border-slate-400/20 p-4"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{tr('日志原文详情')}</h3>{scopeLabel && <p className={`mt-1 break-words text-xs ${muted}`}>{scopeLabel}</p>}</div><button type="button" autoFocus aria-label={tr('关闭日志详情')} onClick={onClose} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={18} /></button></header>
    <div className="max-h-[68vh] space-y-3 overflow-y-auto p-4">
      <div className={`flex flex-wrap items-center gap-2 text-xs ${muted}`}><span>{logClockLabel(sourceTime.basis)} · {logTimeText(sourceTime.value, sourceTime.reliableDate)}</span>{received.value !== null && <span>{tr('本机接收时间')} · {logTimeText(received.value)}</span>}</div>
      <div className="flex flex-wrap gap-2">{pkg && <button type="button" disabled={!onFilter} onClick={() => filter('pkg', pkg)} className={button}>{tr('按应用筛选 {0}', { 0: pkg })}</button>}{entry.tag && <button type="button" disabled={!onFilter} onClick={() => filter('tag', entry.tag)} className={button}>{tr('按 Tag 筛选 {0}', { 0: entry.tag })}</button>}{Number.isSafeInteger(entry.pid) && <button type="button" disabled={!onFilter} onClick={() => filter('pid', entry.pid)} className={button}>{tr('按 PID 筛选 {0}', { 0: entry.pid })}</button>}</div>
      {onTimeWindow && <button type="button" onClick={() => { onClose(); onTimeWindow(entry); }} className={button}>{tr('查看前后30秒')}</button>}
      <label className={`inline-flex items-center gap-2 text-xs ${muted}`}><input type="checkbox" checked={wrap} onChange={event => onWrapChange ? onWrapChange(event.target.checked) : setLocalWrap(event.target.checked)} className="accent-emerald-500" />{tr('原文自动换行')}</label>
      <pre className={`max-h-[42vh] overflow-auto rounded-lg border border-slate-400/20 p-3 font-mono text-xs leading-5 ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>{entry.raw}</pre>
      {!!context.length && <details open={contextOpen} onToggle={event => setContextOpen(event.currentTarget.open)} className="rounded-lg border border-slate-400/20 p-3"><summary className="cursor-pointer text-xs font-medium">{tr('查看冻结的相邻上下文')}</summary>{contextOpen && <div className="mt-3 max-h-52 overflow-auto">{context.slice(0, 11).map((row, index) => <pre key={index} className="whitespace-pre-wrap break-all border-b border-slate-400/15 py-2 text-xs leading-5">{row.raw}</pre>)}</div>}</details>}
      {message && <p role="status" className={`text-xs ${muted}`}>{message}</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-400/20 p-4"><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(entry.raw); setMessage(tr('原文已复制，未修改日志。')); } catch { setMessage(tr('复制失败，请手动选择原文复制。')); } }} className={button}><Copy size={13} className="mr-1 inline" />{tr('复制原文')}</button>
      <button type="button" disabled={busy || !onMark} onClick={() => onMark(entry)} className={button}><BookmarkPlus size={13} className="mr-1 inline" />{tr('标记此问题')}</button><button type="button" disabled={busy || !onAnalyze} onClick={() => onAnalyze(context.length ? context : [entry])} className={button}><Sparkles size={13} className="mr-1 inline" />{tr('分析这段上下文')}</button></footer>
  </dialog>;
}
