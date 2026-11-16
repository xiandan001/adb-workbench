import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { nextEnabledActionIndex } from '../shared/resultActions.js';

export default function ResultActionsMenu({ actions, isDark = false, disabled = false, label = tr('更多操作') }) {
  useLocale();
  const id = useId(), trigger = useRef(null), menu = useRef(null);
  const [open, setOpen] = useState(false), [position, setPosition] = useState(null), [error, setError] = useState(''), [portalHost, setPortalHost] = useState(null);
  const unavailable = disabled || !actions.some(action => !action.disabled);
  if (open && unavailable) setOpen(false);
  const close = restore => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = () => { if (!unavailable && !open) { setError(''); setPosition(null); setPortalHost(trigger.current?.closest('dialog[open]') || document.body); setOpen(true); } };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current, popup = menu.current; if (!button || !popup) return;
      const box = button.getBoundingClientRect(), margin = 8, gap = 5;
      if (box.bottom <= 0 || box.top >= window.innerHeight) { setOpen(false); return; }
      const width = Math.min(260, window.innerWidth - margin * 2); popup.style.width = `${width}px`;
      const wanted = Math.min(popup.scrollHeight, 320), below = window.innerHeight - box.bottom - gap - margin, above = box.top - gap - margin;
      const upwards = below < wanted && above > below, maxHeight = Math.max(0, Math.min(320, upwards ? above : below));
      const height = Math.min(popup.scrollHeight, maxHeight);
      setPosition({ width, maxHeight, left: Math.max(margin, Math.min(box.right - width, window.innerWidth - width - margin)),
        top: Math.max(margin, upwards ? box.top - gap - height : box.bottom + gap) });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(trigger.current); observer.observe(menu.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const focusFrame = requestAnimationFrame(() => menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(focusFrame); observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onMenuKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const host = trigger.current?.closest('dialog[open]') || document;
      const controls = [...host.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
        .filter(node => node.getClientRects().length && !menu.current?.contains(node));
      const at = controls.indexOf(trigger.current), next = controls[at + (event.shiftKey ? -1 : 1)] || trigger.current;
      close(false); next?.focus({ preventScroll: true }); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const current = Number(document.activeElement?.dataset.actionIndex ?? -1);
    const next = nextEnabledActionIndex(actions, current, event.key);
    menu.current?.querySelector(`[data-action-index="${next}"]`)?.focus({ preventScroll: true });
  };
  const select = action => {
    close(true);
    Promise.resolve().then(() => action.onSelect()).catch(() => setError(tr('操作未完成，请重试。')));
  };
  if (!actions.length) return null;
  return <div className="min-w-0">
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={unavailable} onClick={() => open ? close(true) : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (open) menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); else show(); } }}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
      <MoreHorizontal size={15} /><span>{label}</span>
    </button>
    {error && <p role="alert" className="mt-1 max-w-60 text-xs text-red-500">{error}</p>}
    {open && portalHost && createPortal(<div id={id} ref={menu} role="menu" aria-label={label} onKeyDown={onMenuKey}
      onBlur={event => { if (!menu.current?.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(false); }}
      style={{ position: 'fixed', ...position, visibility: position ? 'visible' : 'hidden' }}
      className={`z-[240] overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-2xl ${isDark ? 'border-[#5F6368] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
      {actions.map((action, index) => <button key={action.id} type="button" role="menuitem" data-action-index={index} tabIndex={-1} disabled={action.disabled}
        onClick={() => select(action)} className={`flex min-h-9 w-full items-center rounded-lg px-3 py-2 text-left text-xs leading-5 outline-none disabled:opacity-40 ${action.danger ? 'text-red-500 hover:bg-red-500/10 focus:bg-red-500/10' : isDark ? 'text-[#E8EAED] hover:bg-[#3E4145] focus:bg-[#3E4145]' : 'text-slate-700 hover:bg-slate-100 focus:bg-slate-100'}`}>{action.label}</button>)}
    </div>, portalHost)}
  </div>;
}
