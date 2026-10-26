import { tr, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Boxes, Info, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
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
import AiProviderHome from './AiProviderHome';
import { aiToolsCan, providerDraft, providerInput } from './aiToolsModel';
import { connectionCompletionNotice, connectionFeedback, providerFeedbackCurrent, providerFeedbackToken } from './aiProviderHomeModel';

export default function AiToolsWorkspace({ active = true, theme, isDark = isDarkTheme(theme), showToast, onRequest, onOpenMembership }) {
  useLocale();
  const [snapshot, setSnapshot] = useState(null); const snapshotRef = useRef(null); const requestRef = useRef(onRequest);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [tab, setTab] = useState('providers');
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [removing, setRemoving] = useState(false);
  const [preview, setPreview] = useState(null); const [models, setModels] = useState(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [snapshotRevision, setSnapshotRevision] = useState(0); const [snapshotReady, setSnapshotReady] = useState(false); const [providerToolId, setProviderToolId] = useState('');
  const [busy, setBusy] = useState({}); const pending = useRef(new Set());
  const [quotaBusy, setQuotaBusy] = useState({});
  const feedbackEpoch = useRef(0);
  const [quotaResults, setQuotaResults] = useState({}); const [quotaErrors, setQuotaErrors] = useState({});
  const [quotaAutoRefresh, setQuotaAutoRefresh] = useState({});
  const alive = useRef(true); const activeRef = useRef(active); const loadTicket = useRef(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  useLayoutEffect(() => { requestRef.current = onRequest; activeRef.current = active; }, [onRequest, active]);
  const invalidateFeedback = useCallback(() => { feedbackEpoch.current++; setQuotaErrors({}); setQuotaResults({}); }, []);
  const accept = useCallback(data => {
    if (!data || typeof data.membership?.activated !== 'boolean' || !Array.isArray(data.providers) || !Array.isArray(data.tools) || !Array.isArray(data.capabilities)) throw new Error(tr("AI 工具状态格式无效，请刷新后重试"));
    const state = { ...data, membership: { ...data.membership, reason: typeof data.membership.reason === 'string' && /[\u3400-\u9fff]/.test(data.membership.reason) ? data.membership.reason : tr("会员状态尚未通过验证，请在已有会员中心检查。此功能沿用本软件 VIP，无需额外账号。") } };
    if (snapshotRef.current && snapshotRef.current.membership.activated !== state.membership.activated) invalidateFeedback();
    snapshotRef.current = state; setSnapshot(state); setSnapshotReady(true); setSnapshotRevision(value => value + 1);
    setQuotaResults(Object.fromEntries((Array.isArray(data.quota) ? data.quota : []).map(item => [item.providerId, item])));
  }, [invalidateFeedback]);
  const refresh = useCallback(async () => {
    const ticket = ++loadTicket.current; setSnapshotReady(false); setLoading(true); setError('');
    try {
      if (typeof requestRef.current !== 'function') throw new Error(tr("AI 工具接口尚未连接"));
      const data = await requestRef.current('snapshot', {});
      if (alive.current && ticket === loadTicket.current) accept(data);
    } catch (failure) { if (alive.current && ticket === loadTicket.current) setError(failure.message); }
    finally { if (alive.current && ticket === loadTicket.current) setLoading(false); }
  }, [accept]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => { const focus = () => { if (activeRef.current && !document.hidden) void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh]);
  const request = useCallback(async (command, args = {}, options) => {
    if (!aiToolsCan(snapshotRef.current, command, options)) throw new Error(snapshotRef.current?.membership?.activated ? tr("此能力尚未接通，未执行操作") : tr("请先通过本软件会员中心完成激活"));
    return requestRef.current(command, args);
  }, []);
  const can = (command, options) => aiToolsCan(snapshot, command, options);
  const providers = snapshot?.providers || []; const tools = snapshot?.tools || [];
  const tabs = [{ id: 'providers', label: tr("供应商"), enabled: true }, { id: 'projects', label: tr("项目启动"), enabled: can('projects_snapshot') }, { id: 'sessions', label: tr("会话与本机用量"), enabled: can('sessions_list') }, { id: 'quota', label: tr("额度与余额"), enabled: can('quota_query') },
    { id: 'config', label: tr("配置应用"), enabled: can('config_preview') }, { id: 'backups', label: tr("配置备份"), enabled: can('backups_list') },
    { id: 'router', label: tr("本地路由"), enabled: can('router_status') },
    { id: 'mcp', label: 'MCP', enabled: can('resources_snapshot') && can('resources_mcp_save') }, { id: 'prompts', label: tr("提示词"), enabled: can('resources_snapshot') && can('resources_prompt_save') },
    { id: 'resourceBackups', label: tr("资源备份"), enabled: can('resources_backups_list') },
    { id: 'skills', label: 'Skills', enabled: can('skills_list') || can('skills_backups_list') },
    { id: 'portable', label: tr("加密迁移"), enabled: can('portable_export') || can('portable_recoveries_list') }].filter(item => item.enabled);
  const selectedTab = tabs.some(item => item.id === tab) ? tab : 'providers';
  const primaryIds = ['providers', 'projects', 'sessions']; const primaryTabs = tabs.filter(item => primaryIds.includes(item.id)); const advancedTabs = tabs.filter(item => !primaryIds.includes(item.id));

  const saveProvider = async provider => {
    invalidateFeedback();
    const result = await request('provider_save', { provider });
    if (alive.current) { setConfigurationRevision(value => value + 1); await refresh(); showToast?.(tr("供应商已保存，尚未改写工具配置")); }
    return result;
  };
  const removeProvider = async () => {
    if (!remove || removing) return; invalidateFeedback(); setRemoving(true); setError('');
    try { await request('provider_remove', { providerId: remove.id }); if (alive.current) { setRemove(null); await refresh(); showToast?.(tr("已删除保存的供应商记录，工具原配置未删除")); } }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setRemoving(false); }
  };
  const networkAction = async (provider, command) => {
    const isQuota = command === 'quota_query'; const pendingKey = isQuota ? `quota:${provider.id}` : provider.id;
    const updateBusy = isQuota ? setQuotaBusy : setBusy;
    if (pending.current.has(pendingKey)) return { skipped: true };
    const token = providerFeedbackToken(provider, feedbackEpoch.current); pending.current.add(pendingKey); updateBusy(previous => ({ ...previous, [provider.id]: command }));
    const current = () => alive.current && providerFeedbackCurrent(token, snapshotRef.current?.providers.find(item => item.id === provider.id), feedbackEpoch.current);
    if (isQuota) setQuotaErrors(previous => ({ ...previous, [provider.id]: '' }));
    try {
      const result = await request(command, { providerId: provider.id });
      if (!current()) return { skipped: true };
      if (result?.cancelled) {
        if (!isQuota) {
          showToast?.(connectionCompletionNotice(result));
        }
        return result;
      }
      if (command === 'quota_query') {
        if (result?.providerId !== provider.id) throw new Error(tr("额度结果与当前供应商不一致，未显示数据"));
        setQuotaResults(previous => ({ ...previous, [provider.id]: result }));
      } else {
        const value = connectionFeedback(result);
        showToast?.(connectionCompletionNotice(result, value));
      }
      return result;
    } catch (failure) {
      if (current()) {
        if (command === 'quota_query') setQuotaErrors(previous => ({ ...previous, [provider.id]: failure.message }));
        else { const value = { status: 'error', message: failure.message || tr("连接测试失败，请重试。") }; showToast?.(connectionCompletionNotice(null, value)); }
      }
      return { status: 'error', reason: failure.message };
    } finally { pending.current.delete(pendingKey); if (alive.current) updateBusy(previous => { const next = { ...previous }; delete next[provider.id]; return next; }); }
  };
  const readModels = async providerId => {
    const provider = snapshotRef.current?.providers.find(item => item.id === providerId);
    if (!provider) throw new Error(tr("供应商已不存在，请刷新后重新打开模型配置"));
    const token = providerFeedbackToken(provider, feedbackEpoch.current);
    const result = await request('models_list', { providerId });
    if (!alive.current || !providerFeedbackCurrent(token, snapshotRef.current?.providers.find(item => item.id === providerId), feedbackEpoch.current)) throw Object.assign(new Error(tr("供应商状态已变化，请重新读取模型列表")), { code: 'AI_TOOLS_PROVIDER_CHANGED' });
    if (!Array.isArray(result?.models) || result.models.some(item => typeof item?.id !== 'string')) throw new Error(tr("模型列表格式无效"));
    return result;
  };
  const saveModels = changes => {
    const provider = snapshotRef.current?.providers.find(item => item.id === models?.provider.id);
    if (!provider) throw new Error(tr("供应商已不存在，请刷新后重试"));
    const modelChanges = { model: changes.model, ...(Object.hasOwn(changes, 'claudeModels') ? { claudeModels: changes.claudeModels } : {}) };
    return saveProvider(providerInput({ ...providerDraft(provider), ...modelChanges }, provider));
  };
  const openPreview = (result, restoring = false, resourceMode = false) => {
    if (!result || typeof result.token !== 'string' || !Array.isArray(result.files)) throw new Error(tr("配置预览格式无效，未执行写入"));
    setPreview({ value: result, restoring, resourceMode });
  };
  const applyPreview = async token => {
    const result = await request(preview?.resourceMode ? 'resources_apply' : 'config_apply', { token }, { restoring: preview?.restoring === true });
    if (alive.current) { invalidateFeedback(); setConfigurationRevision(value => value + 1); await refresh(); showToast?.(result.operation === 'restore' ? tr("配置已恢复") : tr("配置已应用，并已创建恢复备份")); }
  };
  const imported = async () => { invalidateFeedback(); setConfigurationRevision(value => value + 1); await refresh(); };
  const changeQuotaAutoRefresh = (id, enabled) => setQuotaAutoRefresh(previous => ({ ...previous, [id]: enabled }));

  return <section aria-label={tr("AI 工具工作区")} className={`min-w-0 space-y-4 ${theme.text}`}>
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${theme.card}`}><Boxes size={21} className="text-emerald-500" /><div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{tr("AI 工具")}</h2><p className={`mt-1 text-xs ${theme.textMuted}`}>{tr("选择当前工具，直接配置模型、切换供应商并核验使用状态。")}</p></div><button type="button" aria-label={tr("刷新 AI 工具状态")} title={tr("刷新本地状态及当前工具配置；额度遵循自动刷新开关，不发送模型推理请求")} disabled={loading} onClick={refresh} className={button}>{loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button></div>
    <p role="note" className={`flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs leading-5 ${isDark ? 'text-sky-200' : 'text-sky-900'}`}><Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 break-words">{tr("此处的供应商与模型配置仅用于外部 AI 工具，不影响卓控台内置 AI。")}</span></p>
    {error && <p role="alert" className="break-words rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-500">{tr(error)}</p>}
    {(snapshot?.warning || snapshot?.storage?.warning) && <p role="status" className="rounded-lg border border-amber-500/25 px-3 py-2 text-xs text-amber-500">{snapshot.warning || snapshot.storage.warning}</p>}
    {snapshot && !snapshot.membership.activated ? <><div className={`rounded-xl border p-6 text-center ${theme.card}`}><ShieldCheck size={30} className="mx-auto mb-3 text-emerald-500" /><h3 className="text-base font-semibold">{tr("使用现有会员权限")}</h3><p className={`mt-2 text-sm ${theme.textMuted}`}>{tr(snapshot.membership.reason) || tr("此功能沿用本软件 VIP，无需额外账号或购买服务。")}</p><button type="button" onClick={onOpenMembership} disabled={!onOpenMembership} className={`mt-4 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{tr("打开会员中心")}</button>{can('backups_list') && <button type="button" onClick={() => setTab('backups')} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("恢复此前配置")}</button>}{can('router_stop') && <button type="button" onClick={() => { void request('router_stop', {}).then(() => showToast?.(tr("本地路由已停止")), failure => setError(failure.message)); }} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("停止本地路由")}</button>}{can('resources_backups_list') && <button type="button" onClick={() => setTab('resourceBackups')} className={`ml-2 mt-4 rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("恢复 MCP / 提示词配置")}</button>}</div>{selectedTab === 'backups' && can('backups_list') && <AiBackupsPanel refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true)} canRestore={can('backup_preview_restore') && aiToolsCan(snapshot, 'config_apply', { restoring: true })} theme={theme} />}{selectedTab === 'resourceBackups' && can('resources_backups_list') && <AiBackupsPanel resourceMode refreshKey={configurationRevision} onRequest={request} onPreview={result => openPreview(result, true, true)} canRestore={can('resources_backup_preview_restore') && aiToolsCan(snapshot, 'resources_apply', { restoring: true })} theme={theme} />}</> : snapshot && <>
      <div role="tablist" aria-label={tr("AI 工具功能")} className="flex flex-wrap gap-1">{primaryTabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={selectedTab === item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm ${selectedTab === item.id ? (isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/15 text-emerald-600') : theme.button.secondary}`}>{item.label}</button>)}</div>
      {advancedTabs.length > 0 && <details open={!primaryIds.includes(selectedTab) || undefined} className={`rounded-lg border px-3 py-2 ${theme.card}`}><summary className={`cursor-pointer text-xs ${theme.textMuted}`}>{tr("高级工具与恢复")}</summary><div role="tablist" aria-label={tr("AI 高级工具")} className="mt-2 flex flex-wrap gap-1">{advancedTabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={selectedTab === item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-3 py-2 text-xs ${selectedTab === item.id ? (isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/15 text-emerald-700') : theme.button.secondary}`}>{item.label}</button>)}</div></details>}
      {selectedTab === 'providers' && <AiProviderHome active={active} ready={snapshotReady && !loading} revision={configurationRevision + snapshotRevision} choice={providerToolId} onToolChange={setProviderToolId} providers={providers} tools={tools} onRequest={request} can={can} theme={theme} isDark={isDark} onPreview={result => openPreview(result)} onEdit={(provider, toolId) => setForm({ provider, toolId })} onModels={provider => setModels({ provider, items: [] })} onRemove={setRemove} onAdd={toolId => setForm({ provider: null, toolId })} onProjects={() => setTab('projects')} networkAction={networkAction} busy={busy} quotaResults={quotaResults} quotaErrors={quotaErrors} quotaBusy={quotaBusy} quotaRevision={configurationRevision} quotaAutoRefresh={quotaAutoRefresh} onQuotaAutoRefresh={changeQuotaAutoRefresh} />}
      {selectedTab === 'quota' && <><p className={`text-xs ${theme.textMuted}`}>{tr("服务商额度与余额，不等于本机调用量。默认每 60 秒自动刷新，可分别关闭；页面、窗口或卡片不可见时暂停。")}</p><div className="grid gap-3 md:grid-cols-2">{providers.map(provider => <AiQuotaCard key={provider.id} provider={provider} result={quotaResults[provider.id]} error={quotaErrors[provider.id]} busy={Boolean(quotaBusy[provider.id])} canQuery={can('quota_query')} onQuery={() => networkAction(provider, 'quota_query')} theme={theme} active={active && selectedTab === 'quota' && snapshotReady && !loading} revision={configurationRevision} autoRefresh={quotaAutoRefresh[provider.id]} onAutoRefresh={enabled => changeQuotaAutoRefresh(provider.id, enabled)} />)}{!providers.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>{tr("请先添加供应商并设置额度适配器。")}</p>}</div></>}
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
    {snapshot && !snapshot.membership.activated && <div className="space-y-3"><div className="flex flex-wrap gap-2">{can('skills_backups_list') && <button type="button" onClick={() => setTab('skills')} className={button}>{tr("恢复 Skills 配置")}</button>}{can('portable_recoveries_list') && <button type="button" onClick={() => setTab('portable')} className={button}>{tr("检查中断导入恢复")}</button>}</div>{selectedTab === 'skills' && can('skills_backups_list') && <AiSkillsPanel recoveryOnly active={active} onRequest={request} can={can} theme={theme} isDark={isDark} showToast={showToast} />}{selectedTab === 'portable' && can('portable_recoveries_list') && <AiPortablePanel recoveryOnly active={active} onRequest={request} can={can} theme={theme} showToast={showToast} onImported={imported} />}</div>}
    {!snapshot && loading && <p role="status" className={`p-8 text-center text-sm ${theme.textMuted}`}>{tr("正在读取 AI 工具本地状态…")}</p>}
    {active && form && can('provider_save') && <AiProviderForm key={form.provider?.id || `new:${form.toolId || ''}`} provider={form.provider} defaultToolId={form.toolId} focusModels={form.focusModels} tools={tools} theme={theme} isDark={isDark} onReadModels={form.provider && can('models_list') ? () => readModels(form.provider.id) : undefined} onSave={saveProvider} onClose={() => setForm(null)} />}
    {active && models && <AiModelsDialog key={models.provider.id} provider={models.provider} models={models.items} theme={theme} isDark={isDark} canSave={can('provider_save')} onReadModels={can('models_list') ? () => readModels(models.provider.id) : undefined} onClose={() => setModels(null)} onSave={saveModels} />}
    {active && preview && aiToolsCan(snapshot, preview.resourceMode ? 'resources_apply' : 'config_apply', { restoring: preview.restoring }) && <AiConfigPreview preview={preview.value} restoring={preview.restoring} theme={theme} onApply={applyPreview} onClose={() => setPreview(null)} />}
    {active && remove && <AiToolsDialog title={tr("删除 AI 供应商？")} theme={theme} busy={removing} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("只删除本软件保存的供应商和密钥，不删除或还原任何工具的现有配置。")}</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{tr(error)}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={removing} onClick={() => setRemove(null)} className={button}>{tr("取消")}</button><button type="button" disabled={removing || !can('provider_remove')} onClick={removeProvider} className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm text-white disabled:opacity-50">{removing && <Loader2 size={14} className="animate-spin" />}{tr("确认删除供应商")}</button></div></AiToolsDialog>}
  </section>;
}
