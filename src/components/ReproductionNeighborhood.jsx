import { tr, useLocale } from '../shared/i18n';

export default function ReproductionNeighborhood({ value, loading, theme, onReadFile }) {
  useLocale();
  if (loading) return <p role="status" className={`text-xs ${theme.textMuted}`}>{tr('正在读取附近证据…')}</p>;
  if (!value) return null;
  return <section aria-label={tr('附近证据（前后 10 秒）')} className={`space-y-3 rounded-xl border p-3 ${theme.card}`}>
    <h4 className="text-sm font-semibold">{tr('附近证据（前后 10 秒）')} · {value.marker.note}</h4>
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('仅按本机接收或采样时间定位；不代表设备事件的精确发生时间。')}</p>
    {value.clockUncertain && <p className="text-xs text-amber-500">{tr('本机时钟发生变化，旧记录无法可靠对齐。')}</p>}
    {!value.sources.length && <p className="text-xs">{tr('该窗口未找到可定位的记录。')}</p>}
    {value.sources.map(source => <div key={source.name} className="space-y-2 rounded-lg border border-current/10 p-3">
      <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-medium">{source.label}</span><button type="button" onClick={() => onReadFile(source.name)} className="text-emerald-500 hover:underline">{tr('查看原文件')}</button></div>
      {source.clockBasis === 'device-unsynchronized' ? <p className={`text-xs ${theme.textMuted}`}>{tr('此文件没有可校准的本机时间，请查看原文件。')}</p> : <>
        {source.error && <p role="alert" className="text-xs text-red-500">{tr(source.error)}</p>}
        {(source.truncated || source.malformed > 0) && <p className="text-xs text-amber-500">{tr('扫描或预览达到上限，或部分记录不可读；以下仅为部分证据。')}</p>}
        {!source.error && !source.entries.length && <p className={`text-xs ${theme.textMuted}`}>{source.truncated || source.malformed > 0 || source.unaligned > 0 ? tr('当前片段未能定位附近记录；这不表示该时间窗口没有事件，请查看原文件。') : tr('该窗口未找到可定位的记录。')}</p>}
        <div className="max-h-64 space-y-2 overflow-auto">{source.entries.map((entry, index) => <div key={index} className="text-xs"><p className={theme.textMuted}>{entry.relativeMs < 0 ? tr('标记前 {0} 秒', { 0: (Math.abs(entry.relativeMs) / 1000).toFixed(1) }) : tr('标记后 {0} 秒', { 0: (entry.relativeMs / 1000).toFixed(1) })}</p><pre className="mt-1 whitespace-pre-wrap break-all leading-5">{entry.text}</pre></div>)}</div>
      </>}
    </div>)}
  </section>;
}
