import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Pause, Play, Save, Trash2, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { formatAscii, formatHex } from '../shared/serialFormat';

const ROW_HEIGHT = 56;
const VIEW_HEIGHT = 224;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const directionLabel = direction => direction === 'RX' ? '接收 RX' : '发送 TX';
const entryContent = (entry, mode, limited = false) => {
  const hex = limited ? entry.hex.slice(0, 160) : entry.hex;
  return mode === 'hex' ? formatHex(hex) : mode === 'ascii' ? formatAscii(hex) : entry.text;
};
const preview = value => [...String(value || '').slice(0, 240)].map(character => {
  const code = character.charCodeAt(0);
  return (code < 32 && ![9, 10, 13].includes(code)) || code === 127 ? `\\x${code.toString(16).padStart(2, '0')}` : character;
}).join('');

function SerialEntryDetail({ entry, mode, theme, onClose, onCopy }) {
  const dialog = useRef(null);
  const titleId = useId();
  const content = entryContent(entry, mode);
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} className={`m-auto w-[min(760px,calc(100vw-32px))] max-h-[80vh] overflow-auto rounded-xl border p-4 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <div className="flex items-center justify-between gap-3"><h3 id={titleId} className="font-semibold">串口记录详情</h3><button type="button" aria-label="关闭记录详情" onClick={onClose}><X size={18} /></button></div>
    <p className={`mt-2 break-all text-xs leading-5 ${theme.textMuted}`}>{directionLabel(entry.direction)} · {entry.path} · {new Date(entry.time).toLocaleDateString()} {timeFormat.format(entry.time)}{entry.endTime > entry.time ? ` — ${timeFormat.format(entry.endTime)}` : ''} · {entry.bytes} B{entry.parts > 1 ? ` · 合并 ${entry.parts} 段` : ''}<br />会话：{entry.sessionId}<br />参数：{entry.config?.baudRate} / {entry.config?.dataBits} / {entry.config?.stopBits} / {entry.config?.parity} / {entry.config?.flowControl}</p>
    <div className="mt-3 flex items-center justify-between"><span className="text-sm">{mode === 'hex' ? 'HEX 原始字节' : mode === 'ascii' ? 'ASCII（不可见字节显示转义）' : 'UTF-8 文本'}</span><button type="button" className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs ${theme.button.secondary}`} onClick={() => onCopy(content)}><Copy size={13} />复制完整内容</button></div>
    <pre className={`mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 text-xs ${theme.input}`}>{content || '（此记录没有完整 UTF-8 字符，请查看 HEX）'}</pre>
    {mode !== 'hex' && <details className="mt-3 text-xs"><summary className="cursor-pointer">查看对应 HEX 原始字节</summary><pre className="mt-2 whitespace-pre-wrap break-all">{formatHex(entry.hex)}</pre></details>}
  </dialog>;
}

