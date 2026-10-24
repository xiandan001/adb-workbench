import { tr, useLocale } from '../../shared/i18n.js';
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export default function AiToolsDialog({ title, theme, busy = false, onClose, children, wide = false }) {
  useLocale();
  const ref = useRef(null); const id = useId();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className={`m-auto max-h-[calc(100vh-32px)] overflow-auto rounded-xl border p-5 shadow-xl backdrop:bg-black/50 ${wide ? 'w-[min(850px,calc(100vw-32px))]' : 'w-[min(620px,calc(100vw-32px))]'} ${theme.card} ${theme.text}`}>
    <div className="mb-4 flex items-center gap-3"><h3 id={id} className="min-w-0 flex-1 text-base font-semibold">{title}</h3><button type="button" aria-label={tr("关闭{0}", { 0: title })} disabled={busy} onClick={onClose} className="rounded p-1 disabled:opacity-40"><X size={18} /></button></div>{children}
  </dialog>;
}
