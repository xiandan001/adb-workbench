import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Pause, Play } from 'lucide-react';
import { formatHex } from '../shared/serialFormat.js';
import { tr, useLocale } from '../shared/i18n.js';

function TrafficRow({ row, theme, locale }) {
  const [open, setOpen] = useState(false);
  const long = row.hex.length > 128, tx = row.direction === 'TX';
  return <li className="min-w-0 border-b border-slate-400/15 px-3 py-2 last:border-0">
    <div className={`flex flex-wrap items-center gap-x-2 text-[11px] ${theme.textMuted}`}>
      <span className={`inline-flex shrink-0 items-center gap-1 font-semibold ${tx ? 'text-sky-500' : 'text-emerald-500'}`}>{tx ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{row.direction}</span>
      <time className="tabular-nums">{new Date(row.at).toLocaleTimeString(locale)}</time>
      {row.peerHost && <span className="break-all font-mono">{row.peerHost.includes(':') ? `[${row.peerHost}]` : row.peerHost}:{row.peerPort}</span>}<span>{row.hex.length/2} B</span>
    </div>
    {long ? <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="mt-1 w-full whitespace-pre-wrap break-all text-left font-mono text-xs">{formatHex(open ? row.hex : row.hex.slice(0,128))}{!open && ' …'}</button>
      : <code className="mt-1 block break-all text-xs">{formatHex(row.hex)}</code>}
  </li>;
}
export default function IpControlTraffic({ theme, entries, omitted }) {
  const locale = useLocale(), scroll = useRef(null), [frozen, setFrozen] = useState(null);
  const rows = frozen || entries;
  useEffect(()=>{ if (!frozen && scroll.current) scroll.current.scrollTop=scroll.current.scrollHeight; },[entries, frozen]);
  return <section className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{tr('收发记录')}</h3><span className={`rounded-lg border border-slate-400/20 px-2.5 py-1.5 text-xs ${theme.textMuted}`}>HEX</span>
      <button type="button" aria-pressed={Boolean(frozen)} onClick={()=>setFrozen(previous=>previous ? null : entries)} className={`ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>{frozen ? <Play size={13}/> : <Pause size={13}/>}{frozen ? tr('跟随最新') : tr('暂停滚动')}</button></div>
    <div ref={scroll} className="h-44 min-w-0 overflow-y-auto rounded-lg border border-slate-400/20">
      {rows.length ? <ul>{rows.map(row=><TrafficRow key={row.id} row={row} theme={theme} locale={locale}/>)}</ul> : <div className={`flex h-full items-center justify-center px-5 text-center text-xs ${theme.textMuted}`}>{tr('暂无收发记录')}</div>}
    </div>
    <div className={`flex flex-wrap justify-between gap-2 text-[11px] ${theme.textMuted}`}><span>{tr('最近 {0} 条 · HEX',{0:rows.length})}{omitted && ' · ' + tr('较早的记录未显示。')}</span><span>{frozen ? tr('已暂停滚动，仍持续接收') : tr('跟随最新')}</span></div>
  </section>;
}
