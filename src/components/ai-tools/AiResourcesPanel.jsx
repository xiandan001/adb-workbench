import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FileDiff, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiResourceForm from './AiResourceForm';
import AiToolsDialog from './AiToolsDialog';

export default function AiResourcesPanel({ kind, active = true, refreshKey, onRequest, can, onPreview, theme, isDark, showToast }) {
  const id = useId(); const isMcp = kind === 'mcp'; const label = isMcp ? 'MCP' : '提示词'; const prefix = `resources_${kind}`;
  const [data, setData] = useState(null); const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const pending = useRef(false);
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [operation, setOperation] = useState(null); const [search, setSearch] = useState(''); const [error, setError] = useState('');
  const alive = useRef(true); const ticket = useRef(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const load = useCallback(async () => {
    const current = ++ticket.current; setLoading(true);
    try { const result = await onRequest('resources_snapshot', {}); if (!Array.isArray(result?.mcpServers) || !Array.isArray(result?.prompts) || !Array.isArray(result?.tools)) throw new Error('资源库状态格式无效'); if (alive.current && current === ticket.current) setData(result); }
    finally { if (alive.current && current === ticket.current) setLoading(false); }
  }, [onRequest]);
  useEffect(() => { alive.current = true; void load().catch(failure => { if (alive.current) setError(failure.message); }); return () => { alive.current = false; }; }, [load, refreshKey]);
  const save = async value => {
    const result = await onRequest(`${prefix}_save`, { [kind]: value });
    if (alive.current) { try { await load(); } catch (failure) { setError(`已保存，但刷新失败：${failure.message}`); } showToast?.(`${label}已保存到本软件资源库，尚未自动改写工具配置`); }
    return result;
  };
  const removeRecord = async () => {
    if (!remove || pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      await onRequest(`${prefix}_remove`, { [isMcp ? 'mcpId' : 'promptId']: remove.id });
      if (alive.current) { setRemove(null); try { await load(); } catch (failure) { setError(`已删除库记录，但刷新失败：${failure.message}`); } showToast?.(`${label}库记录已删除，未删除其他工具数据`); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const items = (isMcp ? data?.mcpServers : data?.prompts) || [];
  const visible = items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  const supported = (data?.tools || []).filter(tool => isMcp ? tool.mcpSupported : tool.promptSupported);
  const targetTools = operation?.enabled === false ? supported.filter(tool => operation.item.applications.includes(tool.id)) : supported;
  const target = targetTools.find(tool => tool.id === operation?.toolId) || targetTools[0];
  const replacedPrompt = !isMcp && operation?.enabled && target ? data.prompts.find(item => item.id !== operation.item.id && item.applications.includes(target.id)) : null;
  const preview = async () => {
    if (!operation || !target || pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      const result = await onRequest(`${prefix}_preview`, { toolId: target.id, [isMcp ? 'mcpId' : 'promptId']: operation.item.id, enabled: operation.enabled });
      if (alive.current) { onPreview(result); setOperation(null); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section aria-label={`AI ${label}资源库`} className="space-y-3"><div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{label} 资源库</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{isMcp ? '保存命令或服务配置，再预览启用到指定工具；此页面不执行 MCP 命令。' : '先编辑提示词库，再预览启用到指定工具；只替换本软件管理块，保留原有用户文字。'}</p></div><button type="button" aria-label={`刷新 AI ${label}资源库`} disabled={loading || busy} onClick={() => { setError(''); void load().catch(failure => setError(failure.message)); }} className={button}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button><button type="button" disabled={!can(`${prefix}_save`) || busy} onClick={() => setForm({ item: null })} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Plus size={14} />添加 {label}</button></div><input aria-label={`搜索 AI ${label}`} placeholder="搜索名称或描述" value={search} onChange={event => setSearch(event.target.value)} className={`mt-3 w-full rounded-lg border px-3 py-2 text-xs ${theme.input}`} />
    {data?.warning && <p className="mt-2 text-xs text-amber-500">{data.warning}</p>}{error && <p role="alert" className="mt-2 break-words text-xs text-red-500">{error}</p>}</div>
    <div className="grid gap-3 xl:grid-cols-2">{visible.map(item => <article key={item.id} aria-label={`AI ${label} ${item.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}><h4 className="text-sm font-semibold">{item.name}</h4>{item.description && <p className={`mt-1 break-words text-xs ${theme.textMuted}`}>{item.description}</p>}{isMcp ? <><p className="mt-3 truncate font-mono text-xs" title={item.command || item.url}>{item.type} · {item.command || item.url}</p><p className={`mt-1 break-all font-mono text-[11px] ${theme.textMuted}`}>工具配置键：{item.key}</p><p className={`mt-1 text-[11px] ${theme.textMuted}`}>环境变量 {(item.envKeys || []).length} 项 · 请求头 {(item.headerKeys || []).length} 项{item.hasSecrets ? ' · 原值不回显' : ''}</p></> : <pre className={`mt-3 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-sans text-xs leading-5 ${theme.textMuted}`}>{item.content.slice(0, 400)}{item.content.length > 400 ? '…' : ''}</pre>}<p className={`mt-3 text-xs ${theme.textMuted}`}>已应用：{item.applications.length ? item.applications.map(value => data.tools.find(tool => tool.id === value)?.name || value).join('、') : '尚未应用到工具'}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!can(`${prefix}_preview`) || busy} onClick={() => { setError(''); setOperation({ item, toolId: '', enabled: true }); }} className={button}><FileDiff size={13} />应用 / 停用</button><button type="button" aria-label={`编辑 ${label} ${item.name}`} disabled={!can(`${prefix}_save`) || busy} onClick={() => setForm({ item })} className={button}><Pencil size={13} /></button><button type="button" aria-label={`删除 ${label} ${item.name}`} title={item.applications.length ? '请先预览并停用所有已应用工具，再删除库记录' : '仅删除本软件库记录'} disabled={!can(`${prefix}_remove`) || busy || item.applications.length > 0} onClick={() => { setError(''); setRemove(item); }} className={button}><Trash2 size={13} /></button></div></article>)}</div>
    {!loading && !visible.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>{items.length ? '没有匹配的资源' : `暂无 ${label}，可先添加到本软件资源库。`}</p>}
    {active && form && <AiResourceForm key={`${kind}:${form.item?.id || 'new'}`} kind={kind} item={form.item} theme={theme} isDark={isDark} onSave={save} onClose={() => setForm(null)} />}
    {active && operation && <AiToolsDialog title={`选择 ${label} 应用目标`} theme={theme} busy={busy} onClose={() => setOperation(null)}><p className="mb-3 text-sm font-medium">{operation.item.name}</p><label htmlFor={`${id}-action`} className="text-xs">操作</label><SelectMenu id={`${id}-action`} value={operation.enabled ? 'enable' : 'disable'} options={[{ value: 'enable', label: '启用 / 更新到目标工具' }, { value: 'disable', label: '明确停用本资源' }]} onChange={value => setOperation(previous => ({ ...previous, enabled: value === 'enable', toolId: '' }))} isDark={isDark} disabled={busy} className="mb-3 mt-1" /><label htmlFor={`${id}-target`} className="text-xs">目标工具</label><SelectMenu id={`${id}-target`} value={target?.id || ''} options={targetTools.map(tool => ({ value: tool.id, label: `${tool.name}${operation.item.applications.includes(tool.id) ? '（已应用）' : ''}` }))} onChange={toolId => setOperation(previous => ({ ...previous, toolId }))} isDark={isDark} disabled={busy} emptyText="没有可操作的目标工具" className="mt-1" />{replacedPrompt && <p className="mt-3 text-xs text-amber-500">此工具已应用“{replacedPrompt.name}”，将替换本应用提示词管理块；用户其他内容保留。</p>}<p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>下一步展示真实目标路径及脱敏变更，确认后才写入。{isMcp ? '目标工具下次加载配置时可能启动 MCP 命令或连接服务。' : ''}</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setOperation(null)} className={button}>取消</button><button type="button" disabled={!target || busy} onClick={preview} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{busy && <Loader2 size={13} className="animate-spin" />}预览{operation.enabled ? '启用' : '停用'}</button></div></AiToolsDialog>}
    {active && remove && <AiToolsDialog title={`删除 ${label}？`} theme={theme} busy={busy} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs ${theme.textMuted}`}>仅删除本软件中的库记录，不删除其他配置或用户文件。</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setRemove(null)} className={button}>取消</button><button type="button" disabled={busy} onClick={removeRecord} className="rounded-lg bg-red-500 px-3 py-2 text-xs text-white disabled:opacity-40">确认删除{label}</button></div></AiToolsDialog>}
  </section>;
}
