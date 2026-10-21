import { useId, useMemo, useState } from 'react';
import { ChevronDown, Clock, Pencil, Plus, Send, Star, Trash2, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { encodeMessage } from '../shared/serialSettings';

export default function SerialSendPanel({ theme, isDark, preferences, onPreferences, draft, onDraft, commandsOpen, onCommandsOpen, connected, sending, onSend, history }) {
  const id = useId();
  const [favoriteName, setFavoriteName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [favoriteError, setFavoriteError] = useState('');
  const { sendMode: mode, lineEnding, favorites } = preferences;
  const message = useMemo(() => ({ mode, content: draft, lineEnding }), [mode, draft, lineEnding]);
  const validation = useMemo(() => {
    try { return { bytes: encodeMessage(message).length, error: '' }; }
    catch (error) { return { bytes: 0, error: error.message }; }
  }, [message]);
  const field = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const button = `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const sendDisabled = !connected || sending || Boolean(validation.error);
  const fill = item => {
    onDraft(item.content);
    onPreferences({ sendMode: item.mode, lineEnding: item.lineEnding });
    setFavoriteError('');
  };
  const saveFavorite = async () => {
    setFavoriteError('');
    if (!favoriteName.trim()) { setFavoriteError('请输入常用命令名称'); return; }
    if (validation.error) { setFavoriteError(validation.error); return; }
    const item = { id: editingId || crypto.randomUUID(), name: favoriteName.trim(), ...message };
    const next = editingId ? favorites.map(previous => previous.id === editingId ? item : previous) : [...favorites, item];
    if (await onPreferences({ favorites: next })) { setEditingId(''); setFavoriteName(''); }
  };
  const submit = () => { if (!sendDisabled) onSend(message); };

  return <div className="space-y-2 border-t border-slate-400/20 pt-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">发送数据</h3><div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`${id}-mode`}>发送格式</label><SelectMenu id={`${id}-mode`} isDark={isDark} compact value={mode} disabled={sending} onChange={sendMode => onPreferences({ sendMode })} options={[{ value: 'text', label: '文本 UTF-8' }, { value: 'hex', label: 'HEX' }]} className="w-28" />
      <label className="sr-only" htmlFor={`${id}-ending`}>发送换行符</label><SelectMenu id={`${id}-ending`} isDark={isDark} compact value={mode === 'hex' ? 'none' : lineEnding} disabled={sending || mode === 'hex'} onChange={value => onPreferences({ lineEnding: value })} options={[{ value: 'none', label: '不追加换行' }, { value: 'lf', label: '追加 LF' }, { value: 'cr', label: '追加 CR' }, { value: 'crlf', label: '追加 CRLF' }]} className="w-32" />
    </div></div>
    <textarea aria-label="串口发送内容" value={draft} rows={3} maxLength={1048576} spellCheck={false} onChange={event => onDraft(event.target.value)} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={mode === 'hex' ? '例如：01 03 00 00 00 01（只发送这些字节）' : '输入发送内容；Enter 换行，Ctrl+Enter 发送'} className={`${field} resize-y font-mono text-xs`} />
    <div className="flex flex-wrap items-center justify-between gap-2"><div className={`min-w-0 flex-1 text-xs ${theme.textMuted}`}><span>{draft && validation.error ? <span role="alert" className="text-amber-500">{validation.error}</span> : `待发送 ${validation.bytes.toLocaleString()} B · 单次最多 64 KiB`}</span><p className="mt-1 text-[11px]">{mode === 'hex' ? 'HEX 严格发送原始字节，不追加换行。' : 'UTF-8 编码，仅追加所选换行符一次。'}写入成功不代表设备已执行或回应。</p></div><button type="button" disabled={sendDisabled} onClick={submit} className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Send size={14} />{sending ? '写入中…' : '发送'}<span className="hidden text-[10px] opacity-75 sm:inline">Ctrl+Enter</span></button></div>
    <button type="button" aria-expanded={commandsOpen} aria-controls={`${id}-commands`} onClick={() => onCommandsOpen(!commandsOpen)} className={`inline-flex items-center gap-1.5 rounded py-1 text-xs ${theme.textMuted}`}><ChevronDown size={13} className={commandsOpen ? '' : '-rotate-90'} /><Star size={13} />常用命令 / 发送历史</button>
    {commandsOpen && <div id={`${id}-commands`} className="space-y-3 rounded-lg border border-slate-400/20 p-3">
      <p className={`text-xs ${theme.textMuted}`}>点击仅回填编辑区，不会发送。常用命令可随数据导出迁移；历史仅保存在本机。</p>
      <div className="flex flex-wrap gap-2"><input aria-label="常用命令名称" value={favoriteName} maxLength={80} onChange={event => setFavoriteName(event.target.value)} placeholder={editingId ? '编辑常用命令名称' : '给当前发送内容起个名字'} className={`${field} min-w-0 flex-1 basis-48`} /><button type="button" onClick={saveFavorite} disabled={!draft || Boolean(validation.error) || (!editingId && favorites.length >= 30)} className={button}><Plus size={13} />{editingId ? '保存修改' : '保存常用命令'}</button>{editingId && <button type="button" onClick={() => { setEditingId(''); setFavoriteName(''); setFavoriteError(''); }} className={button}><X size={13} />取消编辑</button>}</div>
      {favoriteError && <p role="alert" className="text-xs text-amber-500">{favoriteError}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0"><h4 className={`mb-2 text-xs ${theme.textMuted}`}>常用命令（{favorites.length}/30）</h4><div className="max-h-40 overflow-auto space-y-1">{favorites.length ? favorites.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg bg-slate-400/10 p-1"><button type="button" onClick={() => { fill(item); setEditingId(''); setFavoriteName(''); }} className="min-w-0 flex-1 px-2 py-1 text-left" title={`${item.name} · ${item.mode.toUpperCase()} · 仅回填`}><span className="block truncate text-xs">{item.name}</span><span className={`block truncate font-mono text-[11px] ${theme.textMuted}`}>{item.mode.toUpperCase()} · {item.content.slice(0, 80)}</span></button><button type="button" aria-label={`编辑常用命令 ${item.name}`} onClick={() => { fill(item); setEditingId(item.id); setFavoriteName(item.name); }} className="rounded p-2"><Pencil size={13} /></button><button type="button" aria-label={`删除常用命令 ${item.name}`} onClick={async () => { if (await onPreferences({ favorites: favorites.filter(previous => previous.id !== item.id) }) && editingId === item.id) { setEditingId(''); setFavoriteName(''); } }} className="rounded p-2"><Trash2 size={13} /></button></div>) : <p className={`py-2 text-xs ${theme.textMuted}`}>暂无常用命令</p>}</div></div>
        <div className="min-w-0"><h4 className={`mb-2 flex items-center gap-1 text-xs ${theme.textMuted}`}><Clock size={12} />最近成功发送（{history.length}/50）</h4><div className="max-h-40 space-y-1 overflow-auto">{history.length ? history.map((item, index) => <button type="button" key={`${item.time}-${index}`} onClick={() => { fill(item); setEditingId(''); setFavoriteName(''); }} title="仅回填，不发送" className="block w-full rounded-lg bg-slate-400/10 px-3 py-2 text-left"><span className={`block text-[11px] ${theme.textMuted}`}>{new Date(item.time).toLocaleString()} · {item.mode.toUpperCase()}</span><span className="mt-1 block truncate font-mono text-xs">{item.content.slice(0, 120)}</span></button>) : <p className={`py-2 text-xs ${theme.textMuted}`}>成功写入串口后会出现在这里</p>}</div></div>
      </div>
    </div>}
  </div>;
}
