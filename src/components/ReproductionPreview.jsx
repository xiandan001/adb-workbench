import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, FileText, Play } from 'lucide-react';
import { tr, useLocale, formatDateTime } from '../shared/i18n';

export default function ReproductionPreview({ session, videoUrl, theme }) {
  useLocale();
  const video = useRef(null), epoch = useRef(0);
  const [content, setContent] = useState({ name: '', text: '', truncated: false });
  const [page, setPage] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState(0);
  const lines = useMemo(() => content.text.split('\n'), [content.text]);
  useEffect(() => () => { epoch.current++; }, []);
  const read = async name => {
    const token = ++epoch.current; setLoading(true); setError('');
    try {
      const result = await window.electronAPI.reproductionRead({ id: session.id, name });
      if (token !== epoch.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('证据读取失败。'));
      setContent({ name, text: result.text, truncated: result.truncated }); setPage(0);
    } catch (failure) { if (token === epoch.current) setError(failure.message); }
    finally { if (token === epoch.current) setLoading(false); }
  };
  const seek = marker => {
    if (!video.current || !Number.isFinite(marker.videoOffsetMs)) return;
    video.current.currentTime = Math.min(Math.max(0, duration - 0.01), marker.videoOffsetMs / 1000);
    video.current.focus();
  };
  return <section className="space-y-4" aria-label={tr('复现证据预览')}>
    {session.unsaved && <p role="alert" className="text-xs text-amber-500">{tr('采集已结束，但状态尚未写入磁盘。请重试保存后再退出。')}</p>}
    <div className={`rounded-xl border p-3 ${theme.card}`}><h4 className="font-semibold">{session.title}</h4><p className={`mt-1 break-all text-xs ${theme.textMuted}`}>{session.deviceId} · {formatDateTime(session.startedAt)}</p></div>
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('标记使用本机时间，视频定位为近似偏移；不同来源的设备时钟未经同步。')}</p>
    {videoUrl && <video ref={video} src={videoUrl} controls preload="metadata" onLoadedMetadata={() => setDuration(Number.isFinite(video.current?.duration) ? video.current.duration : 0)} onError={() => setError(tr('视频暂时无法播放，其他证据仍可查看或导出。'))} className="max-h-64 w-full rounded-xl bg-black" />}
    <div className="space-y-2"><h4 className="flex items-center gap-2 text-sm font-medium"><Clock size={15} />{tr('问题标记')}</h4>
      {!session.markers.length && <p className={`text-xs ${theme.textMuted}`}>{tr('尚未添加问题标记。')}</p>}
      <div className="max-h-48 space-y-2 overflow-auto">{session.markers.map(marker => <div key={marker.id} className={`flex items-start gap-2 rounded-lg border p-2 ${theme.card}`}><span className={`shrink-0 text-xs ${theme.textMuted}`}>{(marker.offsetMs / 1000).toFixed(1)} s</span><span className="min-w-0 flex-1 break-words text-xs">{marker.note}</span>{videoUrl && marker.videoOffsetMs !== null && <button type="button" onClick={() => seek(marker)} disabled={!duration || marker.videoOffsetMs / 1000 > duration} className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${theme.button.secondary}`}><Play size={12} className="mr-1 inline" />{tr('定位视频')}</button>}</div>)}</div>
    </div>
    <div className="space-y-2"><h4 className="flex items-center gap-2 text-sm font-medium"><FileText size={15} />{tr('本次采集的文件')}</h4>
      {!session.files.length && <p className={`text-xs ${theme.textMuted}`}>{tr('尚无已保存的证据文件。')}</p>}
      <div className="flex flex-wrap gap-2">{session.files.filter(file => file.name !== 'video.mp4').map(file => <button key={file.name} type="button" disabled={loading} onClick={() => read(file.name)} className={`rounded-lg border px-3 py-2 text-xs ${theme.button.secondary}`}>{file.label} · {(file.bytes / 1024).toFixed(1)} KiB{file.truncated ? ` · ${tr('内容不完整')}` : ''}</button>)}</div>
      {content.name && <div className={`rounded-lg border p-3 ${theme.input}`}><p className={`mb-2 text-xs ${theme.textMuted}`}>{content.name}{content.truncated ? ` · ${tr('预览仅显示最近 64 KiB，导出包含已保存文件。')}` : ''}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">{lines.slice(page * 100, (page + 1) * 100).join('\n')}</pre><div className="mt-2 flex items-center justify-end gap-2 text-xs"><button type="button" disabled={!page} onClick={() => setPage(value => value - 1)} className="disabled:opacity-30">{tr('上一页')}</button><span>{page + 1} / {Math.max(1, Math.ceil(lines.length / 100))}</span><button type="button" disabled={(page + 1) * 100 >= lines.length} onClick={() => setPage(value => value + 1)} className="disabled:opacity-30">{tr('下一页')}</button></div></div>}
    </div>
    {session.warnings.map((warning, index) => <p key={index} className="whitespace-pre-wrap break-words text-xs text-amber-600 dark:text-amber-400">{warning}</p>)}
    {error && <p role="alert" className="text-xs text-red-500">{tr(error)}</p>}
  </section>;
}
