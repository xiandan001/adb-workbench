import { useEffect, useRef, useState } from 'react';
import { Camera, ChevronDown, Copy, FileText, FolderOpen, Loader2, Play, RefreshCw, Video } from 'lucide-react';
import { recentDeviceMedia, formatMediaBytes } from '../shared/deviceMediaWorkspace';
import { formatMediaDuration } from '../shared/recordingWorkspace';

export default function DeviceRecentMedia({ deviceId, theme, showToast }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const refreshRef = useRef(null);
  const actionPending = useRef(false);
  const sectionId = `device-media-${encodeURIComponent(deviceId)}`;

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const requestedRevision = ++revision;
      setLoading(true);
      setError('');
      try {
        const result = await window.electronAPI.deviceMediaList({ deviceId });
        if (disposed || requestedRevision !== revision) return;
        if (!result?.success) throw new Error(result?.error || '无法读取最近文件');
        setItems(recentDeviceMedia(result.items, deviceId));
      } catch (failure) {
        if (!disposed && requestedRevision === revision) setError(failure.message || '无法读取最近文件');
      } finally {
        if (!disposed && requestedRevision === revision) setLoading(false);
      }
    };
    refreshRef.current = refresh;
    const unsubscribe = window.electronAPI?.onDeviceMediaChanged?.(() => { void refresh(); });
    const initial = setTimeout(() => { void refresh(); }, 0);
    return () => {
      disposed = true;
      clearTimeout(initial);
      unsubscribe?.();
      refreshRef.current = null;
    };
  }, [open, deviceId]);

  const act = async (id, action) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusyId(id);
    setError('');
    try {
      const result = await window.electronAPI.deviceMediaAction({ id, action });
      if (!result?.success) throw new Error(result?.error || '文件操作未完成');
      if (action === 'copy') showToast?.('截图已复制');
    } catch (failure) {
      setError(failure.message || '文件操作未完成');
    } finally {
      actionPending.current = false;
      setBusyId('');
    }
  };
  const actionClass = `inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${theme.button.secondary}`;

  return (
    <section className="mt-3" aria-label="设备最近文件">
      <button type="button" aria-expanded={open} aria-controls={sectionId} onClick={() => setOpen(previous => !previous)} className={`inline-flex items-center gap-1.5 rounded-md py-1 text-xs ${theme.textMuted}`}>
        <ChevronDown size={14} className={open ? '' : '-rotate-90'} /><FolderOpen size={14} />最近文件
      </button>
      {open && <div id={sectionId} className="mt-2 rounded-lg border border-[var(--device-divider)]">
        <div className={`flex items-center justify-between border-b border-[var(--device-divider)] px-3 py-2 text-xs ${theme.textMuted}`}>
          <span>最近 10 个截图和录屏 · 保留原文件</span>
          <button type="button" disabled={loading} onClick={() => refreshRef.current?.()} aria-label="刷新最近文件" className="rounded p-1"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
        </div>
        {error && <p role="alert" className="px-3 py-2 text-xs text-red-500">{error}</p>}
        {!items.length && <p className={`px-3 py-4 text-center text-xs ${theme.textMuted}`}>{loading ? '正在读取文件...' : error ? '请刷新后重试' : '暂无文件，截图或录屏完成后会显示在这里'}</p>}
        <div className="max-h-64 overflow-auto">
          {items.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--device-divider)] px-3 py-2 last:border-b-0">
            {item.type === 'video' ? <Video size={15} className="shrink-0" /> : <Camera size={15} className="shrink-0" />}
            <div className="min-w-0 flex-1 basis-36">
              <p className="truncate text-xs" title={item.path}>{item.name || (item.type === 'video' ? '录屏' : '截图')}</p>
              <p className={`mt-1 text-[11px] ${theme.textMuted}`}>{new Date(item.createdAt).toLocaleString()} · {formatMediaBytes(item.bytes)}{item.type === 'video' && Number.isFinite(item.durationMs) ? ` · ${formatMediaDuration(item.durationMs)}` : ''}</p>
              {item.exists === false && <p className="mt-1 text-[11px] text-amber-500">文件已移动或删除</p>}
              {item.logTruncated && <p className="mt-1 text-[11px] text-amber-500">关联日志达到 100 MB 上限，已截断</p>}
              {item.logError && <p className="mt-1 break-words text-[11px] text-amber-500">日志抓取提示：{item.logError}</p>}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {busyId === item.id && <Loader2 size={13} className="animate-spin" />}
              <button type="button" disabled={Boolean(busyId) || item.exists === false} onClick={() => act(item.id, 'open')} className={actionClass}><Play size={12} />打开</button>
              <button type="button" disabled={Boolean(busyId)} onClick={() => act(item.id, 'folder')} className={actionClass}><FolderOpen size={12} />目录</button>
              {item.type === 'image' && <button type="button" disabled={Boolean(busyId) || item.exists === false} onClick={() => act(item.id, 'copy')} className={actionClass}><Copy size={12} />复制</button>}
              {item.logPath && <button type="button" disabled={Boolean(busyId)} onClick={() => act(item.id, 'log')} className={actionClass}><FileText size={12} />日志</button>}
            </div>
          </div>)}
        </div>
      </div>}
    </section>
  );
}
