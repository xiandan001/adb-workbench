import { useState } from 'react';
import { History, Save, X } from 'lucide-react';

export default function LogSessionManager({ isDark, disabled, getSnapshot, onRestore, onMessage, entryCount, truncated }) {
  const [mode, setMode] = useState('');
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const panel = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-800';
  const button = `rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${panel}`;

  async function openHistory() {
    setMode('history');
    setError('');
    setSelected(null);
    setBusy(true);
    try {
      const result = await window.electronAPI.logSessionList();
      if (!result.ok) throw new Error(result.error);
      setSessions(result.sessions);
      if (result.errors?.length) setError(`${result.errors.length} 个会话文件无法读取，其余会话仍可打开`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.logSessionSave({ ...getSnapshot(), name });
      if (!result.ok) throw new Error(result.error);
      setMode('');
      onMessage(`已在本机保存会话“${result.session.name}”：${result.session.entryCount.toLocaleString()} 条已加载日志`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function restore() {
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.logSessionLoad({ id: selected.id });
      if (!result.ok) throw new Error(result.error);
      onRestore(result.session);
      setMode('');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className={`${button} flex items-center gap-1`} disabled={disabled || !entryCount} onClick={() => {
        setMode('save'); setName(`日志分析 ${new Date().toLocaleString('zh-CN')}`); setError('');
      }} title="保存已加载的原始日志、过滤条件和 AI 对话"><Save size={13} />保存会话</button>
      <button type="button" className={`${button} flex items-center gap-1`} disabled={disabled} onClick={openHistory}><History size={13} />历史会话</button>
      {mode && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-label={mode === 'save' ? '保存分析会话' : '恢复分析会话'} className={`w-full max-w-xl max-h-[80vh] overflow-y-auto rounded-xl border p-5 shadow-2xl ${panel}`}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{mode === 'save' ? '保存分析会话到本机' : '历史分析会话'}</h2>
              <button type="button" aria-label="关闭会话窗口" disabled={busy} onClick={() => setMode('')}><X size={18} /></button>
            </div>
            {mode === 'save' ? (
              <>
                <label className="block text-xs mb-1" htmlFor="log-session-name">会话名称</label>
                <input id="log-session-name" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} className={`w-full rounded-lg border p-2 ${panel}`} />
                <p className="mt-3 text-sm">保存当前已加载的 {entryCount.toLocaleString()} 条日志（不受过滤影响）、已捕获的 AI 证据和对话。数据仅保存在本机，不自动上传。</p>
                <p className="mt-2 text-xs opacity-80">每份上限：50,000 条已加载日志、100,000 条引用证据、500 轮对话、64 MB。超限会拒绝保存，不会截断。</p>
                {truncated && <p className="mt-2 text-xs text-amber-500">当前窗口的日志已受显示上限限制；更早、未加载的日志不包含在此次会话中。</p>}
                <button type="button" disabled={busy || !name.trim()} onClick={save} className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? '保存中…' : '确认保存'}</button>
              </>
            ) : (
              <>
                <p className="mb-3 text-xs opacity-80">恢复只替换当前视图，不抓日志、不调用 AI；历史 AI 对话为只读。</p>
                {busy ? <p className="text-sm">读取中…</p> : sessions.length === 0 ? <p className="text-sm">还没有保存的会话。</p> : (
                  <div className="space-y-2">
                    {sessions.map(item => <button key={item.id} type="button" onClick={() => setSelected(item)} className={`w-full rounded-lg border p-3 text-left ${selected?.id === item.id ? 'border-emerald-500 bg-emerald-500/10' : panel}`}>
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="mt-1 block text-xs opacity-75">{new Date(item.savedAt).toLocaleString('zh-CN')} · {item.entryCount.toLocaleString()} 条 · {item.deviceId || '文件日志'}</span>
                    </button>)}
                  </div>
                )}
                {selected && <div className="mt-4 rounded-lg border border-amber-500/40 p-3">
                  <p className="text-sm">恢复“{selected.name}”将替换当前未保存的日志和对话。需要保留当前内容时，请先关闭此窗口并保存。</p>
                  <button type="button" disabled={busy || disabled} onClick={restore} className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">替换视图并恢复</button>
                </div>}
              </>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
