import { useEffect, useRef, useState } from 'react';
import { Loader2, Save, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';

export default function LogClosePrompt({ request, onSave, onResolve, isDark, approved = false }) {
  useLocale(); const dialog = useRef(null), lock = useRef(false), alive = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const element = dialog.current, previous = document.activeElement; alive.current = true; element.showModal();
    return () => { alive.current = false; element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  async function choose(action) {
    if (lock.current || approved) return; lock.current = true; setBusy(true); setError('');
    try { if (action === 'saved') await onSave(request); if (alive.current) await onResolve(request, action); }
    catch (failure) { if (alive.current) setError(failure.message || tr('日志保存失败，当前窗口和内容已保留。')); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} aria-label={tr('关闭日志窗口前保存')} onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); if (!lock.current) void choose('cancel'); }}
    className={`m-auto max-h-[85vh] w-[min(35rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border p-5 shadow-2xl backdrop:bg-black/55 ${isDark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800'}`}>
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{tr('关闭日志窗口前保存')}</h2><button type="button" disabled={busy || approved} onClick={() => choose('cancel')} aria-label={tr('取消关闭')} className="rounded p-1 disabled:opacity-40"><X size={18} /></button></div>
    <p className="mt-4 text-sm leading-6">{tr('当前日志、标记或分析尚未保存，或采集仍在进行。是否先保存当前快照？')}</p>
    <p className="mt-2 text-xs leading-6 opacity-70">{tr('保存并关闭会停止本次采集和分析。仅保存当前加载窗口；暂停查看时只保存冻结窗口，不包含之后新增的日志。已写入的原始归档不会删除。')}</p>
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{tr(error)}</p>}
    {approved && <p role="status" className="mt-3 flex items-center gap-2 text-xs"><Loader2 size={14} className="animate-spin" />{tr('日志关闭操作已确认，正在等待应用完成退出。')}</p>}
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <button type="button" autoFocus disabled={busy || approved} onClick={() => choose('cancel')} className="rounded-lg border border-slate-400/30 px-4 py-2 text-xs disabled:opacity-40">{tr('取消关闭')}</button>
      <button type="button" disabled={busy || approved} onClick={() => choose('discard')} className="rounded-lg border border-red-500/30 px-4 py-2 text-xs text-red-500 disabled:opacity-40">{tr('不保存并关闭')}</button>
      <button type="button" disabled={busy || approved} onClick={() => choose('saved')} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs text-white disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{tr('保存并关闭')}</button>
    </div>
  </dialog>;
}
