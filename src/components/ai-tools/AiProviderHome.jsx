import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Pencil, Play, Plus, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiCompactQuota from './AiCompactQuota';
import { AI_PROTOCOLS } from './aiToolsModel';
import { providerFingerprint, providerHomeTool, providerStatusRows } from './aiProviderHomeModel';

const STATUS = { active: '正在使用', configured: '已配置', inactive: '未使用', incomplete: '待完善', incompatible: '不兼容', unknown: '待确认' };
export default function AiProviderHome({ active, revision, ready = true, choice, onToolChange, providers, tools, onRequest, can, theme, isDark, onPreview, onEdit, onModels, onRemove, onAdd, onProjects, networkAction, busy, feedback, quotaResults, quotaErrors, quotaBusy, quotaRevision, quotaAutoRefresh, onQuotaAutoRefresh }) {
  const id = useId(); const [search, setSearch] = useState('');
  const [native, setNative] = useState(null); const [checking, setChecking] = useState(null); const [checkError, setCheckError] = useState(null);
  const [using, setUsing] = useState(''); const [useError, setUseError] = useState(null);
  const available = tools.filter(tool => tool.configSupported || tool.launchSupported);
  const selected = providerHomeTool(tools, providers, choice);
  const toolId = selected?.id || ''; const fingerprint = JSON.stringify(providers.map(providerFingerprint)); const key = `${toolId}:${revision}:${fingerprint}`;
  const context = useMemo(() => ({ active, ready, key }), [active, ready, key]);
  const state = useRef(context); const ticket = useRef({ value: 0 }); const applying = useRef(false);
  useLayoutEffect(() => { const counter = ticket.current; state.current = context; return () => { state.current = null; counter.value++; }; }, [context]);
  const canRead = can('config_status');
  const loadStatus = useCallback(async () => {
    if (!context.active || !context.ready || !toolId || !canRead || !selected?.configSupported) return;
    const current = ++ticket.current.value; setNative(null); setChecking(context); setCheckError(null);
    try {
      const result = await onRequest('config_status', { toolId });
      if (result?.toolId !== toolId || !Array.isArray(result.providers)) throw new Error('配置状态格式无效');
      if (current === ticket.current.value && state.current === context) setNative({ context, value: result });
    } catch (failure) { if (current === ticket.current.value && state.current === context) { setNative(null); setCheckError({ context, message: failure.message }); } }
    finally { if (current === ticket.current.value && state.current === context) setChecking(null); }
  }, [context, toolId, canRead, selected?.configSupported, onRequest]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  const isChecking = checking === context;
  const statuses = providerStatusRows(native, context, isChecking);
  const use = async provider => {
    if (applying.current || !active || !ready || !can('config_preview') || !can('config_apply')) return;
    const captured = context; applying.current = true; setUsing(provider.id); setUseError(null);
    try {
      const preview = await onRequest('config_preview', { toolId, providerId: provider.id });
      if (state.current === captured) onPreview(preview);
    } catch (failure) { if (state.current === captured) setUseError({ context, id: provider.id, message: failure.message }); }
    finally { applying.current = false; if (state.current) setUsing(''); }
  };
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  const visible = providers.filter(provider => `${provider.name} ${provider.baseUrl} ${provider.model}`.toLowerCase().includes(search.toLowerCase()));
  return <section aria-label="AI 供应商首页" className="space-y-3">
    <div className={`rounded-xl border p-4 ${theme.card}`}>
      <div className="flex flex-wrap items-end gap-3"><div className="w-52"><label htmlFor={`${id}-tool`} className="text-xs">当前使用的工具</label><SelectMenu id={`${id}-tool`} value={toolId} options={available.map(tool => ({ value: tool.id, label: tool.label }))} onChange={onToolChange} disabled={Boolean(using)} isDark={isDark} className="mt-1" /></div>
        <input aria-label="搜索 AI 供应商" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索供应商、地址或模型" className={`min-w-40 flex-1 rounded-lg border px-3 py-2 text-xs ${theme.input}`} />
        <button type="button" disabled={isChecking || !active || !ready || !canRead || !selected?.configSupported} onClick={loadStatus} className={button}>{isChecking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}刷新使用状态</button>
        <button type="button" disabled={!can('provider_save')} onClick={() => onAdd(toolId)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Plus size={14} />添加供应商</button>
      </div>
      <p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>① 选择工具 · ② 添加供应商并配置模型 · ③ 点击「使用」确认。状态按本机配置核验，已运行的 CLI 会话可能需要重新打开。</p>
      {checkError?.context === context && <p role="alert" className="mt-2 text-xs text-amber-500">{checkError.message}</p>}
    </div>
    <div className="grid gap-3 xl:grid-cols-2">{visible.map(provider => {
      const compatible = selected?.protocols.includes(provider.protocol) && provider.targetApps.includes(toolId);
      const result = compatible ? statuses.find(item => item.providerId === provider.id) : null;
      const inUse = result?.state === 'active'; const configured = result?.state === 'configured';
      const connection = feedback[provider.id]; const blocked = !provider.hasCredential || !provider.model;
      return <article key={provider.id} aria-label={`AI 供应商 ${provider.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card} ${inUse ? 'ring-1 ring-emerald-500/50' : ''}`}>
        <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{provider.name}</h3><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{AI_PROTOCOLS.find(item => item.value === provider.protocol)?.label || provider.protocol}</p></div>
          <span title={result?.message || (compatible ? '尚未完成本机状态检查' : '请编辑供应商，核对协议与关联工具')} className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${inUse || configured ? isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-500/10 text-emerald-700' : 'bg-slate-400/10'}`}>{compatible ? selected?.launchSupported ? '项目启动' : STATUS[result?.state] || (isChecking ? '检查中' : '待确认') : '未关联此工具'}</span>
        </div>
        <p title={provider.baseUrl} className={`mt-3 truncate font-mono text-xs ${theme.textMuted}`}>{provider.baseUrl}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span>默认模型：{provider.model || '待配置'}</span><span className={`inline-flex items-center gap-1 ${provider.hasCredential ? 'text-emerald-500' : 'text-amber-500'}`}><KeyRound size={11} />{provider.hasCredential ? '已保存密钥' : '缺少密钥'}</span></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {compatible && selected?.configSupported && <button type="button" disabled={!active || !ready || Boolean(using) || inUse || configured || blocked || !can('config_preview') || !can('config_apply')} title={blocked ? '先配置密钥和默认模型' : result?.message || '预览并确认后应用到当前工具'} onClick={() => use(provider)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50 ${theme.button.primary}`}>{using === provider.id ? <Loader2 size={13} className="animate-spin" /> : inUse || configured ? <CheckCircle2 size={13} /> : <Play size={13} />}{inUse ? '正在使用' : configured ? '已配置' : '使用'}</button>}
          {compatible && selected?.launchSupported && <button type="button" onClick={onProjects} className={button}><Play size={13} />项目启动</button>}
          {!compatible && <button type="button" disabled={!can('provider_save')} onClick={() => onEdit(provider, toolId)} className={button}>关联此工具</button>}
          <button type="button" disabled={!can('provider_save')} onClick={() => onModels(provider)} className={button}><SlidersHorizontal size={13} />配置模型</button>
          <button type="button" disabled={!can('provider_probe') || Boolean(busy[provider.id])} title="确认后发送一次最小模型测试；也可选择只读检查" onClick={() => networkAction(provider, 'provider_probe')} className={button}>{busy[provider.id] === 'provider_probe' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}{busy[provider.id] === 'provider_probe' ? '测试中…' : '测试连接'}</button>
          <button type="button" aria-label={`编辑 AI 供应商 ${provider.name}`} disabled={!can('provider_save') || Boolean(busy[provider.id])} onClick={() => onEdit(provider)} className={button}><Pencil size={13} /></button>
          <button type="button" aria-label={`删除 AI 供应商 ${provider.name}`} disabled={!can('provider_remove') || Boolean(busy[provider.id])} onClick={() => onRemove(provider)} className={button}><Trash2 size={13} /></button>
        </div>
        {compatible && blocked && <p className="mt-2 text-xs text-amber-500">{provider.hasCredential ? '请先配置默认模型，再点击使用。' : '请先编辑并保存 API 密钥。'}</p>}
        {configured && <p className={`mt-2 text-xs ${theme.textMuted}`}>{result.message}</p>}
        {useError?.context === context && useError.id === provider.id && <p role="alert" className="mt-2 text-xs text-red-500">{useError.message}</p>}
        {connection && <div role={connection.status === 'error' ? 'alert' : 'status'} aria-label={`连接测试反馈 ${provider.name}`} className={`mt-3 select-text rounded-lg border p-3 text-xs leading-5 ${connection.status === 'error' ? 'border-red-500/25 bg-red-500/5 text-red-500' : connection.status === 'partial' ? 'border-amber-500/25 bg-amber-500/5 text-amber-500' : connection.status === 'pending' ? 'border-cyan-500/25 bg-cyan-500/5 text-cyan-500' : connection.status === 'cancelled' ? `border-slate-400/25 ${theme.textMuted}` : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-500'}`}><p className="font-medium">{connection.status === 'error' ? '连接测试失败' : connection.status === 'partial' ? '只读检查完成，尚未验证模型调用' : connection.status === 'pending' ? '连接测试进行中' : connection.status === 'cancelled' ? '连接测试已取消' : '连接检查成功'}</p><p className="mt-1 break-words">{connection.message}</p>{connection.completedAt && <p className="mt-1 text-[10px] opacity-75">完成于 {new Date(connection.completedAt).toLocaleTimeString()}</p>}</div>}
        <AiCompactQuota provider={provider} result={quotaResults[provider.id]} error={quotaErrors[provider.id]} busy={Boolean(quotaBusy?.[provider.id])} canQuery={can('quota_query')} onQuery={() => networkAction(provider, 'quota_query')} theme={theme} active={active && ready} revision={quotaRevision} autoRefresh={quotaAutoRefresh?.[provider.id]} onAutoRefresh={value => onQuotaAutoRefresh?.(provider.id, value)} />
      </article>;
    })}</div>
    {!visible.length && <div className={`rounded-xl border border-dashed p-7 text-center ${theme.card}`}><h3 className="text-sm font-semibold">{providers.length ? '没有匹配的供应商' : '添加你的第一个供应商'}</h3><p className={`mt-2 text-xs ${theme.textMuted}`}>选择常用模板后填写密钥和模型；保存不会立即切换或发起付费请求。</p><button type="button" disabled={!can('provider_save')} onClick={() => onAdd(toolId)} className={`mt-4 rounded-lg px-4 py-2 text-xs ${theme.button.primary}`}>选择模板并添加</button></div>}
  </section>;
}
