import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CircleHelp, Info, Loader2, ShieldAlert, X } from 'lucide-react';
import { normalizeAppMessageOptions, resolveAppMessage, subscribeAppMessages, trapAppMessageFocus } from '../shared/appMessageDialog';

function MessageDialog({ item, theme, isDark, onReply }) {
  useLocale();
  const id = useId(); const ref = useRef(null); const defaultButton = useRef(null); const busyRef = useRef(false);
  const [busy, setBusy] = useState(false); const [checked, setChecked] = useState(item.options.checkboxChecked); const options = item.options;
  useEffect(() => {
    const previous = document.activeElement; const node = ref.current;
    node.showModal(); defaultButton.current?.focus({ preventScroll: true });
    return () => { node.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const answer = async response => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true);
    try { await onReply(item, { response, checkboxChecked: checked }); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const Icon = options.type === 'warning' ? ShieldAlert : options.type === 'error' ? AlertCircle : options.type === 'info' ? Info : CircleHelp;
  const tone = options.type === 'error' ? 'text-red-500 bg-red-500/10' : options.type === 'warning' ? 'text-amber-500 bg-amber-500/10' : 'text-emerald-500 bg-emerald-500/10';
  const primary = options.defaultId !== options.cancelId ? options.defaultId : options.buttons.findIndex((_label, index) => index !== options.cancelId);
  return <dialog ref={ref} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); void answer(options.cancelId); }} className={`m-auto max-h-[calc(100vh-32px)] w-[min(600px,calc(100vw-32px))] overflow-hidden rounded-2xl border p-0 shadow-2xl backdrop:bg-black/55 open:flex open:flex-col ${isDark ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}>
    <div className="flex shrink-0 items-start gap-3 border-b border-slate-400/15 px-5 py-4"><span className={`mt-0.5 rounded-xl p-2.5 ${tone}`}><Icon size={22} /></span><div className="min-w-0 flex-1 pt-1"><h2 id={`${id}-title`} className="text-base font-semibold">{options.title}</h2><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{tr("请确认以下操作")}</p></div><button type="button" aria-label={tr("关闭{0}", { 0: options.title })} disabled={busy} onClick={() => answer(options.cancelId)} className={`rounded-lg p-1.5 disabled:opacity-40 ${theme.button.secondary}`}><X size={18} /></button></div>
    <div id={`${id}-body`} className="min-h-0 flex-1 select-text overflow-y-auto overscroll-contain px-5 py-4"><p className="whitespace-pre-wrap break-words text-sm font-medium leading-6">{options.message}</p>{options.detail && <div className={`mt-3 whitespace-pre-wrap break-words rounded-xl border p-3 text-xs leading-6 ${isDark ? 'border-slate-400/15 bg-black/15' : 'border-slate-200 bg-slate-50'} ${theme.textMuted}`}>{options.detail}</div>}{options.checkboxLabel && <label className="mt-4 flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} className="mt-1 accent-emerald-500" />{options.checkboxLabel}</label>}</div>
    <div className={`flex max-h-[45vh] shrink-0 flex-wrap justify-end gap-2 overflow-y-auto border-t border-slate-400/15 px-5 py-4 ${isDark ? 'bg-black/10' : 'bg-slate-50/70'}`}>{options.buttons.map((label, index) => <button key={index} ref={index === options.defaultId ? defaultButton : undefined} type="button" disabled={busy} onClick={() => answer(index)} className={`inline-flex max-w-full items-center justify-center gap-1.5 whitespace-normal break-words rounded-lg px-4 py-2.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:opacity-50 ${index === primary ? theme.button.primary : theme.button.secondary}`}>{busy && index === options.defaultId && <Loader2 size={13} className="animate-spin" />}{label}</button>)}</div>
  </dialog>;
}

export default function AppMessageDialogHost({ theme, isDark }) {
  useLocale();
  const [items, setItems] = useState([]);
  useEffect(() => {
    const receive = source => message => {
      if (!message || typeof message.requestId !== 'string') return;
      if (message.type === 'cancel') { setItems(previous => previous.filter(item => item.source !== source || item.requestId !== message.requestId)); return; }
      if (message.type !== 'show') return;
      try {
        const options = normalizeAppMessageOptions(message.options);
        setItems(previous => previous.some(item => item.source === source && item.requestId === message.requestId) ? previous : [...previous, { source, requestId: message.requestId, options }]);
      } catch { /* Malformed prompts cannot authorize any action; main requests expire cancelled. */ }
    };
    const unsubscribeLocal = subscribeAppMessages(receive('local')); const api = window.electronAPI;
    const unsubscribeMain = api?.onAppMessageDialog?.(receive('main'));
    void api?.appMessageDialogReady?.().catch(() => {});
    return () => { unsubscribeLocal(); unsubscribeMain?.(); void api?.appMessageDialogUnready?.().catch(() => {}); };
  }, []);
  const reply = async (item, result) => {
    if (item.source === 'main') {
      try { await window.electronAPI?.appMessageDialogReply({ requestId: item.requestId, ...result }); }
      catch { await window.electronAPI?.appMessageDialogUnready?.().catch(() => {}); await window.electronAPI?.appMessageDialogReady?.().catch(() => {}); }
    } else resolveAppMessage(item.requestId, result);
    setItems(previous => previous.filter(row => row !== item));
  };
  return items.length ? <MessageDialog key={`${items[0].source}:${items[0].requestId}`} item={items[0]} theme={theme} isDark={isDark} onReply={reply} /> : null;
}
