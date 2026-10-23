import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSearch, Loader2, MessageSquare, Search } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { quotaValue, sessionDetailFor } from './aiToolsModel';

const PAGE_SIZE = 50;
const ROLES = { user: '用户', assistant: '助手', system: '系统', tool: '工具' };
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '—';
export default function AiSessionsPanel({ onRequest, tools, canScan, canOpen, theme, isDark }) {
  const id = useId(); const alive = useRef(true); const listTicket = useRef(0); const detailTicket = useRef(0); const selectedRef = useRef('');
  const [listing, setListing] = useState({ sessions: [], count: 0, offset: 0, scannedAt: null, roots: [] });
  const [loading, setLoading] = useState(false); const [scanning, setScanning] = useState(false); const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState(''); const [toolId, setToolId] = useState(''); const filters = useRef({ search: '', toolId: '' });
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState(''); const [selected, setSelected] = useState(null); const [detail, setDetail] = useState(null); const [usagePage, setUsagePage] = useState(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const toolName = value => tools.find(tool => tool.id === value)?.label || value;
  const loadList = useCallback(async (nextFilters, offset = 0) => {
    const ticket = ++listTicket.current; detailTicket.current++; selectedRef.current = ''; setSelected(null); setDetail(null); setDetailError(''); setDetailLoading(false); setLoading(true); setError('');
    try {
      const result = await onRequest('sessions_list', { ...nextFilters, offset });
      if (!Array.isArray(result?.sessions)) throw new Error('会话列表格式无效');
      if (alive.current && ticket === listTicket.current) { filters.current = nextFilters; setListing(result); }
    } catch (failure) { if (alive.current && ticket === listTicket.current) setError(failure.message); }
    finally { if (alive.current && ticket === listTicket.current) setLoading(false); }
  }, [onRequest]);
  useEffect(() => { alive.current = true; void loadList({ search: '', toolId: '' }); return () => { alive.current = false; }; }, [loadList]);
  const scan = async () => {
    if (scanning || loading || detailLoading) return; setScanning(true); setError('');
    try { await onRequest('sessions_scan', {}); if (alive.current) { setUsagePage(0); await loadList({ search, toolId }); } }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setScanning(false); }
  };
  const open = async (session, offset = 0) => {
    if (!canOpen || scanning) return; const ticket = ++detailTicket.current;
    selectedRef.current = session.id; setSelected(session); setDetail(null); setDetailError(''); setDetailLoading(true);
    try {
      const result = await onRequest('sessions_open', { id: session.id, offset });
      if (!alive.current || ticket !== detailTicket.current) return;
      const accepted = sessionDetailFor(result, selectedRef.current);
      if (!accepted) throw new Error('会话结果与当前选择不一致，未显示内容');
      setDetail(accepted);
    } catch (failure) { if (alive.current && ticket === detailTicket.current) setDetailError(failure.message); }
    finally { if (alive.current && ticket === detailTicket.current) setDetailLoading(false); }
  };
  const currentOffset = listing.offset || 0;
  const availableTools = [...new Set((listing.roots || []).map(root => root.toolId))];
  const models = listing.usage?.models || []; const modelPage = Math.min(usagePage, Math.max(0, Math.ceil(models.length / 25) - 1));
  return <section aria-label="AI 会话与本机用量" className="space-y-3">
    <div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">本机会话，只读查看</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>打开页面不会扫描文件。点击扫描后读取下列工具目录，不修改、不删除源会话，也不会执行其中的内容。</p></div><button type="button" disabled={!canScan || scanning || loading || detailLoading} onClick={scan} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{scanning ? <Loader2 size={14} className="animate-spin" /> : <FileSearch size={14} />}{scanning ? '正在扫描本机会话…' : '扫描本机会话'}</button></div>
      <details className={`mt-3 text-xs ${theme.textMuted}`}><summary className="cursor-pointer">查看扫描范围（不会读取登录凭据）</summary><div className="mt-2 space-y-1">{(listing.roots || []).map(root => <p key={`${root.toolId}:${root.root}`} className="break-all">{toolName(root.toolId)}：{root.root}</p>)}</div></details>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void loadList({ search, toolId }); }}><input aria-label="搜索 AI 本机会话" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} disabled={scanning || loading} placeholder="搜索标题、工作目录或模型" className={`min-w-40 flex-1 rounded-lg border px-3 py-2 text-xs ${theme.input}`} /><label htmlFor={id} className="sr-only">AI 会话工具筛选</label><SelectMenu id={id} value={toolId} options={[{ value: '', label: '全部扫描工具' }, ...availableTools.map(value => ({ value, label: toolName(value) }))]} onChange={value => { setToolId(value); void loadList({ search, toolId: value }); }} disabled={scanning || loading} isDark={isDark} compact className="w-40" /><button type="submit" disabled={scanning || loading} className={button}><Search size={13} />搜索</button></form>
      <p role="status" className={`mt-3 text-[11px] ${theme.textMuted}`}>{listing.scannedAt ? `最近扫描：${date(listing.scannedAt)} · 当前筛选 ${listing.count} 个会话${listing.skipped ? ` · 跳过 ${listing.skipped} 项` : ''}` : '尚未扫描，不会自动读取你的历史文件。'}{listing.incomplete ? ' · 已达到扫描边界，结果不完整' : ''}</p>
      {error && <p role="alert" className="mt-2 break-words text-xs text-red-500">{error}</p>}
    </div>
    <div className="grid gap-3 lg:grid-cols-[minmax(230px,0.8fr)_minmax(0,1.2fr)]">
      <div className={`min-w-0 overflow-hidden rounded-xl border ${theme.card}`}><div aria-label="AI 本机会话列表" className="max-h-[480px] overflow-auto">{listing.sessions.map(session => <button key={session.id} type="button" aria-pressed={selected?.id === session.id} disabled={!canOpen || scanning || loading} onClick={() => open(session)} className={`block w-full min-w-0 border-b border-slate-400/15 p-3 text-left disabled:opacity-40 ${selected?.id === session.id ? 'bg-emerald-500/10' : 'hover:bg-slate-400/5'}`}><p className="truncate text-xs font-medium" title={session.title}>{session.title || session.sessionId || '未命名会话'}</p>{session.imported === true && <span className={`mt-1 inline-flex rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>迁移归档 · 只读</span>}<p className={`mt-1 truncate text-[11px] ${theme.textMuted}`}>{toolName(session.toolId)} · {session.model || '未知模型'} · {session.messageCount} 条消息</p><p className={`mt-1 truncate text-[10px] ${theme.textMuted}`} title={session.cwd}>{session.cwd || session.path}</p><p className={`mt-1 text-[10px] ${theme.textMuted}`}>{date(session.updatedAt || session.modifiedAt)}</p></button>)}{loading && <p className={`p-5 text-center text-xs ${theme.textMuted}`}>正在读取索引…</p>}{!loading && !listing.sessions.length && <p className={`p-6 text-center text-xs ${theme.textMuted}`}>{listing.scannedAt ? '没有匹配的会话' : '点击扫描后显示会话列表'}</p>}</div><div className="flex items-center gap-2 border-t border-slate-400/15 p-2"><button type="button" aria-label="上一页 AI 会话" disabled={!currentOffset || scanning || loading} onClick={() => loadList(filters.current, Math.max(0, currentOffset - PAGE_SIZE))} className={button}><ChevronLeft size={13} /></button><span className={`flex-1 text-center text-[11px] ${theme.textMuted}`}>每页 50 条 · 第 {Math.floor(currentOffset / PAGE_SIZE) + 1} 页</span><button type="button" aria-label="下一页 AI 会话" disabled={!listing.hasMore || scanning || loading} onClick={() => loadList(filters.current, currentOffset + PAGE_SIZE)} className={button}><ChevronRight size={13} /></button></div></div>
      <section aria-label="AI 会话纯文本阅读" className={`min-w-0 overflow-hidden rounded-xl border ${theme.card}`}><div className="flex items-center gap-2 border-b border-slate-400/15 p-3"><MessageSquare size={14} /><h4 className="min-w-0 flex-1 truncate text-xs font-semibold">{selected?.title || '选择一个会话阅读'}</h4></div>{detailError && <p role="alert" className="p-3 text-xs text-red-500">{detailError}</p>}<div className="max-h-[480px] space-y-3 overflow-auto p-3">{detailLoading ? <p className={`py-5 text-center text-xs ${theme.textMuted}`}>正在读取会话…</p> : detail ? detail.messages.map((message, index) => <article key={`${message.id || index}:${detail.offset || 0}`} className="rounded-lg border border-slate-400/20 p-3"><p className={`mb-2 text-[11px] ${theme.textMuted}`}>{ROLES[message.role] || message.role} · {date(message.timestamp)}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-6">{message.text}</pre>{message.truncated && <p className="mt-2 text-[10px] text-amber-500">此条内容已达到显示长度上限</p>}</article>) : <p className={`py-8 text-center text-xs ${theme.textMuted}`}>纯文本显示，不执行脚本、链接或工具调用。</p>}</div>{detail && <div className="flex items-center gap-2 border-t border-slate-400/15 p-2"><button type="button" aria-label="上一页 AI 会话消息" disabled={!detail.offset || detailLoading || scanning} onClick={() => open(selected, Math.max(0, detail.offset - PAGE_SIZE))} className={button}><ChevronLeft size={13} /></button><span className={`flex-1 text-center text-[11px] ${theme.textMuted}`}>{detail.messageCount} 条消息 · 第 {Math.floor((detail.offset || 0) / PAGE_SIZE) + 1} 页{detail.truncated ? ' · 内容已截断' : ''}{detail.invalidLines ? ` · ${detail.invalidLines} 行无法解析` : ''}</span><button type="button" aria-label="下一页 AI 会话消息" disabled={!detail.hasMore || detailLoading || scanning} onClick={() => open(selected, (detail.offset || 0) + PAGE_SIZE)} className={button}><ChevronRight size={13} /></button></div>}</section>
    </div>
    {listing.scannedAt && <section aria-label="AI 本机 Token 用量" className={`min-w-0 rounded-xl border p-4 ${theme.card}`}><h3 className="text-sm font-semibold">本次扫描全部会话的本机 Token</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{listing.usage?.note || '本地文件中的 Token，不代表服务商余额、套餐额度或最终账单。'} 此汇总不随上方列表筛选变化；未知项显示“—”。</p><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className={theme.textMuted}><tr>{['工具 / 模型', '输入', '输出', '缓存读取', '缓存写入'].map(label => <th key={label} className="whitespace-nowrap px-2 py-2 font-normal">{label}</th>)}</tr></thead><tbody>{models.slice(modelPage * 25, modelPage * 25 + 25).map(model => <tr key={`${model.toolId}:${model.model}`} className="border-t border-slate-400/15"><th className="max-w-64 break-words px-2 py-2 font-normal">{toolName(model.toolId)} · {model.model}</th>{['input', 'output', 'cached', 'cacheWrite'].map(key => <td key={key} className="whitespace-nowrap px-2 py-2">{quotaValue(model[key])}</td>)}</tr>)}</tbody></table></div>{!models.length && <p className={`py-4 text-center text-xs ${theme.textMuted}`}>未从当前扫描文件中获得可确认的 Token 数据</p>}<div className="mt-2 flex items-center gap-2"><span className={`flex-1 text-[11px] ${theme.textMuted}`}>{listing.usage?.sessionsWithUsage || 0} 个会话带用量记录 · {models.length} 个模型条目</span>{models.length > 25 && <><button type="button" aria-label="上一页 AI 本机用量" disabled={!modelPage} onClick={() => setUsagePage(modelPage - 1)} className={button}><ChevronLeft size={13} /></button><button type="button" aria-label="下一页 AI 本机用量" disabled={(modelPage + 1) * 25 >= models.length} onClick={() => setUsagePage(modelPage + 1)} className={button}><ChevronRight size={13} /></button></>}</div></section>}
  </section>;
}
