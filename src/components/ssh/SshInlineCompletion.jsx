import { createPortal } from 'react-dom';

export default function SshInlineCompletion({ id, popup, theme, onAccept }) {
  if (!popup?.entries.length) return null;
  return createPortal(<div className={`fixed z-[1000] overflow-hidden rounded-lg border shadow-xl ${theme.card} ${theme.text}`} style={popup.placement}>
    <div id={id} role="listbox" aria-label="SSH 命令补全候选" className="max-h-56 overflow-auto py-1">
      {popup.entries.map((entry, index) => <button id={`${id}-${index}`} key={entry.id || entry.command} type="button" role="option" aria-selected={index === popup.index}
        onMouseDown={event => event.preventDefault()} onClick={() => onAccept(entry.command)}
        className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${index === popup.index ? 'bg-emerald-500/20' : ''}`} title={entry.command}>
        <span className="opacity-60">{popup.prefix}</span><span>{entry.command.slice(popup.prefix.length)}</span>
      </button>)}
    </div><p className={`border-t border-slate-400/20 px-3 py-1 text-[10px] ${theme.textMuted}`}>↑↓ 选择 · Tab 补入 · Enter 执行原输入 · Esc 关闭</p>
  </div>, document.body);
}
