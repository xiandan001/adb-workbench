import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, Loader2, Square, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

const running = status => ['running', 'queued', 'starting', 'recording', 'stopping', 'saving', 'cancelling'].includes(status);
const timestamp = value => Number.isFinite(value) ? value : Date.parse(value) || 0;
export default function WorkbenchActivity({ tasks = [], onOpen, showToast }) {
  const locale = useLocale();
  const [registry, setRegistry] = useState({ items: [], olderCount: 0 });
  const [external, setExternal] = useState({ tasks: [], guards: [], recordings: [] });
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const dialog = useRef(null), toast = useRef(showToast), seenRunning = useRef(new Set()), notified = useRef(new Set());
  useEffect(() => { toast.current = showToast; }, [showToast]);
  useEffect(() => {
    let alive = true;
    const revisions = { registry: 0, tasks: 0, guards: 0, recordings: 0 };
    const acceptRegistry = (value, initial = false) => {
      if (!alive || !Array.isArray(value?.items)) return;
      if (!initial) revisions.registry++;
      for (const item of value.items) {
        if (running(item.status)) seenRunning.current.add(item.id);
        else if (!initial && seenRunning.current.has(item.id) && !notified.current.has(item.id)) {
          notified.current.add(item.id);
          toast.current?.(tr('后台活动已结束：{0}', { 0: item.title }));
        }
      }
      setRegistry(value);
    };
    const acceptTasks = (value, initial = false) => { if (!initial) revisions.tasks++; if (alive) setExternal(previous => ({ ...previous, tasks: [...(value?.activeTasks || []), ...(value?.history || []).slice(0, 10)] })); };
    const acceptGuards = (value, initial = false) => { if (!initial) revisions.guards++; if (alive) setExternal(previous => ({ ...previous, guards: [...(value?.activeGuards || []), ...(value?.history || []).slice(0, 5)] })); };
    const acceptRecording = (value, initial = false) => { if (!initial) revisions.recordings++; if (alive) setExternal(previous => ({ ...previous, recordings: (value?.sessions || []).slice(0, 10) })); };
    const api = window.electronAPI;
    void api?.workbenchActivityList?.().then(value => { if (!revisions.registry) acceptRegistry(value, true); }).catch(() => {});
    void api?.taskState?.().then(value => { if (!revisions.tasks) acceptTasks(value, true); }).catch(() => {});
    void api?.deviceGuardState?.().then(value => { if (!revisions.guards) acceptGuards(value, true); }).catch(() => {});
    void api?.recordingSessionsList?.({}).then(value => { if (!revisions.recordings) acceptRecording(value, true); }).catch(() => {});
    const offs = [api?.onWorkbenchActivity?.(acceptRegistry), api?.onTaskCenterUpdate?.(acceptTasks), api?.onDeviceGuardUpdate?.(acceptGuards), api?.onRecordingState?.(acceptRecording)];
    return () => { alive = false; offs.forEach(off => off?.()); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement, element = dialog.current;
    element?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); element?.close(); previous?.focus?.(); };
  }, [open]);
  const items = useMemo(() => {
    void locale;
    const values = [...registry.items];
    const add = item => { if (!values.some(value => value.id === item.id || value.target?.page === item.target.page && value.target?.id && value.target.id === item.target.id)) values.push(item); };
    for (const task of external.tasks) add({ id: `task:${task.id}`, title: task.scriptName || tr('任务中心'), status: task.status, stage: task.error || '',
      startedAt: timestamp(task.startedAt || task.createdAt), updatedAt: timestamp(task.endedAt || task.startedAt), target: { page: 'tasks', id: task.id } });
    for (const guard of external.guards) add({ id: `guard:${guard.id}`, title: tr('设备守护'), status: guard.status === 'running' ? 'running' : guard.error ? 'failed' : 'completed',
      stage: guard.error || '', deviceId: guard.deviceId, startedAt: timestamp(guard.startedAt), updatedAt: timestamp(guard.endedAt || guard.startedAt), target: { page: 'quality', id: guard.id, deviceId: guard.deviceId } });
    for (const record of external.recordings) add({ id: `recording:${record.id}`, title: tr('录屏'), status: record.status === 'saved' ? 'completed' : ['error', 'needs-save'].includes(record.status) ? 'failed' : record.status,
      stage: record.error || '', deviceId: record.deviceId, startedAt: timestamp(record.startedAt), updatedAt: timestamp(record.endedAt || record.startedAt), target: { page: 'devices', id: record.id, deviceId: record.deviceId } });
    for (const task of tasks) add({ id: `legacy:${task.key}`, title: task.title, status: task.status === 'success' ? 'completed' : task.status, stage: task.message,
      deviceId: task.deviceId, startedAt: 0, updatedAt: 0, target: { page: task.tab, deviceId: task.deviceId } });
    return values.sort((a, b) => Number(running(b.status)) - Number(running(a.status)) || timestamp(b.updatedAt) - timestamp(a.updatedAt));
  }, [registry, external, tasks, locale]);
  const active = items.filter(item => running(item.status)).length, failed = items.filter(item => item.status === 'failed').length;
  const labels = { running: tr('进行中'), queued: tr('排队中'), starting: tr('正在准备'), recording: tr('录制中'), stopping: tr('正在停止'), saving: tr('保存中'),
    cancelling: tr('正在取消'), completed: tr('已完成'), failed: tr('需要处理'), cancelled: tr('已取消') };
  const act = async (id, cancel) => {
    if (busy) return; setBusy(id); setError('');
    try {
      const response = await (cancel ? window.electronAPI.workbenchActivityCancel({ id }) : window.electronAPI.workbenchActivityDismiss({ id }));
      if (!response?.ok) throw new Error(response?.error || tr('后台活动操作未完成。'));
    } catch (failure) { setError(failure.message); } finally { setBusy(''); }
  };
  return <div className="border-t border-[#3E4145] px-4 py-3">
    <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-lg bg-white/5 px-3 py-2.5 text-left text-xs text-slate-200 hover:bg-white/10"><Activity size={16} className={`shrink-0 ${active ? 'text-emerald-400' : 'text-slate-400'}`} /><span className="min-w-0 flex-1"><span className="block truncate">{tr('后台活动')}</span><span className={`mt-0.5 block truncate text-[10px] ${failed ? 'text-amber-400' : 'text-slate-400'}`}>{tr('进行中 {0} · 待处理 {1}', { 0: active, 1: failed })}</span></span></button>
    {open && <dialog ref={dialog} onCancel={event => { event.preventDefault(); setOpen(false); }} className="fixed m-auto max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-slate-600 bg-[#202124] p-0 text-slate-100 shadow-2xl backdrop:bg-black/50" aria-label={tr('后台活动')}>
      <header className="flex items-center justify-between border-b border-white/10 p-4"><h3 className="font-semibold">{tr('后台活动')}</h3><button type="button" autoFocus aria-label={tr('关闭')} onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-white/10"><X size={18} /></button></header>
      <div className="max-h-[60vh] space-y-2 overflow-auto p-4">
        {!items.length && <p className="py-8 text-center text-sm text-slate-400">{tr('当前没有后台活动。')}</p>}
        {items.slice(0, 60).map(item => <div key={item.id} className="rounded-xl border border-white/10 p-3">
          <div className="flex items-start gap-3">{running(item.status) ? <Loader2 size={17} className="mt-1 shrink-0 animate-spin text-emerald-400" /> : item.status === 'failed' ? <CircleAlert size={17} className="mt-1 shrink-0 text-amber-400" /> : <CheckCircle2 size={17} className="mt-1 shrink-0 text-slate-400" />}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { onOpen?.(item.target.page, item.deviceId || item.target.deviceId, item.target.id); setOpen(false); }}><span className="block break-words text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-slate-400">{labels[item.status] || tr('状态未知')}{item.deviceId ? ` · ${item.deviceId}` : ''}</span></button>
            {item.canCancel && <button type="button" disabled={Boolean(busy) || item.status === 'cancelling'} onClick={() => act(item.id, true)} aria-label={tr('取消活动')} className="rounded p-2 text-amber-400 hover:bg-white/10 disabled:opacity-40"><Square size={14} /></button>}
            {!running(item.status) && registry.items.some(value => value.id === item.id) && <button type="button" disabled={Boolean(busy)} onClick={() => act(item.id, false)} aria-label={tr('移除活动记录')} className="rounded p-2 text-slate-400 hover:bg-white/10"><X size={14} /></button>}
          </div>
          {(item.stage || item.detail) && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-400">{item.detail || item.stage}</p>}
          {running(item.status) && item.startedAt > 0 && <p className="mt-2 text-[11px] text-slate-500">{tr('已运行 {0} 秒', { 0: Math.max(0, Math.floor((now - item.startedAt) / 1000)) })}</p>}
          {Number.isFinite(item.progress) && <progress className="mt-2 h-1.5 w-full accent-emerald-500" value={item.progress} max={100} />}
        </div>)}
        {(registry.olderCount > 0 || items.length > 60) && <p className="text-xs text-slate-400">{tr('这里只展示近期活动，较早的结果请在对应页面查看。')}</p>}
        {error && <p role="alert" className="text-xs text-red-400">{tr(error)}</p>}
      </div>
    </dialog>}
  </div>;
}
