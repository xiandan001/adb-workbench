import { useMemo, useRef, useEffect, useState } from 'react';
import { History, Save, Search, Pencil, Trash2, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { filterLogSessions } from '../shared/logMarkers';

export default function LogSessionManager({ isDark, disabled, getSnapshot, onRestore, onMessage, entryCount, truncated, markerCount = 0 }) {
  const [mode, setMode] = useState('');
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [action, setAction] = useState('');
  const dialogRef = useRef(null);
  const visibleSessions = useMemo(() => filterLogSessions(sessions, query, period), [sessions, query, period]);
  const panel = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-800';
  const button = `rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${panel}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (mode && !dialog?.open) dialog?.showModal();
    if (!mode && dialog?.open) dialog.close();
  }, [mode]);

  async function openHistory() {
    setMode('history'); setError(''); setSelected(null); setAction(''); setBusy(true);
    try {
      const result = await window.electronAPI.logSessionList();
      if (!result.ok) throw new Error(result.error);
      setSessions(result.sessions);
      if (result.errors?.length) setError(`${result.errors.length} 个会话文件无法读取，其余会话仍可打开`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.logSessionSave({ ...getSnapshot(), name });
      if (!result.ok) throw new Error(result.error);
      setMode('');
      onMessage(`已在本机保存会话“${result.session.name}”：${result.session.entryCount.toLocaleString()} 条已加载日志`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function runAction(type) {
    setBusy(true); setError('');
    try {
      if (type === 'restore') {
        const result = await window.electronAPI.logSessionLoad({ id: selected.id });
        if (!result.ok) throw new Error(result.error);
        onRestore(result.session); setMode('');
      } else if (type === 'rename') {
        const result = await window.electronAPI.logSessionRename({ id: selected.id, name });
        if (!result.ok) throw new Error(result.error);
        setSessions(previous => previous.map(item => item.id === result.session.id ? result.session : item));
        setSelected(result.session); setAction('');
        onMessage('会话已重命名，原始日志与标记保持不变');
      } else {
        const result = await window.electronAPI.logSessionDelete({ id: selected.id, confirmed: true });
        if (!result.ok) throw new Error(result.error);
        setSessions(previous => previous.filter(item => item.id !== selected.id));
        setSelected(null); setAction('');
        onMessage('会话已移至系统回收站，可从回收站恢复');
      }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className={`${button} flex items-center gap-1`} disabled={disabled || (!entryCount && !markerCount)} onClick={() => {
        setMode('save'); setName(`日志分析 ${new Date().toLocaleString('zh-CN')}`); setError('');
      }} title="保存已加载的原始日志、问题标记、过滤条件和 AI 对话"><Save size={13} />保存会话</button>
      <button type="button" className={`${button} flex items-center gap-1`} disabled={disabled} onClick={openHistory}><History size={13} />历史会话</button>
      <dialog ref={dialogRef} onCancel={event => { if (busy) event.preventDefault(); else setMode(''); }} onClose={() => setMode('')}
        aria-label={mode === 'save' ? '保存分析会话' : '恢复分析会话'} className={`m-auto w-[min(42rem,94vw)] max-h-[85vh] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{mode === 'save' ? '保存分析会话到本机' : '历史分析会话'}</h2>
          <button type="button" aria-label="关闭会话窗口" disabled={busy} onClick={() => setMode('')}><X size={18} /></button>
        </div>
        {mode === 'save' ? (
          <>
            <label className="block text-xs mb-1" htmlFor="log-session-name">会话名称</label>
            <input id="log-session-name" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} className={`w-full rounded-lg border p-2 ${panel}`} />
            <p className="mt-3 text-sm">保存当前已加载的 {entryCount.toLocaleString()} 条日志（不受过滤影响）、{markerCount} 个问题标记、已捕获的 AI 证据和对话。数据仅保存在本机，不自动上传。</p>
            <p className="mt-2 text-xs opacity-80">每份上限：50,000 条已加载日志、100,000 条引用证据、500 个标记、500 轮对话、64 MB。超限会拒绝保存，不会截断。</p>
            {truncated && <p className="mt-2 text-xs text-amber-500">当前窗口的日志已受显示上限限制；更早、未加载的日志不包含在此次会话中。问题标记保留添加时的原文与上下文。</p>}
            <button type="button" disabled={busy || !name.trim()} onClick={save} className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? '保存中…' : '确认保存'}</button>
          </>
        ) : (
          <>
            <p className="mb-3 text-xs opacity-80">恢复只替换当前视图，不抓日志、不调用 AI；历史 AI 对话为只读。</p>
            <div className="mb-3 flex flex-wrap gap-2">
              <label className={`flex min-w-48 flex-1 items-center gap-2 rounded-lg border px-2 ${panel}`}><Search size={14} /><input aria-label="搜索会话名称或设备" placeholder="搜索名称或设备" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 w-full bg-transparent py-2 text-sm outline-none" /></label>
              <SelectMenu id="session-date-filter" value={period} onChange={setPeriod} isDark={isDark} className="w-32" options={[{ value: 'all', label: '全部日期' }, { value: 'today', label: '今天' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
            </div>
            {busy && <p className="my-2 text-xs" role="status">处理中…</p>}
            {!busy && !visibleSessions.length && <p className="py-5 text-center text-sm opacity-70">{sessions.length ? '没有符合条件的会话，试试其他关键词或日期。' : '还没有保存的会话。'}</p>}
            <div className="max-h-[40vh] overflow-y-auto space-y-2">
              {visibleSessions.map(item => <button key={item.id} type="button" disabled={busy} onClick={() => { setSelected(item); setAction(''); setError(''); }} className={`w-full rounded-lg border p-3 text-left ${selected?.id === item.id ? 'border-emerald-500 bg-emerald-500/10' : panel}`}>
                <span className="block truncate text-sm font-medium">{item.name}</span>
                <span className="mt-1 block text-xs opacity-75">{new Date(item.savedAt).toLocaleString('zh-CN')} · {item.entryCount.toLocaleString()} 条 · {item.deviceId || '文件日志'}{item.markerCount > 0 ? ` · ${item.markerCount} 个标记` : ''}</span>
              </button>)}
            </div>
            {selected && <div className="mt-4 rounded-lg border border-emerald-500/30 p-3">
              <p className="truncate text-sm font-medium">已选择：{selected.name}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy || disabled} onClick={() => setAction('restore')} className={button}>恢复会话</button>
                <button type="button" disabled={busy} onClick={() => { setAction('rename'); setName(selected.name); }} className={`${button} flex items-center gap-1`}><Pencil size={12} />重命名</button>
                <button type="button" disabled={busy} onClick={() => setAction('delete')} className={`${button} flex items-center gap-1 text-red-500`}><Trash2 size={12} />移至回收站</button>
              </div>
              {action === 'rename' && <label className="mt-3 block text-xs">新名称<input aria-label="会话新名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} className={`mt-1 block w-full rounded-lg border p-2 ${panel}`} /></label>}
              {action === 'restore' && <p className="mt-3 text-xs text-amber-500">将替换当前未保存的日志、标记和对话。需要保留当前内容时，请先关闭此窗口并保存。</p>}
              {action === 'delete' && <p className="mt-3 text-xs text-amber-500">确认将“{selected.name}”移至系统回收站？当前已打开的视图不受影响，可从回收站恢复文件。</p>}
              {action && <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy || (action === 'restore' && disabled) || (action === 'rename' && !name.trim())} onClick={() => runAction(action)} className={`rounded-lg px-3 py-2 text-xs text-white disabled:opacity-40 ${action === 'delete' ? 'bg-red-600' : 'bg-emerald-600'}`}>{action === 'restore' ? '替换视图并恢复' : action === 'rename' ? '保存名称' : '确认移至回收站'}</button>
                <button type="button" disabled={busy} onClick={() => setAction('')} className={button}>取消</button>
              </div>}
            </div>}
          </>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
      </dialog>
    </>
  );
}
