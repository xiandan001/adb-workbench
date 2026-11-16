import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, Settings2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';
import { recentWorksets, restoreFreshWorkset } from '../shared/worksetQuickRestore.js';

export default function WorkbenchRecentWorksets({ theme, onRestore, onManage, onClose, triggerRef }) {
  useLocale();
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const dialog = useRef(null), alive = useRef(false), loadTicket = useRef(0), restoreLock = useRef(false);
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`;
  async function load() {
    const ticket = ++loadTicket.current;
    setLoading(true); setError('');
    try {
      const result = await window.electronAPI?.worksetList?.();
      if (!alive.current || ticket !== loadTicket.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('工作集读取失败，请重试。'));
      setItems(recentWorksets(result.items));
    } catch (failure) { if (alive.current && ticket === loadTicket.current) setError(failure.message); }
    finally { if (alive.current && ticket === loadTicket.current) setLoading(false); }
  }
  async function restore(item) {
    if (restoreLock.current || loading) return;
    restoreLock.current = true; setBusy(item.id); setError('');
    try {
      const result = await restoreFreshWorkset(item.id, { list: () => window.electronAPI?.worksetList?.(), onRestore, isCurrent: () => alive.current });
      if (alive.current && result.restored) onClose();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { restoreLock.current = false; if (alive.current) setBusy(''); }
  }
  useEffect(() => {
    alive.current = true;
    const element = dialog.current, previous = triggerRef.current || document.activeElement;
    element.showModal(); void load();
    return () => { alive.current = false; element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
    // The modal freezes the restore target until this chooser closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <dialog ref={dialog} onKeyDown={trapAppMessageFocus} aria-label={tr('最近工作集')}
    onCancel={event => { event.preventDefault(); if (!restoreLock.current) onClose(); }}
    className={`m-auto max-h-[85vh] w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <header className="flex items-center justify-between gap-3 border-b border-current/10 p-4"><div><h3 className="font-semibold">{tr('最近工作集')}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('恢复配置不会连接设备、执行命令、开始采集或调用 AI。')}</p></div><button type="button" autoFocus disabled={Boolean(busy)} onClick={() => { if (!restoreLock.current) onClose(); }} aria-label={tr('关闭')} className="rounded-lg p-2 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button></header>
    <div className="max-h-[55vh] space-y-2 overflow-y-auto p-4">
      {loading && <p role="status" className={`flex items-center gap-2 text-sm ${theme.textMuted}`}><Loader2 size={15} className="animate-spin" />{tr('正在读取工作集…')}</p>}
      {!loading && !items.length && !error && <p className={`py-4 text-sm ${theme.textMuted}`}>{tr('尚未保存工作集，进入管理后保存当前配置。')}</p>}
      {items.map(item => <button key={item.id} type="button" disabled={Boolean(busy) || loading} onClick={() => restore(item)} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left disabled:opacity-40 ${theme.input}`}>
        {busy === item.id ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <FolderOpen size={18} className="shrink-0 text-emerald-500" />}<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium" title={item.name}>{item.name}</span><span className={`mt-1 block break-all text-xs leading-5 ${theme.textMuted}`}>{item.deviceId || tr('未指定设备')}{item.packageName ? ` · ${item.packageName}` : ''}</span></span><span className="shrink-0 text-xs text-emerald-500">{tr('恢复配置')}</span>
      </button>)}
      {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-current/10 p-4"><button type="button" disabled={Boolean(busy)} onClick={() => { if (!restoreLock.current) onManage(); }} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Settings2 size={15} />{tr('管理工作集')}</button><button type="button" disabled={Boolean(busy) || loading} onClick={load} className={button}><RefreshCw size={14} />{error ? tr('重试') : tr('刷新')}</button></footer>
  </dialog>;
}