export default function SerialDataView({ theme, isDark, snapshot, receiveMode, onMode, following, onFollowing, onSave, onClear, saving, busy, showToast }) {
  const id = useId();
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [detailId, setDetailId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const entries = snapshot.entries;
  const detail = entries.find(entry => entry.id === detailId);
  const maximumScroll = Math.max(0, entries.length * ROW_HEIGHT - VIEW_HEIGHT);
  const visibleTop = following ? maximumScroll : Math.min(scrollTop, maximumScroll);
  const start = Math.max(0, Math.floor(visibleTop / ROW_HEIGHT) - 3);
  const rows = entries.slice(start, start + Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + 7);
  const button = `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;

  useLayoutEffect(() => {
    if (following && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, following]);

  const copy = async value => {
    try { await navigator.clipboard.writeText(value); showToast?.('串口记录已复制'); }
    catch { showToast?.('复制失败，请选择内容后手动复制'); }
  };

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">收发记录</h3><label className="sr-only" htmlFor={`${id}-receive`}>接收显示格式</label><SelectMenu id={`${id}-receive`} isDark={isDark} compact value={receiveMode} onChange={onMode} options={[{ value: 'text', label: '文本 UTF-8' }, { value: 'hex', label: 'HEX' }, { value: 'ascii', label: 'ASCII（7-bit）' }]} className="w-36" /></div>
      <div className="flex flex-wrap gap-1.5"><button type="button" onClick={() => onFollowing(!following)} className={button} aria-pressed={!following}>{following ? <Pause size={13} /> : <Play size={13} />}{following ? '暂停滚动' : '恢复跟随'}</button><button type="button" onClick={onSave} disabled={!entries.length || busy} className={button}><Save size={13} />{saving ? '保存中…' : '保存当前记录'}</button><button type="button" onClick={() => setConfirmClear(true)} disabled={!entries.length || busy} className={button}><Trash2 size={13} />清空记录</button></div>
    </div>
    {confirmClear && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs"><span className="flex-1 basis-64">清空后无法恢复，请先保存。只清理当前记录和统计，不发送命令或清理硬件缓冲。</span><button type="button" disabled={busy} onClick={() => { setConfirmClear(false); onClear(); }} className="rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-40">确认清空</button><button type="button" onClick={() => setConfirmClear(false)} className={button}>取消</button></div>}
    <div ref={scrollRef} role="region" aria-label="串口收发记录" tabIndex={0} style={{ height: VIEW_HEIGHT }} onScroll={event => { const element = event.currentTarget; setScrollTop(element.scrollTop); if (following && element.scrollHeight - element.scrollTop - element.clientHeight > ROW_HEIGHT) onFollowing(false); }} className={`overflow-auto rounded-lg border ${theme.input}`}>
      {!entries.length ? <div className={`flex h-full items-center justify-center px-5 text-center text-xs ${theme.textMuted}`}>暂无收发数据。连接串口后开始接收；发送操作不会自动执行。</div> : <div style={{ height: entries.length * ROW_HEIGHT, position: 'relative' }}>
        {rows.map((entry, index) => <button type="button" key={entry.id} onClick={() => setDetailId(entry.id)} style={{ height: ROW_HEIGHT, top: (start + index) * ROW_HEIGHT, position: 'absolute' }} className="left-0 w-full min-w-0 border-b border-slate-400/15 px-3 py-2 text-left hover:bg-slate-400/10" aria-label={`查看 ${directionLabel(entry.direction)} 记录 ${entry.id}`}>
          <span className={`flex items-center gap-2 text-[11px] ${theme.textMuted}`}><span className={`shrink-0 font-semibold ${entry.direction === 'RX' ? 'text-emerald-500' : 'text-sky-500'}`}>{directionLabel(entry.direction)}</span><span className="shrink-0">{timeFormat.format(entry.time)}</span><span className="truncate">{entry.path}</span><span className="shrink-0">{entry.bytes} B</span>{entry.parts > 1 && <span className="shrink-0">合并 {entry.parts} 段</span>}<ChevronDown size={12} className="ml-auto shrink-0 -rotate-90" /></span>
          <span className="mt-1 block truncate font-mono text-xs">{preview(entryContent(entry, receiveMode, true)) || '（无完整文本，切换 HEX 查看）'}</span>
        </button>)}
      </div>}
    </div>
    <div className={`flex flex-wrap justify-between gap-1 text-[11px] ${theme.textMuted}`}><span>接收 {snapshot.rxBytes.toLocaleString()} B · 发送 {snapshot.txBytes.toLocaleString()} B · 缓存 {entries.length} 条{snapshot.unsaved ? ' · 有未保存记录' : ''}</span><span>{following ? '跟随最新' : '已暂停滚动，仍持续接收'} · 点击记录查看完整内容</span></div>
    {snapshot.evicted > 0 && <p role="status" className="text-xs text-amber-500">仅保留最近记录，较早的 {snapshot.evicted} 条记录已移出缓存；保存仅包含当前缓存。</p>}
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>相邻接收间隔不超过 50 ms 时，每行最多合并 2 段，第三段另起一行；仍限制每条 16 KiB 或 1 秒。仅整理显示，不代表完整协议帧。{receiveMode === 'ascii' ? 'ASCII 将不可见或高位字节显示为转义，原始数据保持不变。' : '文本不可读时可切换 HEX 查看原始字节。'}</p>
    {detail && <SerialEntryDetail entry={detail} mode={receiveMode} theme={theme} onClose={() => setDetailId(null)} onCopy={copy} />}
  </div>;
}
