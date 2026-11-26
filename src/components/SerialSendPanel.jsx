import { tr, useLocale, getLocale } from '../shared/i18n';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Calculator, ChevronDown, Clock, Code2, Pencil, Plus, Send, Star, Trash2, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import TclFrameDialog from './TclFrameDialog.jsx';
import { encodeMessage } from '../shared/serialSettings';
import { formatHex } from '../shared/serialFormat';
import { fillProtocolDraft } from '../shared/rs232ProtocolDraft.js';
import { completeManualTclHex } from '../shared/tclFactoryProtocol.js';

const Rs232ProtocolPanel = lazy(() => import('./Rs232ProtocolPanel.jsx'));

const bytesHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const commandPreview = item => item.mode === 'hex' ? formatHex(item.content.replace(/\s+/gu, '').slice(0, 80)) : item.content.slice(0, 120);

export default function SerialSendPanel({ theme, isDark, preferences, onPreferences, draft, onDraft, commandsOpen, onCommandsOpen, connected, sending, busy, onSend, history, showToast, desk = false, memoryScope = { workspace: 'rs232', schemeId: '' } }) {
  const locale = useLocale();
  const id = useId();
  const [favoriteName, setFavoriteName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [favoriteError, setFavoriteError] = useState('');
  const [composer, setComposer] = useState('');
  const [protocolFilling, setProtocolFilling] = useState(false);
  const [autoTclCrc, setAutoTclCrc] = useState(true);
  const [feedback, setFeedback] = useState({ sequence: 0, active: false, kind: '', key: '', source: '' });
  const textareaRef = useRef(null);
  const feedbackTimer = useRef(null);
  const protocolFillRef = useRef(false), protocolEpochRef = useRef(0), aliveRef = useRef(true);
  const { sendMode: mode, lineEnding, favorites } = preferences;
  const canCompleteTclCrc = mode === 'hex' && memoryScope.workspace === 'rs232';
  const tclCompletion = useMemo(() => canCompleteTclCrc && autoTclCrc ? completeManualTclHex(draft) : null, [canCompleteTclCrc, autoTclCrc, draft]);
  const content = tclCompletion?.hex ?? draft;
  const message = useMemo(() => ({ mode, content, lineEnding }), [mode, content, lineEnding]);
  const validation = useMemo(() => {
    void locale;
    try {
      const data = encodeMessage(message);
      return { bytes: data.length, preview: formatHex(bytesHex(data.subarray(0, 32))), data, error: '' };
    } catch (error) { return { bytes: 0, preview: '', error: error.message }; }
  }, [message, locale]);
  const field = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const button = `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const locked = sending || busy || protocolFilling;
  const sendDisabled = !connected || locked || Boolean(validation.error);
  const description = [feedback.active && `${id}-feedback`, tclCompletion && `${id}-tcl-crc`].filter(Boolean).join(' ') || undefined;
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; clearTimeout(feedbackTimer.current); }; }, []);
  useLayoutEffect(() => {
    if (!feedback.sequence) return;
    textareaRef.current?.focus({ preventScroll: true });
    textareaRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [feedback.sequence]);
  const dismissFeedback = () => {
    clearTimeout(feedbackTimer.current);
    setFeedback(previous => previous.active ? { ...previous, active: false } : previous);
  };
  const fill = item => {
    if (protocolFillRef.current) return false;
    dismissFeedback();
    onDraft(item.content);
    onPreferences({ sendMode: item.mode, lineEnding: item.lineEnding });
    setFavoriteError('');
    return true;
  };
  const selectCommand = (item, kind, key, source) => {
    if (!fill(item)) return;
    setEditingId('');
    setFavoriteName('');
    setFeedback(previous => ({ sequence: previous.sequence + 1, active: true, kind, key, source }));
    showToast?.(tr("已填入发送区，尚未发送"));
    feedbackTimer.current = setTimeout(() => setFeedback(previous => ({ ...previous, active: false })), 3000);
  };
  const saveFavorite = async () => {
    setFavoriteError('');
    if (!favoriteName.trim()) { setFavoriteError(tr("请输入常用命令名称")); return; }
    if (validation.error) { setFavoriteError(validation.error); return; }
    const item = { id: editingId || crypto.randomUUID(), name: favoriteName.trim(), ...message };
    const next = editingId ? favorites.map(previous => previous.id === editingId ? item : previous) : [...favorites, item];
    if (await onPreferences({ favorites: next })) { setEditingId(''); setFavoriteName(''); }
  };
  const submit = () => { if (!sendDisabled && !protocolFillRef.current) { dismissFeedback(); onSend(message); } };
  const useProtocol = async (frame, name) => {
    if (locked || protocolFillRef.current || !aliveRef.current) return false;
    const epoch = ++protocolEpochRef.current, isCurrent = () => aliveRef.current && protocolEpochRef.current === epoch;
    protocolFillRef.current = true; setProtocolFilling(true);
    try {
      if (!await fillProtocolDraft(frame, { onPreferences, onDraft, previous: { sendMode: mode, lineEnding }, isCurrent }) || !isCurrent()) return false;
      dismissFeedback(); setEditingId(''); setFavoriteName(''); setFavoriteError(''); setComposer('');
      setFeedback(previous => ({ sequence: previous.sequence + 1, active: true, kind: 'protocol', key: '', source: tr('协议命令：{0}', { 0: name }) }));
      showToast?.(tr('已填入发送区，尚未发送'));
      feedbackTimer.current = setTimeout(() => setFeedback(previous => ({ ...previous, active: false })), 3000);
      return true;
    } finally { if (protocolEpochRef.current === epoch) { protocolFillRef.current = false; if (aliveRef.current) setProtocolFilling(false); } }
  };

  return <div className={`min-w-0 space-y-2 ${desk ? '' : 'border-t border-slate-400/20 pt-3'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{tr("发送数据")}</h3><div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`${id}-mode`}>{tr("发送格式")}</label><SelectMenu id={`${id}-mode`} isDark={isDark} compact value={mode} disabled={locked} onChange={sendMode => { if (!protocolFillRef.current) onPreferences({ sendMode }); }} options={[{ value: 'text', label: tr("文本 UTF-8") }, { value: 'hex', label: 'HEX' }, { value: 'ascii', label: 'ASCII（7-bit）' }]} className="w-36" />
      <label className="sr-only" htmlFor={`${id}-ending`}>{tr("发送换行符")}</label><SelectMenu id={`${id}-ending`} isDark={isDark} compact value={mode === 'hex' ? 'none' : lineEnding} disabled={locked || mode === 'hex'} onChange={value => { if (!protocolFillRef.current) onPreferences({ lineEnding: value }); }} options={[{ value: 'none', label: tr("不追加换行") }, { value: 'lf', label: tr("追加 LF") }, { value: 'cr', label: tr("追加 CR") }, { value: 'crlf', label: tr("追加 CRLF") }]} className="w-32" />
      {mode === 'hex' && <button type="button" onClick={() => { if (!protocolFillRef.current && !validation.error) onDraft(formatHex(bytesHex(validation.data))); }} disabled={locked || Boolean(validation.error)} className={button} title={tr("仅整理编辑区，不会发送")}>{tr("整理 HEX")}</button>}
      <button type="button" onClick={() => { if (protocolFillRef.current) return; dismissFeedback(); onDraft(''); showToast?.(tr("发送输入已清空，收发记录未改变")); }} disabled={locked || !draft} className={button}>{tr("清空输入")}</button>
    </div></div>
    <textarea ref={textareaRef} disabled={protocolFilling} aria-label={tr("串口发送内容")} aria-describedby={description} data-command-feedback-sequence={feedback.sequence} data-command-highlighted={feedback.active ? 'true' : 'false'} value={draft} rows={3} maxLength={1048576} spellCheck={false} onChange={event => { if (protocolFillRef.current) return; dismissFeedback(); onDraft(event.target.value); }} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } }} placeholder={mode === 'hex' ? tr("例如：AA 06 10 01 A7 EF（只发送这些字节）") : mode === 'ascii' ? tr("例如：AT（仅接受 7-bit ASCII 字符）") : tr("输入发送内容；Enter 换行，Ctrl+Enter 发送")} className={`${field} resize-y font-mono text-xs ${feedback.active ? 'ring-2 ring-emerald-400' : ''}`} />
    <p id={`${id}-feedback`} role="status" aria-label={tr("命令回填反馈")} aria-live="polite" aria-atomic="true" data-command-feedback-sequence={feedback.sequence} data-command-feedback-active={feedback.active ? 'true' : 'false'} className={feedback.active ? `rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs ${isDark ? 'text-emerald-300' : 'text-emerald-700'}` : 'sr-only'}>{feedback.active && <span key={feedback.sequence}>{tr("已填入发送区，尚未发送 · {0}", { 0: feedback.source })}</span>}</p>
    <div className={`min-w-0 text-xs ${theme.textMuted}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span>{draft && validation.error ? <span role="alert" className="text-amber-500">{tr(validation.error)}</span> : tr("待发送 {0} B · 单次最多 64 KiB", { 0: validation.bytes.toLocaleString(getLocale()) })}</span>
        {canCompleteTclCrc && <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={autoTclCrc} disabled={locked} className="accent-emerald-500"
            onChange={event => { if (!protocolFillRef.current) setAutoTclCrc(event.currentTarget.checked); }} />
          <span>{tr('自动补齐 TCL CRC')}</span>
        </label>}
      </div>
      {tclCompletion && <p id={`${id}-tcl-crc`} role="status" className={`mt-1 break-words font-medium ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>
        {tr('已自动补齐 TCL CRC：{0}', { 0: tclCompletion.crc })}
      </p>}
      <p className="mt-1 text-[11px]">{mode === 'hex'
        ? (tclCompletion ? tr('整理 HEX 会将补齐的 CRC 写入编辑区，不会发送。') : tr("HEX 严格发送原始字节，不追加换行；整理只修改显示格式。"))
        : mode === 'ascii' ? tr("ASCII 只接受 0–127 字符，字面 \\r / \\n 不会转换；仅追加所选换行符一次。") : tr("UTF-8 编码，仅追加所选换行符一次。")}
        {tr("写入成功不代表设备已执行或回应。")}
      </p>
      {!connected && <p className="mt-1 text-[11px]">{tr("请先连接串口，再发送数据。")}</p>}
    </div>
    <div data-serial-send-actions className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" disabled={locked} onClick={() => { if (!protocolFillRef.current) setComposer('protocol'); }} className={`inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm font-medium disabled:opacity-40 ${isDark ? 'text-emerald-300 hover:bg-emerald-500/15' : 'text-emerald-700 hover:bg-emerald-500/15'}`}><Code2 size={17} />{tr('RS232 协议面板')}</button>
        {memoryScope.workspace === 'rs232' && <button type="button" disabled={locked} onClick={() => { if (!protocolFillRef.current) setComposer('tcl'); }}
          className={`inline-flex items-center gap-2 rounded-lg border border-slate-400/30 px-3 py-2 text-sm font-medium disabled:opacity-40 ${theme.button.secondary}`}>
          <Calculator size={16} aria-hidden="true" />{tr('TCL 报文生成器')}
        </button>}
      </div>
      <button type="button" disabled={sendDisabled} onClick={submit} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Send size={14} />{sending ? tr("写入中…") : tr("发送")}<span className="hidden text-[10px] opacity-75 sm:inline">Ctrl+Enter</span></button>
    </div>
    {validation.preview && <div aria-label={tr("实际发送字节预览")} className={`rounded-lg border border-slate-400/20 px-3 py-2 text-[11px] ${theme.textMuted}`}><span>{tr("实际发送字节（HEX）")}{validation.bytes > 32 ? tr(" · 仅预览前 32 B") : ''}</span><code className="mt-1 block break-all leading-5">{validation.preview}{validation.bytes > 32 ? ' …' : ''}</code></div>}
    <button type="button" aria-expanded={commandsOpen} aria-controls={`${id}-commands`} onClick={() => onCommandsOpen(!commandsOpen)} className={`inline-flex items-center gap-1.5 rounded py-1 text-xs ${theme.textMuted}`}><ChevronDown size={13} className={commandsOpen ? '' : '-rotate-90'} /><Star size={13} />{tr("常用命令 / 发送历史")}</button>
    {commandsOpen && <div id={`${id}-commands`} className="space-y-3 rounded-lg border border-slate-400/20 p-3">
      <p className={`text-xs ${theme.textMuted}`}>{tr("点击仅回填编辑区，不会发送。常用命令可随数据导出迁移；历史仅保存在本机。")}</p>
      <div className="flex flex-wrap gap-2"><input aria-label={tr("常用命令名称")} value={favoriteName} maxLength={80} onChange={event => setFavoriteName(event.target.value)} placeholder={editingId ? tr("编辑常用命令名称") : tr("给当前发送内容起个名字")} className={`${field} min-w-0 flex-1 basis-48`} /><button type="button" onClick={saveFavorite} disabled={!draft || Boolean(validation.error) || (!editingId && favorites.length >= 30)} className={button}><Plus size={13} />{editingId ? tr("保存修改") : tr("保存常用命令")}</button>{editingId && <button type="button" onClick={() => { setEditingId(''); setFavoriteName(''); setFavoriteError(''); }} className={button}><X size={13} />{tr("取消编辑")}</button>}</div>
      {favoriteError && <p role="alert" className="text-xs text-amber-500">{tr(favoriteError)}</p>}
      <div className={desk ? 'grid gap-3' : 'grid gap-3 lg:grid-cols-2'}>
        <div className="min-w-0"><h4 className={`mb-2 text-xs ${theme.textMuted}`}>{tr("常用命令（{0}/30）", { 0: favorites.length })}</h4><div className="max-h-40 overflow-auto space-y-1">{favorites.length ? favorites.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg bg-slate-400/10 p-1"><button type="button" data-serial-favorite-id={item.id} data-command-selected={feedback.active && feedback.kind === 'favorite' && feedback.key === item.id ? 'true' : 'false'} onClick={() => selectCommand(item, 'favorite', item.id, tr("常用命令：{0}", { 0: item.name }))} className={`min-w-0 flex-1 rounded-md px-2 py-1 text-left ${feedback.active && feedback.kind === 'favorite' && feedback.key === item.id ? 'bg-emerald-500/15 ring-1 ring-emerald-500/60' : ''}`} title={tr("{0} · {1} · 仅回填", { 0: item.name, 1: item.mode.toUpperCase() })}><span className="block truncate text-xs">{item.name}</span><span className={`block truncate font-mono text-[11px] ${theme.textMuted}`}>{item.mode.toUpperCase()} · {commandPreview(item)}</span></button><button type="button" aria-label={tr("编辑常用命令 {0}", { 0: item.name })} onClick={() => { if (fill(item)) { setEditingId(item.id); setFavoriteName(item.name); } }} className="rounded p-2"><Pencil size={13} /></button><button type="button" aria-label={tr("删除常用命令 {0}", { 0: item.name })} onClick={async () => { if (await onPreferences({ favorites: favorites.filter(previous => previous.id !== item.id) }) && editingId === item.id) { setEditingId(''); setFavoriteName(''); } }} className="rounded p-2"><Trash2 size={13} /></button></div>) : <p className={`py-2 text-xs ${theme.textMuted}`}>{tr("暂无常用命令")}</p>}</div></div>
        <div className="min-w-0"><h4 className={`mb-2 flex items-center gap-1 text-xs ${theme.textMuted}`}><Clock size={12} />{tr("最近成功发送（")}{history.length}/50）</h4><div className="max-h-40 space-y-1 overflow-auto">{history.length ? history.map((item, index) => <button type="button" key={`${item.time}-${index}`} data-serial-history-index={index} data-command-selected={feedback.active && feedback.kind === 'history' && feedback.key === `${item.time}-${index}` ? 'true' : 'false'} onClick={() => selectCommand(item, 'history', `${item.time}-${index}`, tr("最近成功发送：第 {0} 条", { 0: index + 1 }))} title={tr("仅回填，不发送")} className={`block w-full rounded-lg px-3 py-2 text-left ${feedback.active && feedback.kind === 'history' && feedback.key === `${item.time}-${index}` ? 'bg-emerald-500/15 ring-1 ring-emerald-500/60' : 'bg-slate-400/10'}`}><span className={`block text-[11px] ${theme.textMuted}`}>{new Date(item.time).toLocaleString(getLocale())} · {item.mode.toUpperCase()}</span><span className="mt-1 block truncate font-mono text-xs">{commandPreview(item)}</span></button>) : <p className={`py-2 text-xs ${theme.textMuted}`}>{tr("成功写入串口后会出现在这里")}</p>}</div></div>
      </div>
    </div>}
    {composer === 'protocol' && <Suspense fallback={<p role="status" className={`text-xs ${theme.textMuted}`}>{tr('正在打开协议面板…')}</p>}><Rs232ProtocolPanel key={`${memoryScope.workspace}:${memoryScope.schemeId}`} memoryScope={memoryScope} theme={theme} isDark={isDark} onClose={() => { if (!protocolFillRef.current) setComposer(''); }} onUse={useProtocol} /></Suspense>}
    {composer === 'tcl' && <TclFrameDialog theme={theme} isDark={isDark}
      initialValue={mode === 'hex' && /^\s*aa/i.test(draft) ? draft : ''}
      onClose={() => { if (!protocolFillRef.current) setComposer(''); }} onUse={useProtocol} />}
  </div>;
}
