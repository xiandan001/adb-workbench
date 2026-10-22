import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { inlinePlacement } from '../../shared/sshInlineCompletion';

export default function SshHistoryPanel({ anchorRef, history, busy, error, theme, onClose, onSelect, onAction }) {
  const panel = useRef(null); const [position, setPosition] = useState(null);
  const [query, setQuery] = useState('');
  const entries = history.entries.filter(entry => entry.command.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 80);
  const button = `rounded px-2 py-1 text-[10px] disabled:opacity-40 ${theme.button.secondary}`;
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect(); if (!anchor || !panel.current) return;
      setPosition(inlinePlacement({ x: anchor.left, y: anchor.top, lineHeight: anchor.height, width: 520,
        height: Math.min(280, panel.current.scrollHeight), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }));
    };
    place(); const observer = new ResizeObserver(place); observer.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  useEffect(() => {
    const outside = event => { if (!panel.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) onClose(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchorRef.current?.focus(); } };
    const visibility = () => { if (document.hidden) onClose(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); document.removeEventListener('visibilitychange', visibility); };
  }, [anchorRef, onClose]);
  return createPortal(<section ref={panel} aria-label="SSH 本地命令历史" style={{ ...position, visibility: position ? 'visible' : 'hidden', width: position?.width || 'min(520px, calc(100vw - 16px))', maxHeight: 'min(280px, calc(100vh - 16px))' }} className={`fixed z-[500] flex flex-col overflow-hidden rounded-lg border p-2 shadow-xl ${theme.card} ${theme.text}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-1"><input aria-label="搜索 SSH 命令历史" placeholder="搜索本地主机历史 · 点击只补入，不执行" value={query} onChange={event => setQuery(event.target.value)} className={`min-w-28 flex-1 rounded border px-2 py-1 text-xs ${theme.input}`} />
      <button type="button" disabled={busy} onClick={() => onAction('pause', { paused: !history.paused })} className={button}>{history.paused ? '开启记忆' : '关闭记忆'}</button>
      <button type="button" disabled={busy || !history.entries.length} onClick={() => onAction('clear')} className={button}>清空历史</button><button type="button" aria-label="收起 SSH 命令历史" onClick={onClose} className={button}><X size={12} /></button></div>
    <p className={`mt-1 shrink-0 text-[10px] ${theme.textMuted}`}>新终端默认准备 Bash 命令记忆，按主机加密保存在本机；重复命令合并。Ctrl+R 使用远端历史。{history.persistent === false ? ' 当前仅保存在内存。' : ''}{history.paused ? ' 已关闭新记录。' : ''}</p>
    <p className={`mt-1 shrink-0 text-[10px] ${theme.textMuted}`}>密码输入、行首空格、远端明确忽略的命令及明显含凭据的命令不记录；远端关闭 history 时也不记录，不导入旧历史。</p>
    {(error || history.warning) && <p role="status" className="mt-1 max-h-12 shrink-0 overflow-auto text-[10px] text-amber-500">{error || history.warning}</p>}
    <div className="mt-1 min-h-0 max-h-44 overflow-auto">{entries.map(entry => <div key={entry.id} className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => onSelect(entry.command)} title={`${entry.command}\n${new Date(entry.lastUsed).toLocaleString()} · 使用 ${entry.count} 次\n点击仅补入，不执行`} className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left font-mono text-xs hover:bg-emerald-500/10">{entry.command}</button><button type="button" aria-label={`删除历史命令 ${entry.command}`} disabled={busy} onClick={() => onAction('remove', { id: entry.id })} className={button}><Trash2 size={11} /></button></div>)}{!entries.length && <p className={`py-2 text-center text-xs ${theme.textMuted}`}>{history.entries.length ? '没有匹配的历史命令' : history.paused ? '命令记忆已关闭，开启后会记录新命令' : '暂无记录；请查看终端状态是否显示“记忆已就绪”'}</p>}</div>
  </section>, document.body);
}
