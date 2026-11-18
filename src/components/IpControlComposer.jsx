import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Code2, Send } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { formatHex } from '../shared/serialFormat.js';
import { inspectHex, ipControlError } from '../shared/ipControlModel.js';
import IpControlSavedCommands from './IpControlSavedCommands.jsx';

const ProtocolPanel = lazy(() => import('./Rs232ProtocolPanel.jsx'));
const memoryScope = { workspace: 'rs232', schemeId: 'ip-control' };

export default function IpControlComposer({ theme, isDark, showToast, mode, sending, canSend, onSend, commandRevision }) {
  useLocale();
  const [draft, setDraft] = useState(''), [protocolOpen, setProtocolOpen] = useState(false);
  const input = useRef(null), validation = useMemo(() => inspectHex(draft, mode), [draft, mode]);
  const compact = useMemo(() => validation.code ? '' : draft.replace(/[ \t\r\n]/g, '').toUpperCase(), [draft, validation.code]);
  const field = `w-full min-w-0 rounded-lg border px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  function fill(hex) {
    if (inspectHex(hex).code) return false;
    setDraft(hex); setProtocolOpen(false); showToast?.(tr('已填入发送区，尚未发送'));
    requestAnimationFrame(() => input.current?.focus()); return true;
  }
  function submit() { if (!validation.code && canSend && !sending) onSend(draft); }
  return <div className="min-w-0 space-y-2 border-t border-slate-400/20 pt-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="ip-control-send" className="text-sm font-medium">{tr('发送数据')}</label>
      <div className="flex flex-wrap items-center gap-2"><span className={`rounded-lg border border-slate-400/20 px-3 py-1.5 text-xs ${theme.textMuted}`}>HEX</span><span className={`text-xs ${theme.textMuted}`}>{tr('不追加换行')}</span>
        <button type="button" className={button} disabled={!compact} onClick={() => setDraft(formatHex(compact))}>{tr('整理 HEX')}</button>
        <button type="button" className={button} disabled={!draft} onClick={() => setDraft('')}>{tr('清空输入')}</button></div></div>
    <textarea id="ip-control-send" ref={input} aria-label={tr('IP Control 发送内容')} rows={3} spellCheck={false} value={draft} placeholder={tr('输入 HEX 数据')}
      onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} className={`${field} resize-y font-mono`} />
    <div className={`min-w-0 text-xs ${theme.textMuted}`}>{draft && validation.code ? <span role="alert" className="text-amber-600">{ipControlError(validation.code)}</span>
      : mode === 'udp' ? <span>{validation.bytes} B · {tr('UDP 单次最多 65507 B')}</span> : tr('待发送 {0} B · 单次最多 64 KiB', { 0: validation.bytes })}<p className="mt-1 text-[11px]">{tr('HEX 严格发送原始字节，不追加换行；整理只修改显示格式。')}{tr('写入成功不代表设备已执行或回应。')}</p></div>
    <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" onClick={() => setProtocolOpen(true)} className={`inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm font-medium ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}><Code2 size={17} />{tr('RS232 协议面板')}</button>
      <button type="button" aria-label={tr('发送')} disabled={!canSend || sending || Boolean(validation.code)} onClick={submit} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Send size={14}/>{sending ? tr('写入中…') : tr('发送')}<span aria-hidden="true" className="hidden text-[10px] opacity-75 sm:inline">Ctrl+Enter</span></button></div>
    {compact && <div aria-label={tr('实际发送字节预览')} className={`rounded-lg border border-slate-400/20 px-3 py-2 text-[11px] ${theme.textMuted}`}>{tr('实际发送字节（HEX）')}{validation.bytes > 32 && tr(' · 仅预览前 32 B')}<code className="mt-1 block break-all">{formatHex(compact.slice(0, 64))}{validation.bytes > 32 ? ' …' : ''}</code></div>}
    <IpControlSavedCommands theme={theme} draft={compact} revision={commandRevision} onFill={hex => fill(formatHex(hex))} />
    {protocolOpen && <Suspense fallback={<p role="status">{tr('正在打开协议面板…')}</p>}><ProtocolPanel theme={theme} isDark={isDark} memoryScope={memoryScope} onClose={() => setProtocolOpen(false)} onUse={frame => fill(frame?.hex)} /></Suspense>}
  </div>;
}
