import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { confirmAppMessage } from '../shared/appMessageDialog.js';
import { formatHex } from '../shared/serialFormat.js';
import { readIpCommands, saveIpFavorite, removeIpFavorite, removeIpSendHistory, clearIpSendHistory } from '../shared/ipControlCommands.js';

const preview = hex => formatHex(hex.slice(0, 48)) + (hex.length > 48 ? ' …' : '');
function commandError(error) {
  switch (error?.code) {
    case 'INVALID_NAME': return tr('常用命令名称应为 1 至 80 个字符');
    case 'NAME_EXISTS': return tr('常用命令名称重复，请使用其他名称。');
    case 'FAVORITE_LIMIT': return tr('最多可保存 32 条常用命令。');
    default: return tr('常用命令或发送历史未能保存，原记录已保留。');
  }
}
export default function IpControlSavedCommands({ theme, draft, revision, onFill }) {
  const [open, setOpen] = useState(false), [changes, setChanges] = useState(0);
  const [name, setName] = useState(''), [editing, setEditing] = useState(null), [error, setError] = useState('');
  const id = useId(), locale = useLocale(), mounted = useRef(null);
  useEffect(() => { mounted.current = {}; return () => { mounted.current = null; }; }, []);
  const store = useMemo(() => {
    // Successful writes and edits invalidate this bounded, local-only view.
    void revision; void changes;
    if (open) { try { return readIpCommands(); } catch { return { favorites: [], history: [], failed: true }; } }
    return { favorites: [], history: [] };
  }, [open, revision, changes]);
  const button = `inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  function change(fn) {
    try { fn(); setChanges(v => v + 1); setError(''); return true; } catch (failure) { setError(commandError(failure)); return false; }
  }
  async function clear() {
    const owner = mounted.current;
    if (await confirmAppMessage({ type: 'warning', title: tr('清空发送历史'), message: tr('只清空 IP Control 的发送历史，不影响串口、常用命令或收发记录。'), confirmLabel: tr('清空') }) && owner && mounted.current === owner) change(clearIpSendHistory);
  }
  return <div className="min-w-0"><button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)} className={`inline-flex items-center gap-1.5 rounded py-1 text-xs ${theme.textMuted}`}><ChevronDown size={13} className={open ? '' : '-rotate-90'} /><Star size={13}/>{tr('常用命令 / 发送历史')}</button>
    {open && <div id={id} className="mt-1 space-y-3 rounded-lg border border-slate-400/20 p-3">
      <p className={`text-xs ${theme.textMuted}`}>{tr('常用命令与发送历史仅用于 IP Control。')}{tr('仅填入发送区，不会自动发送。')}</p>
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (change(() => saveIpFavorite({ ...(editing ? {id:editing.id} : {}), name, hex: editing ? editing.hex : draft }))) { setName(''); setEditing(null); } }}>
        <input value={name} onChange={e=>setName(e.target.value)} maxLength={80} aria-label={tr('常用命令名称')} placeholder={editing ? tr('编辑常用命令名称') : tr('给当前发送内容起个名字')} className={`min-w-0 flex-1 basis-44 rounded-lg border px-3 py-2 text-xs ${theme.input}`}/>
        <button type="submit" disabled={!name.trim() || (!editing && (!draft || store.favorites.length >= 32))} className={button}><Plus size={13}/>{editing ? tr('保存修改') : tr('保存常用命令')}</button>
        {editing && <button type="button" className={button} onClick={()=>{setEditing(null);setName('');setError('');}}><X size={13}/>{tr('取消编辑')}</button>}
      </form>
      {(error || store.failed) && <p role="alert" className="text-xs text-amber-600">{error || tr('无法读取 IP Control 的常用命令和发送历史。')}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0"><h4 className={`mb-2 text-xs ${theme.textMuted}`}>{tr('常用命令')} · {store.favorites.length}/32</h4><div className="max-h-44 space-y-1 overflow-auto">
          {store.favorites.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg bg-slate-400/10 p-1">
            <button type="button" title={tr('仅回填，不发送')} onClick={() => onFill(item.hex)} className="min-w-0 flex-1 rounded px-2 py-1 text-left"><span className="block truncate text-xs">{item.name}</span><code className={`block truncate text-[11px] ${theme.textMuted}`}>{preview(item.hex)}</code></button>
            <button type="button" aria-label={tr('编辑常用命令 {0}', {0:item.name})} className="rounded p-2" onClick={()=>{setEditing(item);setName(item.name);}}><Pencil size={13}/></button>
            <button type="button" aria-label={tr('删除常用命令 {0}', {0:item.name})} className="rounded p-2 hover:text-red-500" onClick={()=>{if(change(()=>removeIpFavorite(item.id)) && editing?.id===item.id){setEditing(null);setName('');}}}><Trash2 size={13}/></button>
          </div>)}{!store.favorites.length && <p className={`py-2 text-xs ${theme.textMuted}`}>{tr('暂无常用命令')}</p>}</div></div>
        <div className="min-w-0"><div className={`mb-2 flex items-center gap-1 text-xs ${theme.textMuted}`}><Clock size={12}/><h4>{tr('发送历史')} · {store.history.length}/20</h4>
          {store.history.length > 0 && <button type="button" onClick={clear} aria-label={tr('清空发送历史')} className="ml-auto underline">{tr('清空')}</button>}</div>
        <div className="max-h-44 space-y-1 overflow-auto">{store.history.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg bg-slate-400/10 p-1">
          <button type="button" title={tr('仅回填，不发送')} onClick={()=>onFill(item.hex)} className="min-w-0 flex-1 rounded px-2 py-1 text-left">
            <span className={`block break-all text-[11px] ${theme.textMuted}`}>{item.mode==='udp'?tr('UDP'):item.mode==='tcp-server'?tr('TCP Server'):tr('TCP Client')} · {item.host.includes(':') ? `[${item.host}]` : item.host}:{item.port} · {new Date(item.at).toLocaleTimeString(locale)}</span><code className="block truncate text-xs">{preview(item.hex)}</code></button>
          <button type="button" aria-label={tr('删除发送记录')} className="rounded p-2 hover:text-red-500" onClick={()=>change(()=>removeIpSendHistory(item.id))}><Trash2 size={13}/></button>
        </div>)}{!store.history.length && <p className={`py-2 text-xs ${theme.textMuted}`}>{tr('暂无发送历史')}</p>}</div></div>
      </div>
    </div>}
  </div>;
}
