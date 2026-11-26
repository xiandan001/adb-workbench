import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { logTimeText } from '../shared/logTimeLabels';
import { performanceNoticeLabel } from '../shared/performanceChart';

export default function PerformanceIncidentEvidence({ incident, deviceName, onClose, onLogTimes, theme, panelClass }) {
  useLocale();
  const { deviceId, point } = incident;
  const timestamp = point.timestamp;
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(null);
  const data = loaded?.version === version ? loaded.data : null;
  const failure = loaded?.version === version && !loaded.data;
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => current ? window.electronAPI?.logIncidentContext?.({ deviceId, timestamp }) : null).then(result => {
      if (!current) return;
      const matching = result?.ok && result.deviceId === deviceId && result.timestamp === timestamp && Array.isArray(result.rows) ? result : null;
      setLoaded({ version, data: matching });
      onLogTimes?.(deviceId, timestamp, matching?.rows.map(row => row.receivedAt) || []);
    }, () => {
      if (!current) return;
      setLoaded({ version, data: null });
      onLogTimes?.(deviceId, timestamp, []);
    });
    return () => { current = false; };
  }, [deviceId, timestamp, version, onLogTimes]);

  return <aside className={`min-w-0 rounded-xl border p-4 shadow-sm ${panelClass}`} aria-label={tr('附近的日志')}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><FileText size={16} className="shrink-0 text-emerald-500" />{tr('附近的日志')}</h3>
        <p className={`mt-1 break-words text-xs ${theme.textMuted}`}>{deviceName || deviceId} · {logTimeText(timestamp)}</p>
      </div>
      <button type="button" onClick={onClose} aria-label={tr('关闭')} className={`rounded-md border p-1.5 ${theme.button.secondary}`}><X size={14} /></button>
    </div>
    {!!point.notices?.length && <div className="mt-3 flex flex-wrap gap-1.5">{point.notices.map((notice, index) => <span key={index}
      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs">{performanceNoticeLabel(notice)}</span>)}</div>}
    <p className={`mt-3 text-xs leading-relaxed ${theme.textMuted}`}>{tr('按本机接收时间查看前后 30 秒，仅显示已保留的抓取日志。时间接近不代表因果。')}</p>

    {!data && !failure && <p role="status" className={`mt-4 text-sm ${theme.textMuted}`}>{tr('正在读取附近日志…')}</p>}
    {failure && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-xs"><span>{tr('附近证据读取失败。')}</span>
      <button type="button" onClick={() => setVersion(previous => previous + 1)} className="underline">{tr('重试')}</button></div>}
    {data && <div className="mt-3 space-y-2">
      {!data.rows.length && <p className={`rounded-lg border border-dashed border-current/20 p-3 text-xs ${theme.textMuted}`}>
        {data.status === 'no-source' ? tr('这台设备没有当前保留的抓取日志，未读取其他设备。') : tr('这个时间窗口没有找到已保留的日志。')}
      </p>}
      {data.truncated && <p role="status" className={`text-xs ${theme.textMuted}`}>{tr('当前仅展示附近有限的日志，记录可能不完整。')}</p>}
      {!!data.rows.length && <ul className="max-h-80 space-y-2 overflow-y-auto pe-1">
        {data.rows.map((entry, index) => <li key={`${entry.id}-${index}`} className="min-w-0">
          <details className="rounded-lg border border-slate-400/25">
            <summary className="cursor-pointer p-2">
              <span className={`text-xs ${theme.textMuted}`}>{logTimeText(entry.receivedAt)} · {entry.level || '—'}{entry.tag ? ` · ${entry.tag}` : ''}</span>
              <span className="mt-1 block truncate font-mono text-xs">{entry.raw}</span>
            </summary>
            <pre className="whitespace-pre-wrap break-all border-t border-slate-400/20 p-2 text-xs">{entry.raw}</pre>
            {entry.previewTruncated && <p className={`px-2 pb-2 text-xs ${theme.textMuted}`}>{tr('该日志行仅展示部分原文。')}</p>}
          </details>
        </li>)}
      </ul>}
    </div>}
    {data && <div className="mt-3 flex justify-end"><button type="button" onClick={() => setVersion(previous => previous + 1)}
      className={`rounded-md border px-2.5 py-1.5 text-xs ${theme.button.secondary}`}>{tr('刷新')}</button></div>}
  </aside>;
}
