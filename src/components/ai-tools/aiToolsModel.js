import { tr, getLocale } from '../../shared/i18n.js';
import { parseQuotaTemplate, stringifyQuotaTemplate } from './aiQuotaTemplateModel.js';
import { cloneClaudeModels, modelConfigurationInput } from './aiClaudeModelsModel.js';
import { cliConfigDraft, cliConfigInput, cliEndpointError } from './aiCliConfigModel.js';

export const AI_PROTOCOLS = Object.freeze([
  { value: 'openai-chat', label: 'OpenAI Chat Completions' }, { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' }, { value: 'gemini', label: 'Gemini Native' },
]);
export function providerDraft(provider, { defaultToolId, tools = [] } = {}) {
  const tool = !provider && tools.find(row => row.id === defaultToolId && (row.configSupported || row.launchSupported));
  return { id: provider?.id, name: provider?.name || '', protocol: provider?.protocol || tool?.protocols?.[0] || 'openai-chat', baseUrl: provider?.baseUrl || '',
    model: provider?.model || '', ...(provider?.claudeModels === undefined ? {} : { claudeModels: cloneClaudeModels(provider.claudeModels) }), contextWindow: provider?.contextWindow === undefined ? '' : String(provider.contextWindow), targetApps: [...(provider?.targetApps || (tool ? [tool.id] : []))], apiKey: '', clearKey: false, quotaKey: '', clearQuotaKey: false,
    ...(provider?.cliConfig === undefined ? {} : { cliConfig: cliConfigDraft(provider.cliConfig) }),
    quota: provider?.quota ? { ...provider.quota } : null, quotaTemplate: stringifyQuotaTemplate(provider?.quota?.adapter === 'custom' ? provider.quota : null) };
}
export function providerInput(draft, original) {
  const name = draft.name.trim(); const model = draft.model.trim(); const apiKey = draft.apiKey.trim(); const quotaKey = draft.quotaKey.trim();
  if (!name || name.length > 120) throw new Error(tr("请填写不超过 120 字的供应商名称"));
  if (!AI_PROTOCOLS.some(item => item.value === draft.protocol)) throw new Error(tr("请选择支持的接口协议"));
  let url;
  try { url = new URL(draft.baseUrl.trim()); } catch { throw new Error(tr("请填写完整的 HTTP 或 HTTPS 服务地址")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(tr("服务地址不能包含登录信息、查询参数或片段"));
  const endpointError = cliEndpointError(draft.protocol, url.href, draft.targetApps); if (endpointError) throw new Error(endpointError);
  if (original?.hasCredential && new URL(original.baseUrl).origin !== url.origin && !apiKey && !draft.clearKey) throw new Error(tr("服务地址已变化，请填写新密钥或明确移除原密钥"));
  const quotaIdentity = (quota, origin) => JSON.stringify([quota?.adapter || null, quota?.credentialOrigin?.trim() || origin]);
  if (original?.hasQuotaCredential && quotaIdentity(original.quota, new URL(original.baseUrl).origin) !== quotaIdentity(draft.quota, url.origin)
    && !quotaKey && !draft.clearQuotaKey) throw new Error(tr("额度查询身份已变化，请填写新的额度密钥或明确移除原额度密钥"));
  if (model.length > 256 || apiKey.length > 8192 || quotaKey.length > 8192) throw new Error(tr("模型或密钥长度超过限制"));
  const result = { ...(draft.id ? { id: draft.id } : {}), name, protocol: draft.protocol, baseUrl: url.href.replace(/\/$/, ''), ...modelConfigurationInput(draft),
    targetApps: [...new Set(draft.targetApps)] };
  if (draft.cliConfig !== undefined) result.cliConfig = cliConfigInput(draft.cliConfig);
  if (draft.contextWindow?.trim()) {
    const contextWindow = Number(draft.contextWindow);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 2147483647) throw new Error(tr("模型上下文上限必须是 1–2147483647 的整数"));
    result.contextWindow = contextWindow;
  } else if (original?.contextWindow !== undefined) result.contextWindow = null;
  if (draft.clearKey) result.apiKey = null; else if (apiKey) result.apiKey = apiKey;
  if (draft.clearQuotaKey) result.quotaKey = null; else if (quotaKey) result.quotaKey = quotaKey;
  if (draft.quota?.adapter) {
    result.quota = draft.quota.adapter === 'custom'
      ? { adapter: 'custom', ...parseQuotaTemplate(draft.quotaTemplate), ...(draft.quota.credentialOrigin ? { credentialOrigin: draft.quota.credentialOrigin } : {}) }
      : { ...draft.quota };
    if (!result.quota.credentialOrigin?.trim()) delete result.quota.credentialOrigin;
  } else result.quota = null;
  return result;
}
export function aiToolsCan(snapshot, command, { restoring = false } = {}) {
  const recovery = ['backups_list', 'backup_preview_restore', 'router_stop', 'resources_backups_list', 'resources_backup_preview_restore',
    'skills_backups_list', 'skills_backup_preview_restore', 'portable_recoveries_list', 'portable_recovery_preview', 'portable_recovery_apply'].includes(command)
    || ['config_apply', 'resources_apply', 'skills_apply'].includes(command) && restoring;
  return snapshot?.capabilities?.includes(command) === true && (snapshot.membership?.activated === true || recovery);
}
export function quotaValue(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(getLocale(), { maximumFractionDigits: 6 }) : '—'; }
export function quotaMetricText(provider, value) { return provider.quota?.adapter === 'custom' ? value : tr(value); }
export function quotaView(result, providerId) {
  if (!result || result.providerId !== providerId) return { status: 'unavailable', observedAt: null, metrics: [], reason: tr("尚未查询，或当前供应商没有可用的额度配置") };
  if (!['fresh', 'stale', 'unavailable', 'error'].includes(result.status)) return { status: 'unavailable', observedAt: null, metrics: [], reason: tr("额度状态无法识别") };
  return { ...result, metrics: ['fresh', 'stale'].includes(result.status) && Array.isArray(result.metrics) ? result.metrics : [] };
}
export function previewValue(change, field) {
  if (change.secret) return '******';
  const value = change[field];
  if (value === undefined || value === null) return tr("（未设置）");
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export function sessionDetailFor(result, selectedId) {
  return result?.id === selectedId && Array.isArray(result.messages) ? result : null;
}
export function routeDraft(route) { return { id: route?.id, name: route?.name || '', protocol: route?.protocol || 'openai-chat', providerIds: [...(route?.providerIds || [])], failover: route?.failover === true }; }
export function routeInput(draft, providers) {
  const name = draft.name.trim();
  if (!name || name.length > 100) throw new Error(tr("请填写不超过 100 字的路由名称"));
  if (!AI_PROTOCOLS.some(item => item.value === draft.protocol)) throw new Error(tr("请选择接口协议"));
  if (!draft.providerIds.length || draft.providerIds.length > 6 || new Set(draft.providerIds).size !== draft.providerIds.length) throw new Error(tr("请选择 1–6 个不重复的同协议供应商"));
  for (const id of draft.providerIds) {
    const provider = providers.find(item => item.id === id);
    if (!provider || provider.protocol !== draft.protocol) throw new Error(tr("列表中存在已删除或非同协议供应商，请调整后保存"));
    if (!provider.hasCredential || !provider.model) throw new Error(tr("每个路由供应商都需要已保存的密钥和默认模型"));
  }
  return { ...(draft.id ? { id: draft.id } : {}), name, protocol: draft.protocol, providerIds: [...draft.providerIds], failover: draft.failover === true };
}
export function moveRouteProvider(ids, index, direction) {
  const next = [...ids]; const target = index + direction;
  if (index >= 0 && index < next.length && target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
}
