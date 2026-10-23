import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Loader2, Pencil, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import AiRouteForm from './AiRouteForm';
import AiToolsDialog from './AiToolsDialog';
import { AI_PROTOCOLS } from './aiToolsModel';

export default function AiRouterPanel({ active = true, providers, tools, onRequest, can, onProvidersChanged, theme, isDark, showToast }) {
  const [status, setStatus] = useState(null); const [port, setPort] = useState(''); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [profile, setProfile] = useState(null); const [targets, setTargets] = useState([]);
  const alive = useRef(true); const pending = useRef(false); const ticket = useRef(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const running = status?.running || status?.starting;
  const load = useCallback(async () => {
    const current = ++ticket.current;
    const result = await onRequest('router_status', {});
    if (!Array.isArray(result?.routes)) throw new Error('本地路由状态格式无效');
    if (alive.current && current === ticket.current) { setStatus(result); setPort(String(result.port)); }
    return result;
  }, [onRequest]);
  useEffect(() => { alive.current = true; void load().catch(failure => { if (alive.current) setError(failure.message); }); return () => { alive.current = false; }; }, [load]);
  const act = async (command, args = {}, { rethrow = false } = {}) => {
    if (pending.current) return; pending.current = true; setBusy(command); setError('');
    try {
      const result = await onRequest(command, args);
      if (alive.current) {
        if (command === 'router_copy_key') { if (result?.copied !== true) throw new Error('没有收到密钥复制确认'); showToast?.('本地路由密钥已复制，请勿公开分享'); }
        else { if (command === 'router_status') { setStatus(result); setPort(String(result.port)); } else await load(); if (command === 'router_profile') { await onProvidersChanged(); showToast?.('本机路由供应商已保存，尚未改写任何工具配置'); } }
      }
      return result;
    } catch (failure) { if (alive.current) setError(failure.message); if (rethrow) throw failure; }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  };
  const start = () => {
    const number = Number(port);
    if (!Number.isSafeInteger(number) || number < 1024 || number > 65535) { setError('端口必须是 1024–65535 的整数'); return; }
    void act('router_start', { port: number });
  };
  const copyUrl = async route => {
    try { await navigator.clipboard.writeText(`${status.url}/${route.protocol === 'gemini' ? 'v1beta' : 'v1'}`); showToast?.('本机路由地址已复制'); }
    catch { setError('复制地址失败，请手动复制'); }
  };
  return <section aria-label="AI 本地路由" className="space-y-3">
    <div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">本地路由 · {status?.starting ? '正在启动' : status?.running ? '运行中' : '已停止'}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>仅在本机监听，同协议转发和流式响应；不做跨协议转换。打开此页不会自动启动。</p></div><button type="button" aria-label="刷新 AI 路由状态" disabled={Boolean(busy)} onClick={() => act('router_status')} className={button}><RefreshCw size={14} /></button><button type="button" disabled={!status || running || Boolean(busy) || !can('router_save')} onClick={() => setForm({ route: null })} className={button}><Plus size={14} />添加路由</button></div>
      <div className="mt-3 flex flex-wrap items-center gap-2"><label className="inline-flex items-center gap-2 text-xs">本地端口<input aria-label="AI 本地路由端口" type="number" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)} disabled={!status || running || Boolean(busy)} className={`w-28 rounded-lg border px-2 py-1.5 text-xs ${theme.input}`} /></label><button type="button" disabled={!status?.routes.length || running || Boolean(busy) || !can('router_start')} onClick={start} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy === 'router_start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}启动本地路由</button><button type="button" disabled={!running || Boolean(busy) || !can('router_stop')} onClick={() => act('router_stop')} title="可能中断在途请求；不会自动还原工具配置" className={button}><Square size={13} />停止本地路由</button>{status?.url && <code className={`min-w-0 break-all text-xs ${theme.textMuted}`}>{status.url}</code>}</div>
      <p className={`mt-3 text-[11px] leading-5 ${theme.textMuted}`}>真实上游请求可能计费。运行期间请先停止再编辑路由或其引用的供应商；停止不会自动还原工具配置，可使用配置备份恢复。</p>
      {(error || status?.error) && <p role="alert" className="mt-2 break-words text-xs text-red-500">{error || status.error}</p>}
    </div>
    {(status?.routes || []).map(route => <article key={route.id} aria-label={`AI 路由 ${route.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">{route.name}</h4><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{AI_PROTOCOLS.find(item => item.value === route.protocol)?.label || route.protocol} · {route.failover ? '已启用有限故障转移' : '只用第一家，不重试'}</p></div><button type="button" aria-label={`编辑路由 ${route.name}`} disabled={running || Boolean(busy) || !can('router_save')} onClick={() => setForm({ route })} className={button}><Pencil size={13} /></button><button type="button" aria-label={`删除路由 ${route.name}`} disabled={running || Boolean(busy) || !can('router_remove')} onClick={() => setRemove(route)} className={button}><Trash2 size={13} /></button></div><p className="mt-3 break-words text-xs">{route.providerIds.map((id, index) => `${index + 1}. ${providers.find(provider => provider.id === id)?.name || '已删除供应商'}`).join(' → ')}</p><p className={`mt-2 break-all font-mono text-[11px] ${theme.textMuted}`}>本地模型标识：{route.model}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!status.running} onClick={() => copyUrl(route)} className={button}><ClipboardCopy size={13} />复制地址</button><button type="button" disabled={Boolean(busy) || !can('router_copy_key')} onClick={() => act('router_copy_key')} title="密钥仅由主进程写入系统剪贴板，页面不显示；此操作不会启动路由" className={button}><ClipboardCopy size={13} />复制路由密钥</button><button type="button" disabled={!status.running || Boolean(busy) || !can('router_profile')} onClick={() => { setTargets([]); setProfile(route); }} className={button}>保存为本机供应商</button></div>
    </article>)}
    {status && !status.routes.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>先添加路由并选择同协议供应商，然后手动启动。</p>}
    {status && <section aria-label="AI 本地路由统计" className={`rounded-xl border p-4 ${theme.card}`}><h4 className="text-sm font-semibold">本次运行 · {status.requests || 0} 个本地请求</h4><p className={`mt-1 text-[11px] ${theme.textMuted}`}>仅点击刷新时更新；本机转发计数不代表服务商账单。</p><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead className={theme.textMuted}><tr>{['路由 / 供应商', '请求', '错误', '状态码', '耗时'].map(label => <th key={label} className="whitespace-nowrap px-2 py-2 font-normal">{label}</th>)}</tr></thead><tbody>{(status.metrics || []).map(metric => <tr key={`${metric.routeId}:${metric.providerId}`} className="border-t border-slate-400/15"><td className="break-words px-2 py-2">{status.routes.find(route => route.id === metric.routeId)?.name || metric.routeId} / {providers.find(provider => provider.id === metric.providerId)?.name || metric.providerId}</td><td className="px-2 py-2">{metric.requests}</td><td className="px-2 py-2">{metric.errors}</td><td className="px-2 py-2">{metric.lastStatus ?? '—'}</td><td className="whitespace-nowrap px-2 py-2">{metric.lastLatencyMs === undefined ? '—' : `${metric.lastLatencyMs} ms`}</td></tr>)}</tbody></table></div></section>}
    {active && form && <AiRouteForm route={form.route} providers={providers} theme={theme} isDark={isDark} onClose={() => setForm(null)} onSave={route => act('router_save', { route }, { rethrow: true })} />}
    {active && remove && <AiToolsDialog title="删除本地路由？" theme={theme} busy={Boolean(busy)} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs ${theme.textMuted}`}>仅删除本地路由记录，不删除任何供应商或修改工具配置。</p><div className="mt-4 flex justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => setRemove(null)} className={button}>取消</button><button type="button" disabled={Boolean(busy)} onClick={async () => { try { await act('router_remove', { routeId: remove.id }, { rethrow: true }); setRemove(null); } catch { /* The panel retains the actual error. */ } }} className="rounded-lg bg-red-500 px-3 py-2 text-xs text-white disabled:opacity-40">确认删除路由</button></div>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}</AiToolsDialog>}
    {active && profile && <AiToolsDialog title="保存本机路由供应商" theme={theme} busy={Boolean(busy)} onClose={() => setProfile(null)}><p className={`text-xs leading-5 ${theme.textMuted}`}>只把本机地址、路由密钥和模型标识保存到供应商库，不会写入 CLI。随后仍需在配置应用页预览确认。</p><div className="mt-3 flex flex-wrap gap-3">{tools.filter(tool => (tool.configSupported || tool.launchSupported) && tool.protocols.includes(profile.protocol)).map(tool => <label key={tool.id} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={targets.includes(tool.id)} disabled={Boolean(busy)} onChange={event => setTargets(event.target.checked ? [...targets, tool.id] : targets.filter(id => id !== tool.id))} />{tool.label}</label>)}</div><div className="mt-4 flex justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => setProfile(null)} className={button}>取消</button><button type="button" disabled={Boolean(busy) || !targets.length} onClick={async () => { try { await act('router_profile', { routeId: profile.id, targetApps: targets }, { rethrow: true }); setProfile(null); } catch { /* Keep the failed form visible. */ } }} className={`rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>保存本机供应商</button></div>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}</AiToolsDialog>}
  </section>;
}
