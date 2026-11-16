import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, RefreshCw, Search } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { applicationDeviceKey, applicationPopupPosition, filterApplications, readApplicationRecents, readApplications, rememberApplication, validApplicationPackage } from '../shared/applicationPicker.js';

const initial = key => ({ key, open: false, query: '', items: [], loading: false, error: '', active: 0, manual: false, manualValue: '' });
export default function ApplicationPicker({ device, value = '', onChange, theme, disabled = false, label, placeholder }) {
  useLocale();
  const key = applicationDeviceKey(device), id = useId(), trigger = useRef(null), popup = useRef(null), search = useRef(null);
  const alive = useRef(true), request = useRef(0);
  const [stored, setStored] = useState(() => { try { return { ...readApplicationRecents(), error: '' }; } catch (error) { return { items: [], error: error.message }; } });
  const [state, setState] = useState(() => initial(key));
  const [position, setPosition] = useState(null);
  const [portalHost, setPortalHost] = useState(null);
  const current = state.key === key ? state : initial(key), dark = isDarkTheme(theme);
  const open = current.open && !disabled && Boolean(key);
  const placed = Boolean(position);
  const recent = stored.items.find(item => item.deviceId === device?.id)?.packages || [];
  const items = current.items.length ? current.items : recent.map(packageName => ({ packageName, label: packageName }));
  const filtered = filterApplications(items, current.query, recent).slice(0, 100);
  const title = label || tr('当前应用');
  const muted = theme.textMuted || 'text-slate-500';
  const change = changes => setState(previous => ({ ...(previous.key === key ? previous : initial(key)), ...changes }));
  const close = focus => { change({ open: false }); if (focus) trigger.current?.focus(); };
  async function load(refresh = false) {
    if (device?.status !== 'device') { change({ error: tr('请先选择在线设备，或手动填写应用包名。') }); return; }
    const ticket = ++request.current;
    change({ loading: true, error: '' });
    try {
      const rows = await readApplications(window.electronAPI, device, { refresh });
      if (alive.current && ticket === request.current) setState(previous => previous.key === key ? { ...previous, items: rows, loading: false } : previous);
    } catch {
      if (alive.current && ticket === request.current) setState(previous => previous.key === key ? { ...previous, loading: false, error: tr('读取应用列表失败，请重试或手动输入。') } : previous);
    }
  }
  const show = () => {
    if (disabled || !key) return;
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    setPortalHost(trigger.current.closest('dialog[open]') || document.body);
    setPosition(applicationPopupPosition(rect, window.innerWidth, window.innerHeight));
    change({ open: true, query: '', active: 0, manual: false, manualValue: value }); void load();
  };
  const select = packageName => {
    if (disabled || !validApplicationPackage(packageName)) return;
    try { setStored({ ...rememberApplication(device.id, packageName), error: '' }); }
    catch { setStored(previous => ({ ...previous, error: tr('最近应用未能保存，本次选择仍有效。') })); }
    onChange(packageName); close(true);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) setState(previous => ({ ...previous, open: false })); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (!open || !placed) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === trigger.current || document.activeElement === document.body) search.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, placed]);
  useEffect(() => {
    if (open) popup.current?.querySelector(`[id="${id}-option-${current.active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, current.active, id]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      setPosition(applicationPopupPosition(rect, window.innerWidth, window.innerHeight));
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  const keyboard = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.target?.closest('form')) return;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); change({ active: Math.max(0, Math.min(filtered.length - 1, current.active + (event.key === 'ArrowDown' ? 1 : -1))) }); }
    else if (event.key === 'Enter' && !event.isComposing && !current.manual) { event.preventDefault(); if (filtered[current.active]) select(filtered[current.active].packageName); }
  };
  return <div className="min-w-0">
    <button ref={trigger} type="button" disabled={disabled || !key} aria-label={title} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close(false) : show()} onKeyDown={event => { if (['ArrowDown', 'Enter', ' '].includes(event.key) && !open) { event.preventDefault(); show(); } }}
      title={value || placeholder || tr('选择应用（可选）')} className={`flex min-h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-45 ${theme.input}`}>
      <span className="min-w-0 truncate">{value || placeholder || tr('选择应用（可选）')}</span><ChevronDown size={14} className="shrink-0" />
    </button>
    {stored.error && <p role="status" className="mt-1 text-xs text-amber-600">{tr(stored.error)}</p>}
    {open && portalHost && createPortal(<div ref={popup} id={id} role="dialog" aria-label={title} onKeyDown={keyboard} style={{ position: 'fixed', ...position, visibility: position ? 'visible' : 'hidden' }}
      onBlur={event => { if (event.relatedTarget && !popup.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) close(false); }}
      className={`z-[245] flex flex-col overflow-hidden rounded-xl border shadow-2xl ${dark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800'}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-400/15 p-2"><Search size={15} className="shrink-0" /><input ref={search} role="combobox" aria-label={tr('搜索应用名称或包名')} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-options`} aria-activedescendant={filtered[current.active] ? `${id}-option-${current.active}` : undefined}
        value={current.query} onChange={event => change({ query: event.target.value.slice(0, 256), active: 0 })} placeholder={tr('搜索应用名称或包名')} className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm outline-none" />
        <button type="button" disabled={current.loading || device.status !== 'device'} onClick={() => load(true)} aria-label={tr('重新读取应用列表')} className="rounded-lg p-2 hover:bg-slate-500/10 disabled:opacity-40">{current.loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button></div>
      <div id={`${id}-options`} role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-y-auto py-1">
        <button type="button" role="option" aria-selected={!value} onClick={() => select('')} className="block w-full px-3 py-2 text-left text-xs hover:bg-slate-500/10">{tr('不指定应用')}</button>
        {filtered.map((item, index) => <button key={item.packageName} id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={value === item.packageName} onMouseEnter={() => change({ active: index })} onClick={() => select(item.packageName)} title={item.packageName}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${current.active === index ? 'bg-emerald-500/10' : 'hover:bg-slate-500/10'}`}><span className="min-w-0 flex-1"><span className="block truncate">{item.label}{recent.includes(item.packageName) && <span className={`ml-2 text-[10px] ${muted}`}>{tr('最近')}</span>}</span>{item.label !== item.packageName && <span className={`mt-0.5 block break-all text-[11px] ${muted}`}>{item.packageName}</span>}</span>{value === item.packageName && <Check size={14} className="shrink-0 text-emerald-500" />}</button>)}
        {!filtered.length && <p role="status" className={`px-3 py-4 text-xs ${muted}`}>{current.loading ? tr('正在读取应用…') : tr('没有匹配的应用，可手动输入包名。')}</p>}
      </div>
      <div className="shrink-0 space-y-2 border-t border-slate-400/15 p-2">
        {current.error && <p role="alert" className="break-words text-xs text-amber-600">{tr(current.error)}</p>}
        <button type="button" onClick={() => change({ manual: !current.manual })} className={`text-xs underline ${muted}`}>{tr('手动输入包名')}</button>
        {current.manual && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (validApplicationPackage(current.manualValue)) select(current.manualValue); }}><input aria-label={tr('应用包名')} value={current.manualValue} maxLength={256} onChange={event => change({ manualValue: event.target.value })} className={`min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-xs ${theme.input}`} /><button type="submit" disabled={!validApplicationPackage(current.manualValue)} className={`rounded-lg px-3 py-1.5 text-xs disabled:opacity-40 ${theme.button.primary}`}>{tr('采用')}</button></form>}
      </div>
    </div>, portalHost)}
  </div>;
}
