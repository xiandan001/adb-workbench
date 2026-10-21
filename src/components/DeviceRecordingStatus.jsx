import { useEffect, useState } from 'react';
import { CircleAlert, FileText, FolderOpen, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { formatMediaDuration, recordingDuration, savedRecordingVisible } from '../shared/recordingWorkspace';

export default function DeviceRecordingStatus({ recording, isOnline, theme, showToast }) {
  const { session, sessions, pending, error, requestError } = recording;
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState([]);
  const [mediaError, setMediaError] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const savedAt = session?.savedAt || session?.endedAt;
  const status = session?.status;

  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const interval = status === 'recording' ? setInterval(() => setNow(Date.now()), 1000) : null;
    const expires = status === 'saved' ? setTimeout(() => setNow(Date.now()), Math.max(0, Number(savedAt) + 10000 - Date.now())) : null;
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      clearTimeout(expires);
    };
  }, [session?.id, status, savedAt]);

  const mediaAction = async action => {
    if (mediaBusy || !session?.mediaId) return;
    setMediaBusy(true);
    setMediaError('');
    try {
      const result = await window.electronAPI.deviceMediaAction({ id: session.mediaId, action });
      if (!result?.success) throw new Error(result?.error || '无法打开录屏文件');
    } catch (failure) {
      setMediaError(failure.message || '无法打开录屏文件');
      showToast?.(failure.message || '无法打开录屏文件');
    } finally {
      setMediaBusy(false);
    }
  };

  const outstanding = sessions.filter(item => (item.status === 'needs-save' || item.status === 'error') && !dismissed.includes(item.id));
  const active = ['starting', 'recording', 'stopping', 'saving'].includes(status);
  const saved = savedRecordingVisible(session, now) && !dismissed.includes(session?.id);
  const logWarning = (session?.logError || session?.logTruncated) && !dismissed.includes(`logs:${session.id}`);
  if (!active && !saved && !outstanding.length && !error && !requestError && !mediaError && !logWarning) return null;
  const secondary = `rounded-md border px-2 py-1 text-xs ${theme.button.secondary}`;

  return (
    <div className="mt-3 space-y-2 text-xs" aria-label="录屏状态">
      {active && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
        {status === 'recording' ? <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> : <Loader2 size={13} className="animate-spin" />}
        <span>{status === 'recording' ? '录制中' : status === 'starting' ? '正在启动录屏' : status === 'stopping' ? '正在停止录屏' : '正在保存录屏，请稍候'}</span>
        {status !== 'starting' && <span className="font-mono tabular-nums">{formatMediaDuration(recordingDuration(session, now))}</span>}
        {session.withLogs && <span className={theme.textMuted}>同时抓取日志 · 不调用 AI</span>}
        {status === 'recording' && <button type="button" disabled={!isOnline || pending} onClick={recording.stop} className={`${secondary} ml-auto`}>停止并保存</button>}
      </div>}
      {saved && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
        <span className="font-medium">录屏已保存</span>
        <span className={theme.textMuted}>10 秒后收起 · 可从最近文件找回</span>
        {session.mediaId && <>
          <button type="button" disabled={mediaBusy} onClick={() => mediaAction('open')} className={`${secondary} inline-flex items-center gap-1`}><Play size={12} />打开视频</button>
          <button type="button" disabled={mediaBusy} onClick={() => mediaAction('folder')} className={`${secondary} inline-flex items-center gap-1`}><FolderOpen size={12} />打开目录</button>
          {session.logPath && <button type="button" disabled={mediaBusy} onClick={() => mediaAction('log')} className={`${secondary} inline-flex items-center gap-1`}><FileText size={12} />关联日志</button>}
        </>}
        <button type="button" aria-label="收起录屏保存提示" onClick={() => setDismissed(previous => [...previous, session.id])} className="ml-auto rounded p-1"><X size={14} /></button>
      </div>}
      {logWarning && <div role="alert" className="flex items-start gap-2 text-amber-600">
        <p className="min-w-0 flex-1 break-words">{session.logError ? `日志抓取提示：${session.logError}` : '关联日志已达到 100 MB 上限，后续日志未保存，录屏不受影响。'}</p>
        <button type="button" className="shrink-0 underline" onClick={() => setDismissed(previous => [...previous, `logs:${session.id}`])}>收起</button>
      </div>}
      {outstanding.map(item => <div key={item.id} role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <CircleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 break-words">
          <p className="font-medium">{item.status === 'needs-save' ? '录屏尚未保存到电脑' : '录屏未完成'}</p>
          <p className={`mt-1 ${theme.textMuted}`}>{item.error || '请检查设备连接后重试'}{item.status === 'needs-save' && !isOnline ? '；设备重新连接后可重新保存。' : ''}</p>
        </div>
        {item.status === 'needs-save'
          ? <button type="button" disabled={!isOnline || pending} onClick={() => recording.retry(item.id)} className={`${secondary} inline-flex items-center gap-1`}><RefreshCw size={12} />重新保存</button>
          : <button type="button" onClick={() => setDismissed(previous => [...previous, item.id])} className={secondary}>收起</button>}
      </div>)}
      {(error || requestError || mediaError) && <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/20 px-3 py-2 text-red-500">
        <span className="min-w-0 flex-1 break-words">{error || requestError || mediaError}</span>
        {error ? <button type="button" onClick={recording.refresh} className="shrink-0 underline">重试</button>
          : <button type="button" onClick={() => { recording.dismissRequestError(); setMediaError(''); }} className="shrink-0 underline">收起</button>}
      </div>}
    </div>
  );
}
