import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Layers } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogBufferPicker({ options, selected, onChange, disabled, isDark }) {
  useLocale();
  const trigger = useRef(null), popup = useRef(null); const [placement, setPlacement] = useState(null), [portalHost, setPortalHost] = useState(null);
  const open = Boolean(placement) && !disabled;
  const close = focus => { setPlacement(null); if (focus) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) setPlacement(null); };
    const resize = () => setPlacement(null);
    const frame = requestAnimationFrame(() => popup.current?.querySelector('input')?.focus({ preventScroll: true }));
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open]);
  const toggle = () => {
    if (disabled) return; if (open) { close(false); return; }
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(320, window.innerWidth - 24), below = window.innerHeight - rect.bottom - 20, above = rect.top - 20;
    const height = Math.min(360, Math.max(above, below));
    setPortalHost(trigger.current.closest('dialog[open]') || document.body);
    setPlacement({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below >= Math.min(height, 180) ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), width, maxHeight: height });
  };
  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}
      className={`inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${isDark ? 'border-slate-600 bg-[#202124] text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}><Layers size={14} />{tr('日志类型')}<span className="rounded bg-emerald-500/15 px-1.5 text-emerald-500">{selected.length}</span><ChevronDown size={12} /></button>
    {open && portalHost && createPortal(<div ref={popup} role="dialog" aria-label={tr('选择日志类型（可多选）')} style={{ position: 'fixed', ...placement }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}
      onBlur={event => { if (event.relatedTarget && !popup.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) close(false); }}
      className={`z-[245] overflow-y-auto rounded-xl border p-2 shadow-2xl ${isDark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800'}`}>
      {options.map(option => <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-xs hover:bg-emerald-500/10"><input type="checkbox" checked={selected.includes(option.id)} onChange={() => onChange(option.id)} className="mt-0.5 accent-emerald-500" /><span className="min-w-0 flex-1"><span className="block font-medium">{option.label}</span><span className="mt-0.5 block break-words opacity-60">{option.desc}</span></span></label>)}
    </div>, portalHost)}
  </>;
}
