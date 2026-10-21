import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export default function SelectMenu({ id, value, options, onChange, isDark, placeholder = '请选择', emptyText = '暂无可选项', compact = false, accent = 'emerald', disabled = false, className = '' }) {
  const listId = useId();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const typeaheadRef = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [activeValue, setActiveValue] = useState(null);
  const selected = options.find(option => option.value === value);
  const expanded = open && !disabled;
  const currentIndex = options.findIndex(option => option.value === activeValue && !option.disabled);
  const highlight = accent === 'cyan'
    ? (isDark ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400' : 'border-cyan-400 bg-cyan-50 text-cyan-700')
    : (isDark ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-emerald-400 bg-emerald-50 text-emerald-700');
  const selectedClass = accent === 'cyan'
    ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-700')
    : (isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-50 text-emerald-700');

  function openMenu() {
    if (disabled) return;
    const index = options.findIndex(option => option.value === value && !option.disabled);
    const initial = index >= 0 ? index : options.findIndex(option => !option.disabled);
    setActiveValue(options[initial]?.value ?? null);
    typeaheadRef.current = { text: '', at: 0 };
    setPosition(null);
    setOpen(true);
  }

  function selectOption(option) {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); }
      setOpen(false);
      return;
    }
    const continuingText = expanded && typeaheadRef.current.text && Date.now() - typeaheadRef.current.at < 700;
    if (event.key.length === 1 && (event.key !== ' ' || continuingText) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
      event.preventDefault();
      if (!expanded) openMenu();
      const now = Date.now();
      const key = event.key.toLocaleLowerCase();
      const previous = typeaheadRef.current;
      const text = now - previous.at < 700 && previous.text !== key ? previous.text + key : key;
      typeaheadRef.current = { text, at: now };
      const start = expanded ? currentIndex : options.findIndex(option => option.value === value);
      for (let offset = text.length > 1 ? 0 : 1; offset <= options.length; offset++) {
        const index = (Math.max(start, 0) + offset) % options.length;
        const option = options[index];
        if (option && !option.disabled && option.label.trim().toLocaleLowerCase().startsWith(text)) {
          setActiveValue(option.value);
          break;
        }
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    typeaheadRef.current = { text: '', at: 0 };
    if (!expanded) { openMenu(); return; }
    if (event.key === 'Enter' || event.key === ' ') { selectOption(options[currentIndex]); return; }
    const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
    let index = event.key === 'Home' ? -1 : event.key === 'End' || (currentIndex < 0 && direction < 0) ? options.length : currentIndex;
    for (index += direction; index >= 0 && index < options.length; index += direction) {
      if (!options[index].disabled) { setActiveValue(options[index].value); return; }
    }
  }

  useLayoutEffect(() => {
    if (!expanded) return undefined;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!rect || !menu) return;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) { setOpen(false); return; }
      const margin = 8;
      const gap = 6;
      const width = Math.max(0, Math.min(Math.max(rect.width, 180), window.innerWidth - margin * 2));
      menu.style.width = `${width}px`;
      const desired = Math.min(menu.scrollHeight, 280);
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const upwards = below < desired && above > below;
      const maxHeight = Math.max(0, Math.min(280, upwards ? above : below));
      const height = Math.min(menu.scrollHeight, maxHeight);
      const top = upwards ? rect.top - gap - height : rect.bottom + gap;
      setPosition({ left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)), top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)), width, maxHeight });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer = new ResizeObserver(updatePosition);
    observer.observe(triggerRef.current);
    observer.observe(menuRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer.disconnect();
    };
  }, [expanded, options.length]);

  useEffect(() => {
    if (!expanded) return undefined;
    const outside = event => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);

  useEffect(() => {
    const menu = menuRef.current;
    const option = menu?.querySelector(`[data-index="${currentIndex}"]`);
    if (!expanded || !menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [expanded, currentIndex, position?.maxHeight]);

  return (
    <div className={`min-w-0 ${className}`}>
      <button
        ref={triggerRef} id={id} type="button" value={String(value ?? '')} role="combobox"
        aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && currentIndex >= 0 ? `${listId}-${currentIndex}` : undefined}
        disabled={disabled} onKeyDown={onKeyDown} onClick={() => expanded ? setOpen(false) : openMenu()}
        onBlur={event => { if (!menuRef.current?.contains(event.relatedTarget)) setOpen(false); }}
        title={selected?.label || placeholder}
        className={`w-full min-w-0 flex items-center justify-between gap-2 rounded-lg border text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed ${compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'} ${expanded ? highlight : isDark ? 'border-[#5F6368] hover:border-[#9AA0A6] bg-[#3E4145] text-[#E8EAED]' : 'border-slate-200 hover:border-slate-400 bg-slate-50 text-slate-700'}`}
      >
        <span className="min-w-0 truncate">{selected?.label || placeholder}</span>
        <ChevronDown size={compact ? 12 : 14} className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && createPortal(
        <div ref={menuRef} id={listId} role="listbox" aria-labelledby={id}
          style={{ position: 'fixed', ...position, visibility: position ? 'visible' : 'hidden' }}
          className={`z-[240] overflow-y-auto overscroll-contain rounded-lg border py-1 shadow-2xl ${isDark ? 'bg-[#2D2F33] border-[#5F6368]' : 'bg-white border-slate-200'}`}
        >
          {!options.length && <p className={`px-3 py-3 text-xs leading-5 ${isDark ? 'text-[#BDC1C6]' : 'text-slate-500'}`}>{emptyText}</p>}
          {options.map((option, index) => (
            <button key={String(option.value)} id={`${listId}-${index}`} data-index={index} value={String(option.value)}
              type="button" role="option" tabIndex={-1} aria-selected={option.value === value} disabled={option.disabled}
              onMouseDown={event => event.preventDefault()} onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value); }}
              onClick={() => selectOption(option)} title={option.label}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${option.value === value ? selectedClass : index === currentIndex ? (isDark ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-800') : isDark ? 'hover:bg-[#3E4145] text-[#E8EAED]' : 'hover:bg-slate-50 text-slate-700'}`}
            >
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              {option.value === value && <Check size={13} className="shrink-0" />}
            </button>
          ))}
        </div>, triggerRef.current?.closest('dialog[open]') || document.body
      )}
    </div>
  );
}
