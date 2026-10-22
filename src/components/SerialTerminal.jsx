import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Copy, Eraser, ClipboardPaste, Save, TerminalSquare } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import SelectMenu from './SelectMenu';
import { localEchoTerminalInput, mapTerminalKey, normalizeTerminalNewlines, prepareTerminalPaste } from '../shared/serialTerminalInput';
import { createSerialTerminalReader, createSerialTerminalWriter } from '../shared/serialTerminalTransport';

function PasteConfirmation({ paste, theme, onConfirm, onCancel }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel(); }} className={`m-auto w-[min(640px,calc(100vw-32px))] rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <h3 id={titleId} className="font-semibold">确认终端粘贴</h3>
    <p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>内容包含换行或控制字符，可能立即执行命令。请确认目标设备及内容；取消不会发送。</p>
    <textarea aria-label="粘贴内容预览" readOnly value={paste.content} rows={6} className={`mt-3 max-h-64 w-full resize-none rounded-lg border p-3 font-mono text-xs ${theme.input}`} />
    <p className={`mt-2 text-xs ${theme.textMuted}`}>{paste.bytes.toLocaleString()} B（不含设备启用的粘贴包裹序列）；换行按当前回车设置处理。</p>
    <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onCancel} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>取消</button><button type="button" onClick={() => { ref.current.close(); onConfirm(); }} className={`rounded-lg px-4 py-2 text-sm ${theme.button.primary}`}>确认粘贴</button></div>
  </dialog>;
}

export default function SerialTerminal({ theme, isDark, snapshot, settings, onSettings, onSave, saving, busy, showToast }) {
  const id = useId();
  const hostRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const termRef = useRef(null);
  const readerRef = useRef(null);
  const writerRef = useRef(null);
  const actionsRef = useRef(null);
  const syncInputRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const [replaying, setReplaying] = useState(Boolean(snapshot.sessionId));
  const [sendError, setSendError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [paste, setPaste] = useState(null);
  const connected = snapshot.status === 'connected';
  const sessionId = snapshot.sessionId;
  const live = useRef({ connected, sessionId, settings, replaying: Boolean(sessionId), paused: false, readFailed: false, showToast });
  const button = `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;

  useEffect(() => {
    Object.assign(live.current, { connected, sessionId, settings, showToast });
    syncInputRef.current?.();
  }, [connected, sessionId, settings, showToast]);

  useEffect(() => {
    let disposed = false;
    let lastKey = null;
    let pasting = false;
    let frame;
    const host = hostRef.current;
    const term = new Terminal({ cursorBlink: true, cursorStyle: 'bar', scrollback: 2000, fontSize: 13, lineHeight: 1.2,
      fontFamily: '"Cascadia Mono", Consolas, monospace', convertEol: false, disableStdin: true, altClickMovesCursor: false,
      linkHandler: { activate: event => event.preventDefault() }, windowOptions: {} });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    term.textarea.setAttribute('aria-label', '串口终端输入');
    const canInput = () => !disposed && live.current.connected && !live.current.replaying && !live.current.paused && !live.current.readFailed && !document.hidden && document.hasFocus();
    const syncInput = () => {
      const disabled = !canInput();
      term.options.disableStdin = disabled;
      term.textarea.readOnly = disabled;
      term.textarea.setAttribute('aria-disabled', String(disabled));
    };
    syncInputRef.current = syncInput;
    syncInput();
    const copy = async () => {
      const text = term.getSelection();
      if (!text) { live.current.showToast?.('请先在终端中选择文本'); return; }
      try { await navigator.clipboard.writeText(text); if (!disposed) live.current.showToast?.('终端选区已复制'); }
      catch { if (!disposed) setNotice('无法访问剪贴板，请使用系统复制操作'); }
    };
    const performPaste = content => {
      if (!canInput()) { setNotice('请先连接串口并等待输出恢复，再粘贴'); return; }
      term.focus();
      lastKey = null;
      pasting = true;
      try { term.paste(content); } finally { pasting = false; }
    };
    const requestPaste = content => {
      if (disposed) return;
      if (!canInput()) { setNotice('请先连接串口并等待输出恢复，再粘贴'); return; }
      try {
        const prepared = prepareTerminalPaste(content, live.current.settings.enter);
        setNotice('');
        if (!prepared.bytes) return;
        if (prepared.requiresConfirmation) setPaste({ content, bytes: prepared.bytes, sessionId: live.current.sessionId });
        else performPaste(content);
      } catch (error) { writerRef.current?.pause(error.message); }
    };
    const pasteClipboard = async () => {
      const requestedSession = live.current.sessionId;
      try {
        const content = await navigator.clipboard.readText();
        if (!disposed && requestedSession === live.current.sessionId) requestPaste(content);
      } catch { if (!disposed) setNotice('无法读取剪贴板，请使用系统粘贴操作'); }
    };
    const pasteEvent = event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestPaste(event.clipboardData?.getData('text/plain') || '');
    };
    host.addEventListener('paste', pasteEvent, true);
    const focus = () => setFocused(true);
    const blur = () => { lastKey = null; setFocused(false); };
    term.textarea.addEventListener('focus', focus);
    term.textarea.addEventListener('blur', blur);
    const windowFocus = () => { syncInput(); setFocused(document.hasFocus() && document.activeElement === term.textarea); };
    window.addEventListener('focus', windowFocus);
    window.addEventListener('blur', windowFocus);
    term.attachCustomKeyEventHandler(event => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (event.type === 'keydown') settingsButtonRef.current?.focus();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.type === 'keydown') { if (event.key.toLowerCase() === 'c') void copy(); else void pasteClipboard(); }
        return false;
      }
      if (!canInput()) return false;
      return true;
    });
    const disposables = [
      term.parser.registerOscHandler(52, () => true),
      term.parser.registerOscHandler(8, () => true),
      term.onKey(event => { lastKey = event; }),
      term.onData(data => {
        const key = lastKey;
        lastKey = null;
        // Initial cache replay is readonly: terminal-generated query responses
        // must never turn historical output into a device write.
        if (!canInput() || document.activeElement !== term.textarea) return;
        const content = pasting ? normalizeTerminalNewlines(data, live.current.settings.enter)
          : key?.key === data ? mapTerminalKey(data, key.domEvent, live.current.settings) : data;
        if (!pasting && content === '\x03') writerRef.current?.interrupt();
        else writerRef.current?.enqueue(content);
      }),
    ];
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!disposed && host.clientWidth && host.clientHeight) fit.fit(); });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const visibility = () => {
      syncInput();
      if (document.hidden) readerRef.current?.pause();
      else { readerRef.current?.start(); resize(); }
    };
    document.addEventListener('visibilitychange', visibility);
    actionsRef.current = {
      copy, pasteClipboard, performPaste,
      clearScreen() { term.clear(); term.write('\x1b[2J\x1b[H'); },
    };
    return () => {
      disposed = true;
      readerRef.current?.dispose();
      writerRef.current?.dispose();
      observer.disconnect();
      cancelAnimationFrame(frame);
      host.removeEventListener('paste', pasteEvent, true);
      term.textarea.removeEventListener('focus', focus);
      term.textarea.removeEventListener('blur', blur);
      window.removeEventListener('focus', windowFocus);
      window.removeEventListener('blur', windowFocus);
      document.removeEventListener('visibilitychange', visibility);
      disposables.forEach(disposable => disposable.dispose());
      term.dispose();
      termRef.current = null;
      actionsRef.current = null;
      syncInputRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = settings.style === 'classic'
      ? { background: '#000000', foreground: '#e5e7eb', cursor: '#e5e7eb', selectionBackground: '#64748b80' }
      : isDark ? { background: '#111827', foreground: '#e5e7eb', cursor: '#34d399', selectionBackground: '#2563eb80' }
        : { background: '#f8fafc', foreground: '#0f172a', cursor: '#059669', selectionBackground: '#93c5fd80' };
  }, [isDark, settings.style]);

  useEffect(() => {
    const term = termRef.current;
    if (!sessionId || !term) return undefined;
    let disposed = false;
    term.reset();
    live.current.readFailed = false;
    const reader = createSerialTerminalReader({ sessionId,
      read: args => window.electronAPI.serialTerminalRead(args),
      write: data => new Promise(resolve => { if (disposed) resolve(); else term.write(data, resolve); }),
      onTruncated: () => { if (!disposed) { term.reset(); syncInputRef.current?.(); setTruncated(true); } },
      onError: message => { if (!disposed) { live.current.readFailed = true; writerRef.current?.clearPending(); setReadError(`${message}；未发送输入已清除`); syncInputRef.current?.(); } },
      onReplayChange: value => { if (!disposed) { live.current.replaying = value; setReplaying(value); syncInputRef.current?.(); } },
    });
    readerRef.current = reader;
    Promise.resolve().then(() => { if (!disposed) { setReadError(''); setTruncated(false); } });
    if (!document.hidden) reader.start();
    return () => { disposed = true; reader.dispose(); if (readerRef.current === reader) readerRef.current = null; };
  }, [sessionId]);

  useEffect(() => {
    if (!connected || !sessionId) return undefined;
    let disposed = false;
    live.current.paused = false;
    const writer = createSerialTerminalWriter({ sessionId,
      write: args => window.electronAPI.serialTerminalWrite(args),
      canWrite: () => !disposed && live.current.connected && live.current.sessionId === sessionId,
      onError: message => { if (!disposed) { live.current.paused = true; setSendError(message); syncInputRef.current?.(); } },
      onSent: content => { if (!disposed && live.current.settings.localEcho) termRef.current?.write(localEchoTerminalInput(content)); },
    });
    writerRef.current = writer;
    syncInputRef.current?.();
    Promise.resolve().then(() => { if (!disposed) setSendError(''); });
    return () => { disposed = true; writer.dispose(); if (writerRef.current === writer) writerRef.current = null; };
  }, [connected, sessionId]);

  const confirmPaste = () => {
    const selected = paste;
    setPaste(null);
    if (selected?.sessionId !== sessionId || !connected) { setNotice('串口会话已变化，未粘贴任何内容'); return; }
    actionsRef.current?.performPaste(selected.content);
  };
  const resume = () => {
    if (!writerRef.current?.resume()) { setNotice('当前写入尚未完成，请稍后重试；旧输入不会重放'); return; }
    live.current.paused = false;
    setSendError('');
    setNotice('');
    syncInputRef.current?.();
  };
  const retryRead = () => {
    live.current.readFailed = false;
    setReadError('');
    readerRef.current?.start();
    syncInputRef.current?.();
  };
  const inputReady = connected && !replaying && !sendError && !readError;

  return <section aria-label="串口终端" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className={`inline-flex items-center gap-1.5 text-xs ${inputReady && focused ? 'text-emerald-500' : theme.textMuted}`}><TerminalSquare size={15} />{!connected ? '未连接 · 终端只读' : replaying ? '正在恢复最近输出，暂不可输入…' : sendError || readError ? '输入已暂停' : focused ? '输入已激活 · Ctrl+C 发送中断' : '已连接 · 点击终端后输入'}</p>
      <div className="flex flex-wrap gap-1.5"><button type="button" onClick={() => actionsRef.current?.copy()} className={button} title="Ctrl+Shift+C"><Copy size={13} />复制选区</button><button type="button" onClick={() => actionsRef.current?.pasteClipboard()} disabled={!inputReady} className={button} title="Ctrl+Shift+V；多行粘贴需确认"><ClipboardPaste size={13} />粘贴</button><button type="button" onClick={() => actionsRef.current?.clearScreen()} className={button} title="仅清理终端显示，不清除收发记录"><Eraser size={13} />清屏</button><button type="button" onClick={onSave} disabled={busy || !snapshot.entries.length} className={button} title="保存当前收发记录，可能包含敏感输入"><Save size={13} />{saving ? '保存中…' : '保存收发记录'}</button></div>
    </div>
    {sendError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-500"><span className="min-w-0 flex-1 break-words">{sendError}</span><button type="button" onClick={resume} disabled={!connected} className={button}>恢复输入</button></div>}
    {readError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-500"><span className="min-w-0 flex-1 break-words">{readError}</span><button type="button" onClick={retryRead} className={button}>重试接收</button></div>}
    {notice && <p role="status" className="text-xs text-amber-500">{notice}</p>}
    {truncated && <p role="status" className="text-xs text-amber-500">终端较早输出已截断，仅恢复原始接收缓存中最近的内容；收发记录独立保留。</p>}
    <div className={`rounded-lg border p-2 ${settings.style === 'classic' ? 'border-slate-600 bg-black' : isDark ? 'border-slate-600 bg-[#111827]' : 'border-slate-200 bg-slate-50'}`}><div ref={hostRef} className="h-[360px] min-w-0 overflow-hidden" /></div>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>Tab 补全、方向键历史由设备端 Shell 支持；Ctrl+C / Ctrl+D / Ctrl+Z 原样交给设备，Ctrl+Shift+M 移出终端焦点。清屏只清显示，不清收发记录。保存的收发记录可能包含敏感输入。</p>
    <button ref={settingsButtonRef} type="button" aria-expanded={settings.expanded} aria-controls={`${id}-settings`} onClick={() => onSettings({ expanded: !settings.expanded })} className={`inline-flex items-center gap-1 rounded py-1 text-xs ${theme.textMuted}`}><ChevronDown size={13} className={settings.expanded ? '' : '-rotate-90'} />终端设置</button>
    {settings.expanded && <div id={`${id}-settings`} className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-400/20 p-3">
      <div className="w-40 space-y-1 text-xs"><label htmlFor={`${id}-style`}>终端样式</label><SelectMenu id={`${id}-style`} isDark={isDark} value={settings.style} onChange={style => onSettings({ style })} options={[{ value: 'current', label: '当前主题' }, { value: 'classic', label: '经典黑底' }]} /></div>
      <div className="w-40 space-y-1 text-xs"><label htmlFor={`${id}-enter`}>回车发送</label><SelectMenu id={`${id}-enter`} isDark={isDark} value={settings.enter} onChange={enter => onSettings({ enter })} options={[{ value: 'cr', label: 'CR（默认）' }, { value: 'lf', label: 'LF' }, { value: 'crlf', label: 'CRLF' }]} /></div>
      <div className="w-40 space-y-1 text-xs"><label htmlFor={`${id}-backspace`}>退格发送</label><SelectMenu id={`${id}-backspace`} isDark={isDark} value={settings.backspace} onChange={backspace => onSettings({ backspace })} options={[{ value: 'del', label: 'DEL（默认）' }, { value: 'bs', label: 'BS' }]} /></div>
      <label className="flex items-center gap-2 py-2 text-xs"><input type="checkbox" checked={settings.localEcho} onChange={event => onSettings({ localEcho: event.target.checked })} />本地回显</label><p className={`w-full text-[11px] ${theme.textMuted}`}>设备已回显字符时，请保持本地回显关闭，以免重复显示。改变设置不会发送数据。</p>
    </div>}
    {paste && connected && paste.sessionId === sessionId && <PasteConfirmation paste={paste} theme={theme} onConfirm={confirmPaste} onCancel={() => setPaste(null)} />}
  </section>;
}
