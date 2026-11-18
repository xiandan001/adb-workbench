import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Pause, Play } from 'lucide-react';
import { formatHex } from '../shared/serialFormat.js';
import { tr, useLocale } from '../shared/i18n.js';
import { captureIpRecord, ipDirection, ipTransport, rowEndpoint } from '../shared/ipTrafficRecord.js';
import IpControlRecordDetail from './IpControlRecordDetail.jsx';

function TrafficRow({ row, view, theme, clock, onSelect }) {
  const dir = ipDirection(row.direction), address = rowEndpoint(row, view);
  return <li className="min-w-0 border-b border-slate-400/15 last:border-0">
    <button type="button" aria-haspopup="dialog" aria-label={tr('查看 {0} 记录 {1}', { 0: dir, 1: row.id })}
      onClick={event => onSelect(row, event.currentTarget)}
      className="block w-full min-w-0 px-3 py-2 text-left hover:bg-slate-400/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500">
      <span className={`flex min-w-0 items-center gap-2 text-[11px] ${theme.textMuted}`}>
        <span className={`shrink-0 font-semibold ${row.direction === 'RX' ? 'text-emerald-500' : 'text-sky-500'}`}>{dir}</span>
        <time className="shrink-0 tabular-nums">{clock.format(row.at)}</time>
        <span title={address} className="truncate font-mono">{address}</span><span className="shrink-0">{row.hex.length / 2} B</span>
        {row.protocol ? <span className="truncate text-emerald-500">{tr('完整报文')}</span> : <span className="truncate">{ipTransport(view?.mode)}</span>}
        <ChevronRight aria-hidden="true" size={13} className="ml-auto shrink-0" />
      </span>
      <code className="mt-1 block truncate font-mono text-xs">{row.hex ? formatHex(row.hex.slice(0, 128)) + (row.hex.length > 128 ? ' …' : '') : tr('空数据报（0 B）')}</code>
    </button>
  </li>;
}

export default function IpControlTraffic({ theme, entries, omitted, view }) {
  const locale = useLocale(), scroll = useRef(null), trigger = useRef(null);
  const [frozen, setFrozen] = useState(null), [selected, setSelected] = useState(null);
  const rows = frozen || entries;
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false }), [locale]);
  useEffect(() => { if (!frozen && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [entries, frozen]);
  function inspect(row, button) { trigger.current = button; setSelected(captureIpRecord(row, view)); }
  return <section className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{tr('收发记录')}</h3><span className={`rounded-lg border border-slate-400/20 px-2.5 py-1.5 text-xs ${theme.textMuted}`}>HEX</span>
      <button type="button" aria-pressed={Boolean(frozen)} onClick={() => setFrozen(previous => previous ? null : entries)} className={`ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>{frozen ? <Play size={13}/> : <Pause size={13}/>}{frozen ? tr('跟随最新') : tr('暂停滚动')}</button></div>
    <div ref={scroll} role="region" aria-label={tr('网络收发记录')} tabIndex={-1} className={`h-56 min-w-0 overflow-auto rounded-lg border ${theme.input}`}>
      {rows.length ? <ul>{rows.map(row => <TrafficRow key={row.id} row={row} view={view} theme={theme} clock={clock} onSelect={inspect} />)}</ul>
        : <p className={`flex h-full items-center justify-center px-5 text-center text-xs ${theme.textMuted}`}>{tr('暂无收发记录')}</p>}
    </div>
    <div className={`flex flex-wrap justify-between gap-2 text-[11px] ${theme.textMuted}`}><span>{tr('最近 {0} 条 · HEX', { 0: rows.length })}{omitted && ' · ' + tr('较早的记录未显示。')}</span><span>{frozen ? tr('已暂停滚动，仍持续接收') : tr('跟随最新')}{tr(' · 点击记录查看完整内容')}</span></div>
    {selected && <IpControlRecordDetail record={selected} clock={clock} theme={theme} trigger={trigger} fallback={scroll} onClose={() => setSelected(null)} />}
  </section>;
}
