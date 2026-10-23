import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Boxes, CheckCircle2, KeyRound, List, Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { isDarkTheme } from '../../shared/theme';
import AiToolsDialog from './AiToolsDialog';
import AiProviderForm from './AiProviderForm';
import AiQuotaCard from './AiQuotaCard';
import AiModelsDialog from './AiModelsDialog';
import AiConfigPanel from './AiConfigPanel';
import AiConfigPreview from './AiConfigPreview';
import AiBackupsPanel from './AiBackupsPanel';
import AiSessionsPanel from './AiSessionsPanel';
import AiRouterPanel from './AiRouterPanel';
import AiResourcesPanel from './AiResourcesPanel';
import AiProjectsPanel from './AiProjectsPanel';
import AiSkillsPanel from './AiSkillsPanel';
import AiPortablePanel from './AiPortablePanel';
import { AI_PROTOCOLS, aiToolsCan, providerDraft, providerInput } from './aiToolsModel';

export default function AiToolsWorkspace({ active = true, theme, isDark = isDarkTheme(theme), showToast, onRequest, onOpenMembership }) {
  const [snapshot, setSnapshot] = useState(null); const snapshotRef = useRef(null); const requestRef = useRef(onRequest);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [tab, setTab] = useState('providers');
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [removing, setRemoving] = useState(false);
  const [preview, setPreview] = useState(null); const [models, setModels] = useState(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [busy, setBusy] = useState({}); const pending = useRef(new Set());
  const [quotaResults, setQuotaResults] = useState({}); const [quotaErrors, setQuotaErrors] = useState({});
  const alive = useRef(true); const activeRef = useRef(active); const loadTicket = useRef(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  useLayoutEffect(() => { requestRef.current = onRequest; activeRef.current = active; }, [onRequest, active]);
  const accept = useCallback(data => {
    if (!data || typeof data.membership?.activated !== 'boolean' || !Array.isArray(data.providers) || !Array.isArray(data.tools) || !Array.isArray(data.capabilities)) throw new Error('AI 工具状态格式无效，请刷新后重试');
    const state = { ...data, membership: { ...data.membership, reason: typeof data.membership.reason === 'string' && /[\u3400-\u9fff]/.test(data.membership.reason) ? data.membership.reason : '会员状态尚未通过验证，请在已有会员中心检查。此功能沿用本软件 VIP，无需额外账号。' } };
    snapshotRef.current = state; setSnapshot(state);
    setQuotaResults(Object.fromEntries((Array.isArray(data.quota) ? data.quota : []).map(item => [item.providerId, item])));
  }, []);
  const refresh = useCallback(async () => {
    const ticket = ++loadTicket.current; setLoading(true); setError('');
    try {
      if (typeof requestRef.current !== 'function') throw new Error('AI 工具接口尚未连接');
      const data = await requestRef.current('snapshot', {});
      if (alive.current && ticket === loadTicket.current) accept(data);
    } catch (failure) { if (alive.current && ticket === loadTicket.current) setError(failure.message); }
    finally { if (alive.current && ticket === loadTicket.current) setLoading(false); }
  }, [accept]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => { const focus = () => { if (activeRef.current && !document.hidden) void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh]);
  const request = useCallback(async (command, args = {}, options) => {
    if (!aiToolsCan(snapshotRef.current, command, options)) throw new Error(snapshotRef.current?.membership?.activated ? '此能力尚未接通，未执行操作' : '请先通过本软件会员中心完成激活');
    return requestRef.current(command, args);
  }, []);
  const can = (command, options) => aiToolsCan(snapshot, command, options);
  const providers = snapshot?.providers || []; const tools = snapshot?.tools || [];
  const tabs = [{ id: 'providers', label: '供应商', enabled: true }, { id: 'quota', label: '额度与余额', enabled: can('quota_query') },
    { id: 'config', label: '配置应用', enabled: can('config_preview') }, { id: 'backups', label: '配置备份', enabled: can('backups_list') },
    { id: 'sessions', label: '会话与本机用量', enabled: can('sessions_list') }, { id: 'router', label: '本地路由', enabled: can('router_status') },
    { id: 'mcp', label: 'MCP', enabled: can('resources_snapshot') && can('resources_mcp_save') }, { id: 'prompts', label: '提示词', enabled: can('resources_snapshot') && can('resources_prompt_save') },
    { id: 'resourceBackups', label: '资源备份', enabled: can('resources_backups_list') },
    { id: 'projects', label: '项目启动', enabled: can('projects_snapshot') },
    { id: 'skills', label: 'Skills', enabled: can('skills_list') || can('skills_backups_list') },
    { id: 'portable', label: '加密迁移', enabled: can('portable_export') || can('portable_recoveries_list') }].filter(item => item.enabled);
  const selectedTab = tabs.some(item => item.id === tab) ? tab : 'providers';

  const saveProvider = async provider => {
    const result = await request('provider_save', { provider });
    if (alive.current) { await refresh(); showToast?.('供应商已保存，尚未改写工具配置'); }
    return result;
  };
  const removeProvider = async () => {
    if (!remove || removing) return; setRemoving(true); setError('');
    try { await request('provider_remove', { providerId: remove.id }); if (alive.current) { setRemove(null); await refresh(); showToast?.('已删除保存的供应商记录，工具原配置未删除'); } }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setRemoving(false); }
  };
  const networkAction = async (provider, command) => {
    if (pending.current.has(provider.id)) return;
    const fingerprint = JSON.stringify(provider); pending.current.add(provider.id); setBusy(previous => ({ ...previous, [provider.id]: command }));
    setQuotaErrors(previous => ({ ...previous, [provider.id]: '' })); setError('');
    try {
      const result = await request(command, { providerId: provider.id });
      if (!alive.current || JSON.stringify(snapshotRef.current.providers.find(item => item.id === provider.id)) !== fingerprint) return;
      if (command === 'quota_query') {
        if (result?.providerId !== provider.id) throw new Error('额度结果与当前供应商不一致，未显示数据');
        setQuotaResults(previous => ({ ...previous, [provider.id]: result }));
      } else if (command === 'models_list') {
        if (!Array.isArray(result?.models) || result.models.some(item => typeof item?.id !== 'string')) throw new Error('模型列表格式无效');
        setModels({ provider, items: result.models });
      } else {
        if (result?.reachable !== true) throw new Error('未能确认服务可达，请核对地址、协议及密钥');
        showToast?.(`连接可达${Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : ''}${Number.isFinite(result.modelCount) ? ` · ${result.modelCount} 个模型` : ''}`);
      }
    } catch (failure) {
      if (alive.current) { if (command === 'quota_query') setQuotaErrors(previous => ({ ...previous, [provider.id]: failure.message })); else setError(failure.message); }
    } finally { pending.current.delete(provider.id); if (alive.current) setBusy(previous => { const next = { ...previous }; delete next[provider.id]; return next; }); }
  };
  const openPreview = (result, restoring = false, resourceMode = false) => {
    if (!result || typeof result.token !== 'string' || !Array.isArray(result.files)) throw new Error('配置预览格式无效，未执行写入');
    setPreview({ value: result, restoring, resourceMode });
  };
  const applyPreview = async token => {
    const result = await request(preview?.resourceMode ? 'resources_apply' : 'config_apply', { token }, { restoring: preview?.restoring === true });
    if (alive.current) { setConfigurationRevision(value => value + 1); await refresh(); showToast?.(result.operation === 'restore' ? '配置已恢复' : '配置已应用，并已创建恢复备份'); }
  };
  const imported = async () => { setConfigurationRevision(value => value + 1); await refresh(); };

  return <section aria-label="AI 工具工作区" className={`min-w-0 space-y-4 ${theme.text}`}>
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${theme.card}`}><Boxes size={21} className="text-emerald-500" /><div className="min-w-0 flex-1"><h2 className="text-base font-semibold">AI 工具</h2><p className={`mt-1 text-xs ${theme.textMuted}`}>管理供应商、查看服务商额度；本机配置先预览再应用。</p></div><button type="button" aria-label="刷新 AI 工具状态" title="仅刷新本地状态，不发送模型或额度请求" disabled={loading} onClick={refresh} className={button}>{loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button>{can('provider_save') && <button type="button" onClick={() => setForm({ provider: null })} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs ${theme.button.primary}`}><Plus size={14} />添加供应商</button>}</div>
    {error && <p role="alert" className="break-words rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-500">{error}</p>}
    {(snapshot?.warning || snapshot?.storage?.warning) && <p role="status" className="rounded-lg border border-amber-500/25 px-3 py-2 text-xs text-amber-500">{snapshot.warning || snapshot.storage.warning}</p>}
    {snapshot && !snapshot.membership.activated ? <><div className={`rounded-xl border p-6 text-center ${theme.card}`}><ShieldCheck size={30} className="mx-auto mb-3 text-emerald-500" /><h3 className="text-base font-semibold">使用现有会员权限</h3><p className={`mt-2 text-sm ${theme.textMuted}`}>{snapshot.membership.reason || '此功能沿用本软件 VIP，无需额外账号或购买服务。'}</p><button type="button" onClick={onOpenMembership} disabled={!onOpenMembership} className={`mt-4 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>打开会员中心</button>{can('backups_list') && <button type="button" onClick={() => setTab('backups')} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>恢复此前配置</button>}{can('router_stop') && <button type="button" onClick={() => { void request('router_stop', {}).then(() => showToast?.('本地路由已停止'), failure => setError(failure.message)); }} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>停止本地路由</button>}{can('resources_backups_list') && <button type="button" onClick={() => setTab('resourceBackups')} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>恢复 MCP / 提示词配置</button>}</div>{selectedTab === 'backups' && can('backups_list') && <AiBackupsPanel refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true)} canRestore={can('backup_preview_restore') && aiToolsCan(snapshot, 'config_apply', { restoring: true })} theme={theme} />}{selectedTab === 'resourceBackups' && can('resources_backups_list') && <AiBackupsPanel resourceMode refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true, true)} canRestore={can('resources_backup_preview_restore') && aiToolsCan(snapshot, 'resources_apply', { restoring: true })} theme={theme} />}</> : snapshot && <>
      <div role="tablist" aria-label="AI 工具功能" className="flex flex-wrap gap-1">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={selectedTab === item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm ${selectedTab === item.id ? (isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/15 text-emerald-600') : theme.button.secondary}`}>{item.label}</button>)}</div>
      {selectedTab === 'providers' && <div className="grid gap-3 xl:grid-cols-2">{providers.map(provider => <article key={provider.id} aria-label={`AI 供应商 ${provider.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{provider.name}</h3><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{AI_PROTOCOLS.find(item => item.value === provider.protocol)?.label || provider.protocol}</p></div><span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] ${provider.hasCredential ? (isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-500/10 text-emerald-600') : 'bg-amber-500/10 text-amber-600'}`}><KeyRound size={11} />{provider.hasCredential ? '已保存密钥' : '未配置密钥'}</span></div><p title={provider.baseUrl} className={`mt-3 truncate font-mono text-xs ${theme.textMuted}`}>{provider.baseUrl}</p><p className="mt-2 truncate text-xs">默认模型：{provider.model || '未设置'}</p><p className={`mt-1 truncate text-xs ${theme.textMuted}`}>目标工具：{provider.targetApps?.length ? provider.targetApps.map(id => tools.find(tool => tool.id === id)?.label || id).join('、') : '尚未选择'}</p>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!can('provider_test') || Boolean(busy[provider.id])} title="只读模型能力，不发送付费对话" onClick={() => networkAction(provider, 'provider_test')} className={button}>{busy[provider.id] === 'provider_test' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}测试连接</button><button type="button" disabled={!can('models_list') || Boolean(busy[provider.id])} onClick={() => networkAction(provider, 'models_list')} className={button}><List size={13} />模型列表</button><button type="button" aria-label={`编辑 AI 供应商 ${provider.name}`} disabled={!can('provider_save') || Boolean(busy[provider.id])} onClick={() => setForm({ provider })} className={button}><Pencil size={13} /></button><button type="button" aria-label={`删除 AI 供应商 ${provider.name}`} disabled={!can('provider_remove') || Boolean(busy[provider.id])} onClick={() => setRemove(provider)} className={button}><Trash2 size={13} /></button></div>
      </article>)}{!providers.length && <div className={`rounded-xl border border-dashed p-8 text-center xl:col-span-2 ${theme.card}`}><Boxes size={30} className="mx-auto mb-3 text-emerald-500" /><h3 className="text-sm font-semibold">先添加一个供应商</h3><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>保存地址和密钥后，可以测试连接、读取模型及显式查询额度。<br />已有工具的配置和登录状态不会自动导入。</p></div>}</div>}
      {selectedTab === 'quota' && <><p className={`text-xs ${theme.textMuted}`}>服务商额度与余额，不等于本机调用量。仅在点击刷新时查询，不自动轮询。</p><div className="grid gap-3 md:grid-cols-2">{providers.map(provider => <AiQuotaCard key={provider.id} provider={provider} result={quotaResults[provider.id]} error={quotaErrors[provider.id]} busy={Boolean(busy[provider.id])} canQuery={can('quota_query')} onQuery={() => networkAction(provider, 'quota_query')} theme={theme} />)}{!providers.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>请先添加供应商并设置额度适配器。</p>}</div></>}
      {selectedTab === 'config' && <AiConfigPanel providers={providers} tools={tools} theme={theme} isDark={isDark} canPreview={can('config_preview')} onPreview={async args => openPreview(await request('config_preview', args))} />}
      {selectedTab === 'backups' && <AiBackupsPanel refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true)} canRestore={can('backup_preview_restore') && can('config_apply')} theme={theme} />}
      {selectedTab === 'sessions' && <AiSessionsPanel onRequest={request} tools={tools} canScan={can('sessions_scan')} canOpen={can('sessions_open')} theme={theme} isDark={isDark} />}
      {selectedTab === 'router' && <AiRouterPanel active={active} providers={providers} tools={tools} onRequest={request} can={can} onProvidersChanged={refresh} theme={theme} isDark={isDark} showToast={showToast} />}
      {['mcp', 'prompts'].includes(selectedTab) && <AiResourcesPanel key={selectedTab} kind={selectedTab === 'mcp' ? 'mcp' : 'prompt'} active={active} refreshKey={configurationRevision} onRequest={request} can={can} onPreview={result => openPreview(result, false, true)} theme={theme} isDark={isDark} showToast={showToast} />}
      {selectedTab === 'resourceBackups' && <AiBackupsPanel resourceMode refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true, true)} canRestore={can('resources_backup_preview_restore') && can('resources_apply')} theme={theme} />}
      {selectedTab === 'projects' && <AiProjectsPanel active={active} providers={providers} tools={tools} onRequest={request} can={can} theme={theme} isDark={isDark} showToast={showToast} />}
      {selectedTab === 'skills' && <AiSkillsPanel active={active} onRequest={request} can={can} theme={theme} isDark={isDark} showToast={showToast} />}
      {selectedTab === 'portable' && <AiPortablePanel active={active} onRequest={request} can={can} theme={theme} showToast={showToast} onImported={imported} />}
    </>}
    {snapshot && !snapshot.membership.activated && <div className="space-y-3"><div className="flex flex-wrap gap-2">{can('skills_backups_list') && <button type="button" onClick={() => setTab('skills')} className={button}>恢复 Skills 配置</button>}{can('portable_recoveries_list') && <button type="button" onClick={() => setTab('portable')} className={button}>检查中断导入恢复</button>}</div>{selectedTab === 'skills' && can('skills_backups_list') && <AiSkillsPanel recoveryOnly active={active} onRequest={request} can={can} theme={theme} isDark={isDark} showToast={showToast} />}{selectedTab === 'portable' && can('portable_recoveries_list') && <AiPortablePanel recoveryOnly active={active} onRequest={request} can={can} theme={theme} showToast={showToast} onImported={imported} />}</div>}
    {!snapshot && loading && <p role="status" className={`p-8 text-center text-sm ${theme.textMuted}`}>正在读取 AI 工具本地状态…</p>}
    {active && form && can('provider_save') && <AiProviderForm provider={form.provider} tools={tools} theme={theme} isDark={isDark} onSave={saveProvider} onClose={() => setForm(null)} />}
    {active && models && <AiModelsDialog provider={models.provider} models={models.items} theme={theme} isDark={isDark} canSave={can('provider_save')} onClose={() => setModels(null)} onSave={model => saveProvider(providerInput({ ...providerDraft(models.provider), model }, models.provider))} />}
    {active && preview && aiToolsCan(snapshot, preview.resourceMode ? 'resources_apply' : 'config_apply', { restoring: preview.restoring }) && <AiConfigPreview preview={preview.value} restoring={preview.restoring} theme={theme} onApply={applyPreview} onClose={() => setPreview(null)} />}
    {active && remove && <AiToolsDialog title="删除 AI 供应商？" theme={theme} busy={removing} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>只删除本软件保存的供应商和密钥，不删除或还原任何工具的现有配置。</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={removing} onClick={() => setRemove(null)} className={button}>取消</button><button type="button" disabled={removing || !can('provider_remove')} onClick={removeProvider} className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm text-white disabled:opacity-50">{removing && <Loader2 size={14} className="animate-spin" />}确认删除供应商</button></div></AiToolsDialog>}
  </section>;
}
