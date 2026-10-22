import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function SshFileContextMenu({ x, y, items, theme, onAction, onClose, label = 'SSH 文件操作' }) {
  const menu = useRef(null); const previousFocus = useRef(null);
  const [active, setActive] = useState(() => items.findIndex(item => !item.disabled));
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    previousFocus.current = document.activeElement;
    const place = () => {
      const rect = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [x, y, items.length]);
  useEffect(() => { menu.current?.querySelector(`[data-menu-index="${active}"]`)?.focus({ preventScroll: true }); }, [active, position]);
  useEffect(() => {
    const outside = event => { if (!menu.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);
  const choose = item => { if (!item || item.disabled) return; onClose(); onAction(item.id); };
  const keyboard = event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); onClose(); previousFocus.current?.focus?.(); return; }
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(items[active]); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const direction = ['ArrowUp', 'End'].includes(event.key) ? -1 : 1;
    let index = event.key === 'Home' ? -1 : event.key === 'End' ? items.length : active;
    for (let count = 0; count < items.length; count++) { index = (index + direction + items.length) % items.length; if (!items[index].disabled) { setActive(index); break; } }
  };
  return createPortal(<div ref={menu} role="menu" aria-label={label} onKeyDown={keyboard} onContextMenu={event => event.preventDefault()} style={{ position: 'fixed', left: x, top: y, ...position, visibility: position ? 'visible' : 'hidden', maxHeight: 'calc(100vh - 16px)' }} className={`z-[250] min-w-44 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border py-1 shadow-2xl ${theme.card} ${theme.text}`}>
    {items.map((item, index) => <button key={item.id} type="button" role="menuitem" data-menu-index={index} disabled={item.disabled} tabIndex={index === active ? 0 : -1} onMouseEnter={() => { if (!item.disabled) setActive(index); }} onClick={() => choose(item)} className={`block w-full px-3 py-1.5 text-left text-xs disabled:opacity-35 ${item.danger ? 'text-red-500' : ''} ${index === active ? 'bg-emerald-500/15' : 'hover:bg-slate-400/10'} ${item.separator ? 'mt-1 border-t border-slate-400/20 pt-2' : ''}`}>{item.label}</button>)}
  </div>, document.body);
}
