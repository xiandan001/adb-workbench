import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, Eraser, History, Pause, Play } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { prepareTerminalPaste } from '../../shared/serialTerminalInput';
import { createSshTerminalReader, createSshTerminalWriter } from '../../shared/sshTerminalTransport';
import { sshResult } from '../../shared/sshWorkspace';
import { createSshInlineController } from '../../shared/sshInlineController';
import { acceptSshHistoryResult } from '../../shared/sshInlineHistory';
import { sshClipboardAction } from '../../shared/sshTerminalClipboard';
import SshInlineCompletion from './SshInlineCompletion';
import SshHistoryPanel from './SshHistoryPanel';
import SshFileContextMenu from './SshFileContextMenu';

function PasteDialog({ content, host, theme, onConfirm, onClose }) {
  const ref = useRef(null); const id = useId();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} className={`m-auto w-[min(620px,calc(100vw-32px))] rounded-xl border p-4 backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <h3 id={id} className="font-semibold">确认 SSH 粘贴</h3><p className={`mt-2 break-all text-xs leading-5 ${theme.textMuted}`}>目标：{host}。内容包含换行或控制字符，可能立即执行命令，请确认后继续。</p><textarea aria-label="SSH 粘贴内容预览" readOnly value={content} rows={6} className={`mt-3 w-full resize-none rounded-lg border p-3 font-mono text-xs ${theme.input}`} /><div className="mt-3 flex justify-end gap-2"><button type="button" onClick={onClose} className={`rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>取消</button><button type="button" onClick={() => { ref.current.close(); onConfirm(); }} className={`rounded-lg px-3 py-2 text-xs ${theme.button.primary}`}>确认粘贴</button></div>
  </dialog>;
}

