import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, Loader2, Square, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import SidebarConnectionStatus from './SidebarConnectionStatus';
import { WorkbenchSidebarButton } from './WorkbenchSidebar';
import { activityPresentation } from '../shared/activityPresentation.js';
import { activityRunning as running, buildActivityItems, isActivityDismissed, prepareActivityItems, readActivityDismissals, recordActivityDismissals } from '../shared/activityDismissals.js';

export default function WorkbenchActivity({ tasks = [], onOpen, showToast, onNavigateConnection, theme, isDark, rail = false }) {
  const locale = useLocale();
  const colors = activityPresentation(theme, isDark);
  const [registry, setRegistry] = useState({ items: [], olderCount: 0 });
  const [external, setExternal] = useState({ tasks: [], guards: [], recordings: [] });
  const [boot] = useState(() => { try { return { preferences: readActivityDismissals(), error: '' }; } catch (failure) { return { preferences: { version: 1, entries: [] }, error: failure.message }; } });
  const [dismissals, setDismissals] = useState(boot.preferences), [resolvedItems, setResolvedItems] = useState([]);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(boot.error);
  const [now, setNow] = useState(Date.now());
  const [connectionSummary, setConnectionSummary] = useState({ connections: 0, issues: 0 });
  const dialog = useRef(null), toast = useRef(showToast), seenRunning = useRef(new Set()), notified = useRef(new Set());
  const sourceState = useRef({ registry: { items: [] }, external: { tasks: [], guards: [], recordings: [] }, tasks }); sourceState.current.tasks = tasks;
  const occurrences = useRef(new Map()), actionLock = useRef(false), focusAfterClear = useRef(false), clearButton = useRef(null), closeButton = useRef(null), aliveRef = useRef(false);
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
      sourceState.current.registry = value;
      setRegistry(value);
    };
    const updateExternal = (key, rows) => { if (!alive) return; sourceState.current.external = { ...sourceState.current.external, [key]: rows }; setExternal(sourceState.current.external); };
    const acceptTasks = (value, initial = false) => { if (!initial) revisions.tasks++; updateExternal('tasks', [...(value?.activeTasks || []).map(item => ({ ...item, activityActive: true })), ...(value?.history || [])]); };
    const acceptGuards = (value, initial = false) => { if (!initial) revisions.guards++; updateExternal('guards', [...(value?.activeGuards || []).map(item => ({ ...item, activityActive: true })), ...(value?.history || [])]); };
    const acceptRecording = (value, initial = false) => { if (!initial) revisions.recordings++; updateExternal('recordings', value?.sessions || []); };
    const api = window.electronAPI;
    void api?.workbenchActivityList?.().then(value => { if (!revisions.registry) acceptRegistry(value, true); }).catch(() => {});
    void api?.taskState?.().then(value => { if (!revisions.tasks) acceptTasks(value, true); }).catch(() => {});
    void api?.deviceGuardState?.().then(value => { if (!revisions.guards) acceptGuards(value, true); }).catch(() => {});
    void api?.recordingSessionsList?.({}).then(value => { if (!revisions.recordings) acceptRecording(value, true); }).catch(() => {});
    const offs = [api?.onWorkbenchActivity?.(acceptRegistry), api?.onTaskCenterUpdate?.(acceptTasks), api?.onDeviceGuardUpdate?.(acceptGuards), api?.onRecordingState?.(acceptRecording)];
    aliveRef.current = true;
    return () => { alive = false; aliveRef.current = false; offs.forEach(off => off?.()); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement, element = dialog.current;
    element?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); element?.close(); previous?.focus?.(); };
  }, [open]);
  const projectedItems = useMemo(() => { void locale; return buildActivityItems({ registry, external, tasks }); }, [registry, external, tasks, locale]);
  useEffect(() => {
    let alive = true;
    void prepareActivityItems(projectedItems, occurrences.current).then(value => { if (alive) setResolvedItems(value); }).catch(failure => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [projectedItems]);
  const items = useMemo(() => {
    const visible = new Map(resolvedItems.filter(item => !isActivityDismissed(item, dismissals)).map(item => [item.identity, item]));
    for (const item of projectedItems) if (item.active) visible.set(item.identity, { ...item, key: visible.get(item.identity)?.key || `active:${item.identity}` });
    return [...visible.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.through - a.through);
  }, [resolvedItems, projectedItems, dismissals]);
  const endedItems = items.filter(item => !item.active);
  const active = projectedItems.filter(item => item.active).length, failed = items.filter(item => item.status === 'failed').length;
  useEffect(() => {
    if (!open || !focusAfterClear.current) return;
    const frame = requestAnimationFrame(() => {
      if (!aliveRef.current || !dialog.current?.open || !focusAfterClear.current) return;
      focusAfterClear.current = false;
      if (!dialog.current.contains(document.activeElement) || document.activeElement?.disabled) (clearButton.current?.disabled ? closeButton.current : clearButton.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [dismissals, open]);
  const labels = { running: tr('进行中'), queued: tr('排队中'), starting: tr('正在准备'), recording: tr('录制中'), stopping: tr('正在停止'), saving: tr('保存中'),
    cancelling: tr('正在取消'), completed: tr('已完成'), failed: tr('需要处理'), cancelled: tr('已取消') };
  const act = async id => {
    if (actionLock.current) return; actionLock.current = true; setBusy(id); setError('');
    try {
      const response = await window.electronAPI.workbenchActivityCancel({ id });
      if (!response?.ok) throw new Error(response?.error || tr('后台活动操作未完成。'));
    } catch (failure) { if (aliveRef.current) setError(failure.message); } finally { actionLock.current = false; if (aliveRef.current) setBusy(''); }
  };
  const clearRecords = targets => {
    if (actionLock.current) return; actionLock.current = true; setError('');
    try {
      const activeIds = new Set(buildActivityItems(sourceState.current).filter(item => item.active).map(item => item.identity));
      const snapshot = targets.filter(item => !item.active && !activeIds.has(item.identity));
      if (!snapshot.length) return;
      const next = recordActivityDismissals(snapshot); focusAfterClear.current = true; setDismissals(next);
    } catch (failure) { setError(failure.message); } finally { actionLock.current = false; }
  };
  const activityLabel = tr('后台活动');
  const activitySummary = `${tr('进行中 {0} · 待处理 {1}', { 0: active, 1: failed })} · ${tr('连接 {0}', { 0: connectionSummary.connections })}`;
  const activityCount = active + failed;
  return <div className="min-w-0">
    <WorkbenchSidebarButton label={`${activityLabel} · ${activitySummary}`} showHint={rail} onClick={() => setOpen(true)}
      className={`relative flex w-full min-h-[3.375rem] items-center rounded-lg bg-white/5 text-left text-xs text-slate-200 hover:bg-white/10 ${rail ? 'justify-center' : 'gap-2 px-3 py-2.5'}`}>
      <Activity size={16} aria-hidden="true" className={`shrink-0 ${active ? 'text-emerald-400' : 'text-slate-400'}`} />
      {!rail && <span className="min-w-0 flex-1">
        <span className="block truncate">{activityLabel}</span>
        <span className={`mt-0.5 block truncate text-[10px] ${failed ? 'text-amber-400' : 'text-slate-400'}`}>{activitySummary}</span>
      </span>}
      {rail && activityCount > 0 && <span aria-hidden="true" className={`absolute right-0.5 top-0.5 rounded-full px-1 text-[9px] ${failed ? 'bg-amber-900 text-amber-100' : 'bg-emerald-900 text-emerald-100'}`}>{activityCount > 99 ? '99+' : activityCount}</span>}
    </WorkbenchSidebarButton>
    <dialog ref={dialog} style={open ? { display: 'flex', flexDirection: 'column' } : undefined} onCancel={event => { event.preventDefault(); setOpen(false); }} className={`fixed m-auto max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${colors.panel} ${colors.text}`} aria-label={tr('后台活动')}>
      <header className={`flex flex-wrap items-center gap-2 border-b p-4 ${colors.border}`}><h3 className="mr-auto font-semibold">{tr('后台活动')}</h3><button ref={clearButton} type="button" disabled={!endedItems.length || Boolean(busy)} onClick={() => clearRecords(endedItems)} title={tr('只移除列表记录，不取消任务、不删除产物。')} className={`rounded-lg px-2.5 py-2 text-xs disabled:opacity-40 ${colors.muted} ${colors.hover}`}>{tr('清除已结束记录')}</button><button ref={closeButton} type="button" autoFocus aria-label={tr('关闭')} onClick={() => setOpen(false)} className={`rounded-lg p-2 ${colors.hover}`}><X size={18} /></button></header>
      {error && <p role="alert" className="max-h-24 shrink-0 overflow-y-auto border-b border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-500">{tr(error)}</p>}
      <div className="min-h-0 max-h-[60vh] flex-1 space-y-2 overflow-auto p-4">
        <h4 className={`text-xs font-medium ${colors.heading}`}>{tr('连接状态')}</h4>
        <SidebarConnectionStatus isDark={colors.dark} onSummary={setConnectionSummary} onNavigate={page => { setOpen(false); onNavigateConnection?.(page); }} />
        {!connectionSummary.hasRows && <p className={`py-2 text-xs ${colors.muted}`}>{tr('当前没有活动连接。')}</p>}
        <h4 className={`pt-3 text-xs font-medium ${colors.heading}`}>{tr('任务与采集')}</h4>
        {!items.length && <p className={`py-8 text-center text-sm ${colors.muted}`}>{tr('当前没有后台活动。')}</p>}
        {items.slice(0, 60).map(item => <div key={item.key} data-activity-id={item.id} className={`rounded-xl border p-3 ${colors.border}`}>
          <div className="flex items-start gap-3">{item.active ? <Loader2 size={17} className="mt-1 shrink-0 animate-spin text-emerald-400" /> : item.status === 'failed' ? <CircleAlert size={17} className="mt-1 shrink-0 text-amber-400" /> : <CheckCircle2 size={17} className="mt-1 shrink-0 text-slate-400" />}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { onOpen?.(item.target.page, item.deviceId || item.target.deviceId, item.target.id); setOpen(false); }}><span className="block break-words text-sm font-medium">{item.title}</span><span className={`mt-1 block text-xs ${colors.muted}`}>{labels[item.status] || tr('状态未知')}{item.deviceId ? ` · ${item.deviceId}` : ''}</span></button>
            {item.canCancel && <button type="button" disabled={Boolean(busy) || item.status === 'cancelling'} onClick={() => act(item.id)} aria-label={tr('取消活动')} className={`rounded p-2 text-amber-500 disabled:opacity-40 ${colors.hover}`}><Square size={14} /></button>}
            {!item.active && <button type="button" disabled={Boolean(busy)} onClick={() => clearRecords([item])} aria-label={tr('移除活动记录')} title={tr('只移除列表记录，不取消任务、不删除产物。')} className={`rounded p-2 ${colors.muted} ${colors.hover}`}><X size={14} /></button>}
          </div>
          {(item.stage || item.detail) && <p className={`mt-2 whitespace-pre-wrap break-words text-xs ${colors.muted}`}>{item.detail || item.stage}</p>}
          {item.active && item.startedAt > 0 && <p className={`mt-2 text-xs ${colors.muted}`}>{tr('已运行 {0} 秒', { 0: Math.max(0, Math.floor((now - item.startedAt) / 1000)) })}</p>}
          {Number.isFinite(item.progress) && <progress className="mt-2 h-1.5 w-full accent-emerald-500" value={item.progress} max={100} />}
        </div>)}
        {items.length > 60 && <p className={`text-xs ${colors.muted}`}>{tr('这里只展示近期活动，较早的结果请在对应页面查看。')}</p>}
      </div>
    </dialog>
  </div>;
}
