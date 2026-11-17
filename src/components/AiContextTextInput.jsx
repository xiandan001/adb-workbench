import { useEffect, useId, useRef, useState } from 'react';
import { tr, useLocale } from '../shared/i18n.js';
import { contextTextBytes, plainTextWindow, TEXT_WINDOW_UNITS } from '../shared/aiContextTextWindow.js';

export default function AiContextTextInput({ value, onChange, disabled, className, placeholder, label }) {
  useLocale(); const id = useId(), alive = useRef(true), sequence = useRef(0), inFlight = useRef(0), latest = useRef(null);
  const [part, setPart] = useState(0), [replacing, setReplacing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  latest.current = { value, disabled, onChange };
  useEffect(() => { alive.current = true; return () => { alive.current = false; inFlight.current = 0; }; }, []);
  useEffect(() => { inFlight.current = 0; setBusy(false); setReplacing(false); }, [value, disabled]);
  const large = value.length > TEXT_WINDOW_UNITS, window = plainTextWindow(value, part);
  async function accept(next) {
    if (!alive.current || latest.current.disabled || inFlight.current) return;
    if (next.length <= TEXT_WINDOW_UNITS) { latest.current.onChange(next); setPart(0); setReplacing(false); setError(''); return; }
    const original = latest.current.value, token = ++sequence.current; inFlight.current = token; setBusy(true); setError('');
    try {
      await contextTextBytes(next);
      if (!alive.current || inFlight.current !== token || latest.current.disabled || latest.current.value !== original) return;
      latest.current.onChange(next); setPart(0); setReplacing(false);
    } catch (failure) { if (alive.current && inFlight.current === token) setError(failure.message); }
    finally { if (alive.current && inFlight.current === token) { inFlight.current = 0; setBusy(false); } }
  }
  const paste = event => {
    event.preventDefault(); if (disabled || busy) return;
    const input = event.currentTarget, base = replacing ? '' : value;
    const text = event.clipboardData.getData('text/plain');
    void accept(base.slice(0, input.selectionStart ?? base.length) + text + base.slice(input.selectionEnd ?? base.length));
  };
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="text-xs font-medium">{label}</label>
    {large && !replacing ? <>
      <p role="status" className="text-xs text-amber-600 dark:text-amber-400">{tr('大文本仅分页显示；完整原文已保留用于本机准备，显示分页不会改变分析内容。')}</p>
      <pre id={id} aria-label={label} className={`${className} max-h-48 overflow-auto whitespace-pre-wrap break-all`}>{window.text}</pre>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" disabled={disabled || busy || window.part === 0} onClick={() => setPart(window.part - 1)} className="rounded border border-current/20 px-2 py-1 disabled:opacity-40">{tr('上一段文本')}</button>
        <span>{tr('显示片段 {0}/{1}；不是原文行号。', { 0: window.part + 1, 1: window.count })}</span>
        <button type="button" disabled={disabled || busy || window.part + 1 >= window.count} onClick={() => setPart(window.part + 1)} className="rounded border border-current/20 px-2 py-1 disabled:opacity-40">{tr('下一段文本')}</button>
        <button type="button" disabled={disabled || busy} onClick={() => { setReplacing(true); setError(''); }} className="rounded border border-current/20 px-2 py-1 disabled:opacity-40">{tr('替换全部材料')}</button>
      </div>
    </> : <>
      {replacing && <p className="text-xs text-amber-600 dark:text-amber-400">{tr('粘贴或输入新材料后才会替换；验证失败时保留原文。')}</p>}
      <textarea id={id} aria-label={label} value={replacing ? '' : value} disabled={disabled || busy} rows={4} onPaste={paste}
        onChange={event => { const next = event.target.value; if (next.length > TEXT_WINDOW_UNITS) event.target.value = replacing ? '' : value; void accept(next); }}
        className={`${className} resize-y font-mono text-xs leading-5`} placeholder={placeholder} />
      {replacing && <button type="button" disabled={busy} onClick={() => setReplacing(false)} className="text-xs underline">{tr('取消替换，保留原文')}</button>}
    </>}
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span>{tr('补充正文最多 20 MiB；来源信息计入最终完整上下文上限。')}</span>
      {value && <button type="button" disabled={disabled || busy} onClick={() => { onChange(''); setPart(0); setError(''); }} className="underline disabled:opacity-40">{tr('清空补充文本')}</button>}
    </div>
    {busy && <p role="status" className="text-xs">{tr('正在本机检查完整文本大小，尚未替换原文或发送。')}</p>}
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
  </div>;
}