export default function SshTerminal({ session, terminal, active, historyRevision = 0, onNewTerminal, theme, isDark, showToast }) {
  const id = useId();
  const hostRef = useRef(null); const searchRef = useRef(null); const apiRef = useRef(null);
  const termRef = useRef(null); const readerRef = useRef(null); const writerRef = useRef(null);
  const inlineRef = useRef(null); const historyRef = useRef([]); const historyTicket = useRef(0); const alive = useRef(true);
  const historyAnchor = useRef(null);
  const connected = session.status === 'connected' && terminal.status === 'ready';
  const live = useRef({ active, connected, generation: 0, replaying: true, paused: false, readFailed: false, showToast });
  const [replaying, setReplaying] = useState(true); const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); const [paste, setPaste] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [pausedScroll, setPausedScroll] = useState(false); const [query, setQuery] = useState('');
  const [style, setStyle] = useState('current'); const paused = useRef(false); const searchIndex = useRef(-1);
  const [popup, setPopup] = useState(null); const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState({ entries: [], paused: false, persistent: true });
  const [historyBusy, setHistoryBusy] = useState(false); const [historyError, setHistoryError] = useState('');
  const [shell, setShell] = useState(terminal.shellIntegration || { status: 'disabled', phase: 'unknown' });
  const button = `inline-flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40 ${theme.button.secondary}`;

  useLayoutEffect(() => {
    if (live.current.active !== active) live.current.generation++;
    Object.assign(live.current, { active, connected, showToast, integrating: terminal.shellIntegration?.status === 'enabling' });
    apiRef.current?.sync();
  }, [active, connected, showToast, terminal.shellIntegration?.status]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    historyRef.current = history.entries; inlineRef.current?.refresh();
  }, [history.entries]);
  useEffect(() => {
    if (!active) return undefined;
    let disposed = false; const ticket = ++historyTicket.current;
    Promise.resolve(window.electronAPI.sshHistoryList({ sessionId: session.id })).then(sshResult).then(result => {
      if (!disposed && ticket === historyTicket.current) { setHistory(previous => acceptSshHistoryResult(previous, result)); setHistoryError(''); }
    }).catch(failure => { if (!disposed && ticket === historyTicket.current) setHistoryError(failure.message); });
    return () => { disposed = true; };
  }, [active, historyRevision, session.id]);
  const historyAction = async (action, payload = {}) => {
    if (historyBusy) return; setHistoryBusy(true); setHistoryError(''); const ticket = ++historyTicket.current;
    try {
      const method = { remove: 'sshHistoryRemove', clear: 'sshHistoryClear', pause: 'sshHistoryPause' }[action];
      const result = sshResult(await window.electronAPI[method]({ sessionId: session.id, ...payload }));
      if (alive.current && ticket === historyTicket.current) {
        setHistory(previous => acceptSshHistoryResult(previous, result));
        if (action === 'pause') showToast?.(result.paused ? '已关闭此主机命令记忆，已有历史保留' : '已开启此主机命令记忆；未就绪的终端请新建后使用');
      }
    } catch (failure) { if (alive.current) setHistoryError(failure.message); }
    finally { if (alive.current) setHistoryBusy(false); }
  };

  useEffect(() => {
    let disposed = false; let fitFrame; let resizeTimer; let clipboardPaste = false; let keyboardInput = false; let pasteRequest = 0;
    const host = hostRef.current;
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.15,
      scrollback: 2000, cursorBlink: true, cursorStyle: 'bar', convertEol: false, scrollOnUserInput: false,
      disableStdin: true, altClickMovesCursor: false, windowOptions: {}, linkHandler: { activate: event => event.preventDefault() } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host); termRef.current = term;
    term.textarea.setAttribute('aria-label', 'SSH 终端输入');
    term.textarea.setAttribute('data-ssh-terminal-input', '');
    const inline = createSshInlineController({ term, host, getContext: () => live.current, getWriter: () => writerRef.current,
      getEntries: () => historyRef.current, onPopup: setPopup,
      onFocus: focused => { void window.electronAPI.sshTerminalFocus({ sessionId: session.id, terminalId: terminal.id, focused }).catch(() => {}); } });
    inlineRef.current = inline;
    const canInput = () => !disposed && live.current.active && live.current.connected && !live.current.integrating && !live.current.replaying && !live.current.paused && !live.current.readFailed && !document.hidden && document.hasFocus();
    const sync = () => { const disabled = !canInput(); term.options.disableStdin = disabled; term.textarea.readOnly = disabled; term.textarea.setAttribute('aria-disabled', String(disabled)); inline.sync(); };
    sync();
    const resizeRemote = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (disposed || !live.current.active || !live.current.connected || document.hidden) return;
        try { sshResult(await window.electronAPI.sshTerminalResize({ sessionId: session.id, terminalId: terminal.id, cols: term.cols, rows: term.rows })); }
        catch (failure) { if (!disposed) setNotice(failure.message); }
      }, 80);
    };
    const resize = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => { if (!disposed && host.clientWidth && host.clientHeight) { fit.fit(); resizeRemote(); } });
    };
    const copy = async (selected = term.getSelection()) => {
      if (!selected) { live.current.showToast?.('请先选择终端文本'); return; }
      try { await navigator.clipboard.writeText(selected); if (!disposed) live.current.showToast?.('SSH 终端选区已复制'); }
      catch { if (!disposed) setNotice('复制失败，请使用系统复制操作'); }
    };
    const sendPaste = content => {
      if (!canInput()) return;
      term.focus(); clipboardPaste = true;
      try { term.paste(content); } finally { clipboardPaste = false; }
    };
    const requestPaste = content => {
      if (!canInput()) return;
      try {
        const checked = prepareTerminalPaste(content, 'cr');
        if (!checked.bytes) return;
        if (checked.requiresConfirmation) setPaste({ content, generation: live.current.generation }); else sendPaste(content);
      } catch (failure) { writerRef.current?.pause(failure.message); }
    };
    const pasteClipboard = async () => {
      if (!canInput()) return;
      term.focus(); const ticket = ++pasteRequest; const generation = live.current.generation;
      const stillIntended = () => ticket === pasteRequest && generation === live.current.generation && canInput() && document.activeElement === term.textarea;
      try { const text = await navigator.clipboard.readText(); if (stillIntended()) { if (!text) live.current.showToast?.('剪贴板中没有文本'); else requestPaste(text); } }
      catch { if (stillIntended()) setNotice('无法读取剪贴板，请使用系统粘贴操作'); }
    };
    const cancelClipboard = () => { pasteRequest++; };
    term.textarea.addEventListener('blur', cancelClipboard);
    const pasteEvent = event => { event.preventDefault(); event.stopImmediatePropagation(); requestPaste(event.clipboardData?.getData('text/plain') || ''); };
    host.addEventListener('paste', pasteEvent, true);
    term.attachCustomKeyEventHandler(event => {
      const clipboardAction = sshClipboardAction(event, term.hasSelection());
      if (clipboardAction) {
        event.preventDefault();
        if (event.type === 'keydown') { if (clipboardAction === 'copy') void copy(); else void pasteClipboard(); }
        return false;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r') {
        event.preventDefault(); if (event.type === 'keydown') setHistoryOpen(value => !value); return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (event.type === 'keydown') searchRef.current?.focus();
        return false;
      }
      if (!canInput()) return false;
      if (inline.key(event)) { event.preventDefault(); return false; }
      return true;
    });
    const subscriptions = [term.parser.registerOscHandler(52, () => true), term.parser.registerOscHandler(8, () => true),
      term.onKey(() => { keyboardInput = true; }),
      term.onData(data => { const userInput = keyboardInput || clipboardPaste; keyboardInput = false; if (!canInput() || document.activeElement !== term.textarea) return;
        if (!clipboardPaste && data === '\x03') writerRef.current?.interrupt(); else writerRef.current?.enqueue(data);
        readerRef.current?.requestRead();
        inline.input(data, userInput);
      }),
      term.onResize(resizeRemote)];
    const visibility = () => { sync(); if (!live.current.active || document.hidden) { cancelClipboard(); readerRef.current?.pause(); } else { readerRef.current?.start(); resize(); } };
    const windowBlur = () => { cancelClipboard(); sync(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', sync); window.addEventListener('blur', windowBlur);
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    apiRef.current = { sync, resize, copy, pasteClipboard, sendPaste,
      clear() { inline.reset(); term.clear(); term.write('\x1b[2J\x1b[H'); },
      hide() { readerRef.current?.pause(); term.blur(); Promise.resolve().then(() => { if (!disposed) { setPaste(null); setHistoryOpen(false); setContextMenu(null); } }); },
      find(text, backwards) {
        if (!text) { term.clearSelection(); return; }
        const matches = []; const buffer = term.buffer.active;
        for (let y = 0; y < buffer.length && matches.length < 500; y++) {
          const line = buffer.getLine(y); const value = line.translateToString(true); let start = 0;
          while (matches.length < 500) { const found = value.indexOf(text, start); if (found < 0) break; let chars = 0; let column = 0;
            while (column < line.length && chars < found) { chars += line.getCell(column)?.getChars().length || 0; column++; }
            let end = column; while (end < line.length && chars < found + text.length) { chars += line.getCell(end)?.getChars().length || 0; end++; }
            matches.push({ column, row: y, length: Math.max(1, end - column) }); start = found + Math.max(1, text.length); }
        }
        if (!matches.length) { setNotice('未找到匹配内容（在当前终端缓存中查找，区分大小写）'); return; }
        searchIndex.current = (searchIndex.current + (backwards ? -1 : 1) + matches.length) % matches.length;
        const found = matches[searchIndex.current]; term.select(found.column, found.row, found.length); term.scrollToLine(Math.max(0, found.row - 2));
        setNotice(`匹配 ${searchIndex.current + 1} / ${matches.length}${matches.length === 500 ? '（最多显示 500 处）' : ''}`);
      },
    };
    return () => { disposed = true; cancelClipboard(); readerRef.current?.dispose(); writerRef.current?.dispose(); inline.dispose(); inlineRef.current = null; clearTimeout(resizeTimer); cancelAnimationFrame(fitFrame); observer.disconnect(); subscriptions.forEach(item => item.dispose()); host.removeEventListener('paste', pasteEvent, true); term.textarea.removeEventListener('blur', cancelClipboard); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', sync); window.removeEventListener('blur', windowBlur); term.dispose(); apiRef.current = null; termRef.current = null; };
  }, [session.id, terminal.id]);

  useEffect(() => {
    const term = termRef.current; if (!term) return;
    term.options.theme = style === 'classic' ? { background: '#000000', foreground: '#e5e7eb', cursor: '#e5e7eb', selectionBackground: '#64748b80' }
      : isDark ? { background: '#111827', foreground: '#e5e7eb', cursor: '#34d399', selectionBackground: '#2563eb80' }
        : { background: '#f8fafc', foreground: '#0f172a', cursor: '#059669', selectionBackground: '#93c5fd80' };
  }, [isDark, style]);
  useEffect(() => {
    let disposed = false; const term = termRef.current;
    const reader = createSshTerminalReader({ sessionId: session.id, terminalId: terminal.id, api: window.electronAPI,
      write: data => new Promise(resolve => { const position = term.buffer.active.viewportY; term.write(data, () => { if (!disposed && paused.current) term.scrollToLine(position); resolve(); }); }),
      onShellIntegration: value => { if (!disposed) { live.current.integrating = value.status === 'enabling'; setShell(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); inlineRef.current?.shell(value); apiRef.current?.sync(); } },
      onShellMarker: marker => { if (!disposed) inlineRef.current?.marker(marker); },
      onReplayChange: value => { if (!disposed) { live.current.replaying = value; setReplaying(value); apiRef.current?.sync(); } },
      onTruncated: () => { if (!disposed) { inlineRef.current?.reset(); term.reset(); apiRef.current?.sync(); setNotice('SSH 较早输出已截断，仅恢复最近缓存'); } },
      onError: message => { if (!disposed) { live.current.readFailed = true; writerRef.current?.clearPending(); setError(message); apiRef.current?.sync(); } } });
    readerRef.current = reader;
    if (live.current.active && !document.hidden) reader.start();
    return () => { disposed = true; reader.dispose(); if (readerRef.current === reader) readerRef.current = null; };
  }, [session.id, terminal.id]);
  useEffect(() => {
    if (!connected) return undefined; let disposed = false;
    const writer = createSshTerminalWriter({ sessionId: session.id, terminalId: terminal.id, api: window.electronAPI,
      canWrite: () => !disposed && live.current.connected,
      onSent: () => { readerRef.current?.requestRead(); inlineRef.current?.refresh(); },
      onError: message => { if (!disposed) { live.current.paused = true; setError(message); apiRef.current?.sync(); } } });
    writerRef.current = writer; apiRef.current?.resize();
    return () => { disposed = true; writer.dispose(); if (writerRef.current === writer) writerRef.current = null; };
  }, [connected, session.id, terminal.id]);
  useEffect(() => { if (!active) apiRef.current?.hide(); else { if (!document.hidden) readerRef.current?.start(); apiRef.current?.resize(); } apiRef.current?.sync(); }, [active]);
  useEffect(() => {
    const textarea = termRef.current?.textarea; if (!textarea || !popup) return;
    textarea.setAttribute('aria-controls', `${id}-completion`); textarea.setAttribute('aria-activedescendant', `${id}-completion-${popup.index}`);
  }, [id, popup]);

  return <section aria-label={`SSH 终端 ${terminal.title || terminal.id}`} className="flex h-full min-h-0 min-w-0 flex-col gap-1.5">
<div className="flex shrink-0 flex-wrap items-center gap-1"><span className={`mr-auto text-[10px] ${theme.textMuted}`}>{!connected ? '只读 · 会话或终端未连接' : replaying ? '正在恢复输出…' : '选区 Ctrl+C 复制 · Ctrl+V 粘贴 · 右键更多'}</span><button type="button" onClick={() => { paused.current = !pausedScroll; setPausedScroll(!pausedScroll); if (pausedScroll) termRef.current?.scrollToBottom(); }} className={button} title="暂停只影响滚动，不停止接收">{pausedScroll ? <Play size={12} /> : <Pause size={12} />}{pausedScroll ? '跟随' : '暂停滚动'}</button><button type="button" aria-label="复制 SSH 终端选区" title="选区 Ctrl+C / Ctrl+Shift+C / Ctrl+Insert；无选区 Ctrl+C 仍中断远端程序" onMouseDown={event => event.preventDefault()} onClick={() => apiRef.current?.copy()} className={button}><Copy size={12} /></button><button type="button" aria-label="粘贴到 SSH 终端" title="Ctrl+V / Ctrl+Shift+V / Shift+Insert；多行先确认" onMouseDown={event => event.preventDefault()} disabled={!connected || replaying || shell.status === 'enabling' || Boolean(error)} onClick={() => apiRef.current?.pasteClipboard()} className={button}><ClipboardPaste size={12} /></button><button type="button" aria-label="清空 SSH 终端屏幕" title="仅清屏，不关闭远端程序" onClick={() => apiRef.current?.clear()} className={button}><Eraser size={12} /></button></div>
    <div className="flex shrink-0 items-center gap-1"><input ref={searchRef} aria-label="搜索 SSH 终端" value={query} onChange={event => { setQuery(event.target.value); searchIndex.current = -1; }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apiRef.current?.find(query, event.shiftKey); } }} placeholder="搜索当前终端缓存" className={`min-w-0 flex-1 rounded border px-2 py-1 text-xs ${theme.input}`} /><button type="button" aria-label="上一处 SSH 终端匹配" onClick={() => apiRef.current?.find(query, true)} className={button}><ArrowUp size={12} /></button><button type="button" aria-label="下一处 SSH 终端匹配" onClick={() => apiRef.current?.find(query, false)} className={button}><ArrowDown size={12} /></button><label className="sr-only" htmlFor={`${id}-theme`}>SSH 终端样式</label><SelectMenu id={`${id}-theme`} compact isDark={isDark} value={style} onChange={setStyle} options={[{ value: 'current', label: '当前主题' }, { value: 'classic', label: '经典黑底' }]} className="w-28" /></div>
    <div className="flex shrink-0 flex-wrap items-center gap-1"><button ref={historyAnchor} type="button" aria-expanded={historyOpen} title="Alt+R；Ctrl+R 仍是远端历史" onClick={() => setHistoryOpen(value => !value)} className={button}><History size={12} />命令历史</button>
      <button type="button" role="switch" aria-label="SSH 命令记忆" aria-checked={!history.paused} disabled={historyBusy} title="默认开启，按主机保存开关；关闭后不再保存新命令，已有历史保留" onClick={() => historyAction('pause', { paused: !history.paused })} className={button}>命令记忆：{history.paused ? '关闭' : '开启'}</button>
      {!history.paused && !['ready', 'enabling'].includes(shell.status) && onNewTerminal && <button type="button" disabled={!connected} title="在新终端自动准备命令识别，不向当前运行的程序注入命令" onClick={onNewTerminal} className={button}>新终端重试</button>}
      <span role="status" className={`min-w-0 text-[10px] ${theme.textMuted}`}>{history.paused ? '不再记录新命令 · 已保存历史仍可使用' : shell.status === 'enabling' ? '正在自动准备命令记忆…' : shell.status === 'ready' ? '记忆已就绪 · Tab 只补入，Enter 执行' : shell.error || '此终端尚未识别命令 · 新终端自动准备（Bash 4.4+）'}</span>
    </div>
    {active && historyOpen && <SshHistoryPanel anchorRef={historyAnchor} history={history} busy={historyBusy} error={historyError} theme={theme} onClose={() => setHistoryOpen(false)} onAction={historyAction} onSelect={command => {
      termRef.current?.focus(); if (inlineRef.current?.accept(command)) showToast?.('已补入终端，尚未执行'); else showToast?.('请在已识别的 Bash 提示符行尾输入匹配前缀，或清空当前输入后再补入');
    }} />}
    {!historyOpen && historyError && <p role="status" className="shrink-0 text-[10px] text-amber-500">{historyError}</p>}
    {error && <div role="alert" className="flex shrink-0 items-center gap-2 text-xs text-amber-500"><span className="min-w-0 flex-1 break-words">{error}</span><button type="button" disabled={!connected} onClick={() => { if (!writerRef.current?.resume()) return; live.current.paused = false; live.current.readFailed = false; setError(''); readerRef.current?.start(); apiRef.current?.sync(); }} className={button}>恢复输入</button></div>}
    {notice && <p role="status" className={`shrink-0 text-[10px] ${theme.textMuted}`}>{notice}</p>}
    <div className={`min-h-0 flex-1 overflow-hidden rounded p-1 ${style === 'classic' ? 'bg-black' : isDark ? 'bg-[#111827]' : 'bg-slate-50'}`}><div ref={hostRef} className="h-full min-h-0 min-w-0" onContextMenuCapture={event => {
      event.preventDefault(); event.stopPropagation();
      setHistoryOpen(false); inlineRef.current?.invalidate();
      setContextMenu({ x: event.clientX, y: event.clientY, selection: termRef.current?.getSelection() || '' });
    }} /></div>
    {active && contextMenu && <SshFileContextMenu {...contextMenu} label="SSH 终端操作" theme={theme} onClose={() => setContextMenu(null)} items={[
      { id: 'copy', label: '复制选区 · Ctrl+C', disabled: !contextMenu.selection },
      { id: 'paste', label: '粘贴 · Ctrl+V', disabled: !connected || replaying || shell.status === 'enabling' || Boolean(error) },
      { id: 'selectAll', label: '全选终端内容', separator: true },
    ]} onAction={action => {
      if (action === 'copy') { void apiRef.current?.copy(contextMenu.selection); termRef.current?.focus(); }
      else if (action === 'paste') void apiRef.current?.pasteClipboard();
      else if (action === 'selectAll') { termRef.current?.focus(); termRef.current?.selectAll(); }
    }} />}
    {active && popup && <SshInlineCompletion id={`${id}-completion`} popup={popup} theme={theme} onAccept={command => inlineRef.current?.accept(command)} />}
    {active && paste && <PasteDialog content={paste.content} host={`${session.username}@${session.host} · ${terminal.title}`} theme={theme} onClose={() => setPaste(null)} onConfirm={() => { const selected = paste; setPaste(null); if (selected.generation === live.current.generation) apiRef.current?.sendPaste(selected.content); }} />}
  </section>;
}
