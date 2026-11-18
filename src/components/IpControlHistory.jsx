import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, History, Trash2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { confirmAppMessage, trapAppMessageFocus } from '../shared/appMessageDialog.js';

export default function IpControlHistory({ theme, locked, revision, onConnect, modeName, displayAddress }) {
  const locale = useLocale(), listId = useId(), [open, setOpen] = useState(false), [entries, setEntries] = useState([]);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [nonce, setNonce] = useState(0);
  const epoch = useRef(null), pending = useRef(false), sequence = useRef(0), toggle = useRef(null), dialog = useRef(null), opened = useRef(null);
  useEffect(() => { epoch.current = {}; return () => { epoch.current = null; }; }, []);
  useEffect(() => {
    if (!open) return;
    const node = dialog.current, trigger = toggle.current;
    node?.showModal();
    return () => { node?.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (pending.current) return;
    const id = ++sequence.current; let stopped = false;
    async function read() {
      try {
        const result = await window.electronAPI.ipControlHistory();
        if (stopped || sequence.current !== id) return;
        if (!result?.ok || !Array.isArray(result.entries)) { setNotice('read'); return; }
        setEntries(result.entries); setNotice(result.error ? 'save' : '');
      } catch { if (!stopped && sequence.current === id) setNotice('read'); }
    }
    void read(); return () => { stopped = true; };
  }, [revision, nonce]);

  async function remove(entry) {
    if (pending.current || !open || opened.current !== open || !epoch.current) return;
    pending.current = true; setBusy(true); sequence.current++;
    const token = epoch.current;
    try {
      if (!entry && !await confirmAppMessage({ type: 'warning', title: tr('清除连接历史'),
        message: tr('只清除 IP Control 的成功记录，不影响已保存的输入和当前会话。'), confirmLabel: tr('清空') })) {
        if (epoch.current === token) setNonce(value => value + 1);
        return;
      }
      if (epoch.current !== token) return;
      const result = entry ? await window.electronAPI.ipControlRemoveHistory({ id: entry.id }) : await window.electronAPI.ipControlClearHistory();
      if (epoch.current !== token) return;
      if (!result?.ok || !Array.isArray(result.entries)) { setNotice('change'); return; }
      setEntries(result.entries); setNotice(result.error ? 'save' : ''); setNonce(value => value + 1);
    } catch { if (epoch.current === token) setNotice('change'); }
    finally { if (epoch.current === token) { pending.current = false; setBusy(false); } }
  }
  function close() {
    if (pending.current || opened.current !== open) return;
    opened.current = null; setOpen(false);
  }
  function choose(entry) {
    if (!epoch.current || !open || opened.current !== open || locked || busy || pending.current) return;
    if (onConnect(entry)) close();
  }
  const retry = notice && <p role="status" className="mt-2 flex flex-wrap items-baseline gap-2 text-xs text-amber-600">{notice === 'read' ? tr('无法读取连接历史，请重试。') : notice === 'save' ? tr('连接历史未能保存，本次网络会话不受影响。') : tr('未能更新连接历史，原记录已保留。')}
    <button type="button" disabled={busy} className="underline" onClick={() => setNonce(value => value + 1)}>{tr('重试')}</button></p>;
  return <div className="mt-3 border-t border-slate-400/15 pt-2">
    <button ref={toggle} type="button" aria-label={tr('连接历史')} aria-haspopup="dialog" aria-expanded={Boolean(open)} aria-controls={open ? listId : undefined}
      onClick={() => { if (opened.current) return; const token = {}; opened.current = token; setOpen(token); setNonce(value => value + 1); }}
      className={`inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${theme.button.secondary}`}><History size={14}/>{tr('连接历史')}<span className="rounded-full bg-slate-400/15 px-1.5 tabular-nums">{entries.length}</span></button>
    {!open && retry}
    {open && <dialog id={listId} ref={dialog} aria-label={tr('IP Control 连接历史')} onKeyDown={trapAppMessageFocus} onCancel={e=>{ e.preventDefault(); close(); }}
      className={`m-auto max-h-[85vh] w-[min(38rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl open:flex backdrop:bg-black/55 ${theme.card} ${theme.text}`}>
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-400/20 p-4">
        <History size={20} className="shrink-0 text-emerald-500"/><h3 className="min-w-0 flex-1 break-words font-semibold">{tr('IP Control 连接历史')}</h3>
        {entries.length > 0 && <button type="button" disabled={busy} aria-label={tr('清除连接历史')} onClick={() => void remove(null)} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs disabled:opacity-50 ${theme.textMuted}`}><Trash2 size={13}/>{tr('清空')}</button>}
        <button type="button" autoFocus disabled={busy} aria-label={tr('关闭')} onClick={close} className={`rounded-lg p-2 ${theme.button.secondary}`}><X size={16}/></button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4">{retry}
        <p className={`text-xs leading-5 ${theme.textMuted}`}>{locked ? tr('当前会话使用中，请先停止再切换模式。') : tr('选择记录将按该类型连接或启动监听，不会发送数据。')}</p>
        {entries.length > 0 ? <ul aria-label={tr('成功连接记录')} className="space-y-1.5">
          {entries.map(entry => {
            const name = modeName(entry.mode), address = displayAddress(entry.host, entry.port);
            return <li key={entry.id} data-ip-history-id={entry.id} className="flex min-w-0 items-center gap-1 rounded-lg border border-slate-400/15">
              <button type="button" disabled={locked || busy} onClick={() => choose(entry)} aria-label={tr('使用 {0}：{1}', { 0: name, 1: address })}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left text-xs enabled:hover:bg-emerald-500/10 disabled:opacity-65"><span className={`font-semibold ${theme.textMuted}`}>{name}</span><code className="break-all">{address}</code>
                {entry.mode === 'udp' && entry.localPort > 0 && <span className={theme.textMuted}>{tr('本地端口')} {entry.localPort}</span>}
                <time className={`tabular-nums ${theme.textMuted}`}>{new Date(entry.lastSuccessAt).toLocaleString(locale)}</time><span className="ml-auto inline-flex items-center gap-1 text-emerald-600">{entry.mode === 'tcp-server' ? tr('开始监听') : entry.mode === 'udp' ? tr('启用 UDP') : tr('连接')}<ArrowRight size={13}/></span></button>
              <button type="button" disabled={busy} onClick={() => void remove(entry)} aria-label={tr('移除 {0}：{1}', { 0: name, 1: address })} className={`shrink-0 rounded-lg p-2 hover:text-red-500 disabled:opacity-50 ${theme.textMuted}`}><X size={14}/></button>
            </li>;
          })}
        </ul> : !notice && <p className={`py-3 text-xs ${theme.textMuted}`}>{tr('暂无成功连接记录')}</p>}
      </div></dialog>}
  </div>;
}
