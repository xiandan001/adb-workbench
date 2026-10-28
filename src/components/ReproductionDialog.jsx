import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Download, Loader2, Play, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { tr, useLocale, formatDateTime } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import ReproductionPreview from './ReproductionPreview';

export default function ReproductionDialog({ theme, devices = [], deviceId = '', sessionId = '', onClose }) {
  useLocale();
  const dialog = useRef(null), alive = useRef(true), request = useRef(0);
  const initializedSelection = useRef(Boolean(sessionId));
  const [state, setState] = useState({ sessions: [], activeId: '', unreadable: 0 });
  const [sources, setSources] = useState({ serial: [], ssh: [] });
  const [selectedDevice, setSelectedDevice] = useState(deviceId), [title, setTitle] = useState(tr('问题复现'));
  const [selection, setSelection] = useState({ video: false, logs: false, performance: false, serial: [], ssh: [] });
  const [duration, setDuration] = useState(60000), [note, setNote] = useState('');
  const [opened, setOpened] = useState(null), [viewId, setViewId] = useState(sessionId), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isDark = isDarkTheme(theme);
  const panel = isDark ? 'bg-[#202124] border-slate-600 text-slate-100' : 'bg-white border-slate-200 text-slate-800';
  const active = state.sessions.find(item => item.id === state.activeId), current = opened?.session;
  const currentId = current?.id, currentStatus = current?.status;
  const currentActive = current && current.id === state.activeId;
  const input = `w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`;
  const refresh = async () => {
    const [list, available] = await Promise.all([window.electronAPI.reproductionList(), window.electronAPI.reproductionSources()]);
    if (!alive.current) return;
    if (!list?.ok || !available?.ok) throw new Error(list?.error || available?.error || tr('复现会话读取失败。'));
    setState(list); setSources(available);
    if (!initializedSelection.current) {
      initializedSelection.current = true;
      if (list.activeId) setViewId(list.activeId);
    }
  };
  useEffect(() => {
    alive.current = true;
    request.current++;
    const previous = document.activeElement, element = dialog.current; element?.showModal();
    void refresh().catch(failure => { if (alive.current) setError(failure.message); });
    const off = window.electronAPI?.onReproductionUpdate?.(event => {
      if (!alive.current || !event?.session) return;
      const session = event.session;
      setState(value => ({ ...value, sessions: [session, ...value.sessions.filter(item => item.id !== session.id)], activeId: ['starting', 'recording', 'stopping'].includes(session.status) ? session.id : value.activeId === session.id ? '' : value.activeId }));
      setOpened(value => value?.session.id === session.id ? { ...value, session } : value);
    });
    return () => { alive.current = false; off?.(); element?.close(); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    if (!viewId) return;
    const token = ++request.current;
    void window.electronAPI.reproductionOpen({ id: viewId }).then(value => {
      if (!alive.current || token !== request.current) return;
      if (!value?.ok) throw new Error(value?.error || tr('复现会话读取失败。'));
      setOpened(value);
    }).catch(failure => { if (alive.current && token === request.current) setError(failure.message); });
  }, [viewId]);
  useEffect(() => {
    if (!currentId || !['completed', 'partial', 'interrupted'].includes(currentStatus)) return;
    const token = request.current;
    void window.electronAPI.reproductionOpen({ id: currentId }).then(value => {
      if (alive.current && request.current === token && value.ok) setOpened(value);
    }).catch(() => {});
  }, [currentId, currentStatus]);
  const execute = async (operation, action) => {
    if (busy) return;
    setBusy(operation); setError(''); setNotice('');
    try {
      const result = await action();
      if (!alive.current) return;
      if (result?.session) { setOpened({ session: result.session, videoUrl: '' }); setViewId(result.session.id); }
      if (!result?.ok) throw new Error(result?.error || tr('复现会话操作未完成。'));
      if (operation === 'analyze') { onClose(); return; }
      if (operation === 'export' && !result.cancelled) setNotice(tr('复现证据包已导出，原始文件保持不变。'));
      if (operation === 'stop' && result.session) {
        const preview = await window.electronAPI.reproductionOpen({ id: result.session.id });
        if (alive.current && preview.ok) setOpened(preview);
      }
      await refresh();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(''); }
  };
  const toggle = (kind, item) => setSelection(value => ({ ...value, [kind]: value[kind].some(ref => JSON.stringify(ref) === JSON.stringify(item)) ? value[kind].filter(ref => JSON.stringify(ref) !== JSON.stringify(item)) : [...value[kind], item] }));
  const hasSelection = selection.video || selection.logs || selection.performance || selection.serial.length || selection.ssh.length;
  const status = { starting: tr('正在准备'), recording: tr('正在采集'), stopping: tr('正在保存'), completed: tr('已完成'), partial: tr('部分完成'), interrupted: tr('已中断') };
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={tr('复现采证')} className={`fixed m-auto max-h-[92vh] w-[min(68rem,calc(100vw-2rem))] rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${panel}`}>
    <header className="flex items-center justify-between border-b border-current/10 p-4"><div><h3 className="text-lg font-semibold">{tr('复现采证')}</h3><p className={`mt-1 text-xs ${theme.textMuted}`}>{tr('把本次复现的所选证据保存在同一会话；不会自动发送给 AI。')}</p></div><button type="button" autoFocus onClick={onClose} aria-label={tr('关闭')} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={20} /></button></header>
    <div className="grid max-h-[72vh] gap-5 overflow-y-auto p-5 md:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.3fr)]">
      <div className="min-w-0 space-y-4">
        <label className="block space-y-1 text-xs">{tr('复现会话名称')}<input className={input} maxLength={100} value={title} disabled={Boolean(active || busy)} onChange={event => setTitle(event.target.value)} /></label>
        <SelectMenu ariaLabel={tr('复现目标设备')} value={selectedDevice} onChange={setSelectedDevice} isDark={isDark} disabled={Boolean(active || busy)} className="w-full" options={[{ value: '', label: tr('请选择在线设备') }, ...devices.filter(device => device.status === 'device').map(device => ({ value: device.id, label: `${device.model || device.name || device.id} · ${device.id}` }))]} />
        <fieldset disabled={Boolean(active || busy)} className="space-y-2 rounded-xl border border-current/10 p-3"><legend className="px-1 text-xs">{tr('仅采集勾选的来源')}</legend>
          {[['video', tr('设备录屏')], ['logs', tr('设备日志（最多 100 MiB）')], ['performance', tr('性能快照（每 5 秒）')]].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-emerald-500" checked={selection[key]} onChange={event => setSelection(value => ({ ...value, [key]: event.target.checked }))} />{label}</label>)}
          {sources.serial.map(item => { const ref = { workspace: item.workspace, sessionId: item.sessionId }; return <label key={item.workspace} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-emerald-500" checked={selection.serial.some(value => value.workspace === item.workspace && value.sessionId === item.sessionId)} onChange={() => toggle('serial', ref)} />{item.label}</label>; })}
          {sources.ssh.map(item => { const ref = { sessionId: item.sessionId, terminalId: item.terminalId }; return <label key={`${item.sessionId}:${item.terminalId}`} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-emerald-500" checked={selection.ssh.some(value => value.sessionId === item.sessionId && value.terminalId === item.terminalId)} onChange={() => toggle('ssh', ref)} />{item.label}</label>; })}
        </fieldset>
        <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('串口和 SSH 只读取已打开的会话，不自动连接；每个来源最多保存 8 MiB，缓冲遗漏会明确标注。')}</p>
        <SelectMenu ariaLabel={tr('最长采集时间')} value={String(duration)} onChange={value => setDuration(Number(value))} disabled={Boolean(active || busy)} isDark={isDark} className="w-full" options={[{ value: '30000', label: tr('30 秒') }, { value: '60000', label: tr('1 分钟') }, { value: '180000', label: tr('3 分钟') }, { value: '300000', label: tr('5 分钟') }]} />
        <button type="button" disabled={Boolean(active || busy) || !selectedDevice || !title.trim() || !hasSelection} onClick={() => execute('start', () => window.electronAPI.reproductionStart({ deviceId: selectedDevice, title, durationMs: duration, selection }))} className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm disabled:opacity-40 ${theme.button.primary}`}><Play size={15} />{tr('开始复现采集')}</button>
        {active && <div className="space-y-2 rounded-xl border border-emerald-500/30 p-3"><p className="text-sm font-medium">{active.title} · {status[active.status]}</p><button type="button" className={button} disabled={Boolean(busy)} onClick={() => setViewId(active.id)}>{tr('查看当前采集')}</button><input aria-label={tr('问题标记说明')} value={note} onChange={event => setNote(event.target.value)} maxLength={240} placeholder={tr('问题标记说明（可选）')} className={input} /><div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy) || active.status !== 'recording'} className={button} onClick={() => execute('mark', () => window.electronAPI.reproductionMark({ id: active.id, note: note.trim() || tr('问题发生在这里') }))}><BookmarkPlus size={14} />{tr('标记问题')}</button><button type="button" disabled={Boolean(busy) || active.status === 'stopping'} className={button} onClick={() => execute('stop', () => window.electronAPI.reproductionStop({ id: active.id }))}><Square size={14} />{tr('结束并保存')}</button></div></div>}
        <div className="space-y-2 border-t border-current/10 pt-3"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">{tr('已保存的复现会话')}</h4><button type="button" className={button} disabled={Boolean(busy)} onClick={() => execute('refresh', async () => { await refresh(); return { ok: true }; })}><RefreshCw size={14} /></button></div>
          <div className="max-h-48 space-y-1 overflow-auto">{state.sessions.map(session => <button key={session.id} type="button" disabled={Boolean(busy)} onClick={() => setViewId(session.id)} className={`block w-full rounded-lg border p-2 text-left text-xs ${viewId === session.id ? 'border-emerald-500/40 bg-emerald-500/5' : theme.card}`}><span className="block truncate">{session.title}</span><span className={`mt-1 block ${theme.textMuted}`}>{status[session.status]} · {formatDateTime(session.startedAt)}</span></button>)}</div>
          {state.unreadable > 0 && <p className="text-xs text-amber-500">{tr('有 {0} 份记录无法读取，原文件已保留。', { 0: state.unreadable })}</p>}
        </div>
      </div>
      <div className="min-w-0 space-y-4">{current ? <><ReproductionPreview key={current.id} session={current} videoUrl={opened.videoUrl} theme={theme} />{!currentActive && <div className="flex flex-wrap gap-2">{current.unsaved && <button type="button" disabled={Boolean(busy)} className={button} onClick={() => execute('retrySave', () => window.electronAPI.reproductionRetrySave({ id: current.id }))}>{tr('重试保存会话状态')}</button>}<button type="button" disabled={Boolean(busy || current.unsaved)} onClick={() => execute('analyze', () => window.electronAPI.reproductionAnalyze({ id: current.id }))} className={button}><Sparkles size={15} />{tr('准备 AI 分析预览')}</button><button type="button" disabled={Boolean(busy || current.unsaved)} onClick={() => execute('export', () => window.electronAPI.reproductionExport({ id: current.id }))} className={button}><Download size={15} />{tr('导出复现证据包')}</button></div>}</> : <p className={`rounded-xl border border-dashed p-8 text-center text-sm leading-6 ${theme.textMuted}`}>{tr('勾选来源后开始复现，或选择一份已保存的会话查看证据。')}</p>}
        {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-500">{tr(error)}</p>}{notice && <p role="status" className="text-xs text-emerald-500">{tr(notice)}</p>}
      </div>
    </div>
    <footer className={`flex items-center gap-2 border-t border-current/10 p-4 text-xs ${theme.textMuted}`}>{busy && <Loader2 size={14} className="animate-spin" />}{active ? tr('关闭窗口不会停止采集，可从后台活动返回；退出应用前会询问保存。') : tr('视频和原始日志只保存在本机，发送给 AI 前仍需核对脱敏预览。')}</footer>
  </dialog>;
}
