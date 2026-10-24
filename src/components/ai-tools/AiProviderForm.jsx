import { tr, useLocale } from '../../shared/i18n.js';
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';
import { AI_PROTOCOLS, providerDraft, providerInput } from './aiToolsModel';
import { AI_PROVIDER_PRESETS, applyProviderPreset } from './aiProviderPresets';
import AiQuotaTemplateEditor from './AiQuotaTemplateEditor';
import AiClaudeModelsEditor from './AiClaudeModelsEditor';
import { providerModelReadBlockReason } from './aiClaudeModelsModel';
import AiCliConfigEditor from './AiCliConfigEditor';


export default function AiProviderForm({ provider, tools, theme, isDark, onSave, onClose, onReadModels, focusModels = false, defaultToolId }) {
  useLocale();
  const QUOTA_OPTIONS = [
  { value: '', label: tr("不配置额度查询") }, { value: 'deepseek', label: tr("DeepSeek 余额") }, { value: 'openrouter', label: tr("OpenRouter 余额") },
  { value: 'siliconflow', label: tr("硅基流动余额") }, { value: 'stepfun', label: tr("阶跃星辰余额") }, { value: 'novita', label: tr("Novita 余额") },
  { value: 'kimi', label: 'Kimi Coding Plan' }, { value: 'zhipu', label: tr("智谱 Coding Plan") }, { value: 'minimax', label: 'MiniMax Coding Plan' },
  { value: 'custom', label: tr("自定义查询（声明式 JSON）") },
];
  const id = useId(); const [draft, setDraft] = useState(() => providerDraft(provider, { defaultToolId, tools }));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [preset, setPreset] = useState('');
  const set = (key, value) => { setError(''); setDraft(previous => ({ ...previous, [key]: value })); };
  const input = `mt-1 w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${theme.input}`;
  const submit = async event => {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true);
    try { await onSave(providerInput(draft, provider)); onClose(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <AiToolsDialog title={provider ? tr("编辑 AI 供应商") : tr("添加 AI 供应商")} theme={theme} busy={busy} onClose={onClose} wide>
    <form onSubmit={submit} className="space-y-3"><p className={`text-xs leading-5 ${theme.textMuted}`}>{tr("保存不会自动改写工具配置或发起模型推理。已配置的额度会按自动刷新开关，在页面可见时查询。")}</p>
      {!provider && <div><label htmlFor={`${id}-preset`} className="text-xs">{tr("快速填写常用供应商")}</label><SelectMenu id={`${id}-preset`} value={preset} options={[{ value: '', label: tr("手动配置") }, ...AI_PROVIDER_PRESETS.map(item => ({ ...item, label: tr(item.label) }))]} onChange={value => { setPreset(value); if (value) setDraft(previous => applyProviderPreset(previous, value)); }} isDark={isDark} disabled={busy} className="mt-1" /><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{tr("模板会填写地址与协议，并清空草稿密钥和模型；请自行填写可用模型，不会导入登录凭据。")}</p></div>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">{tr("名称")}<input aria-label={tr("AI 供应商名称")} autoFocus={!focusModels} required maxLength={120} value={draft.name} onChange={event => set('name', event.target.value)} disabled={busy} className={input} /></label><div><label htmlFor={`${id}-protocol`} className="text-xs">{tr("接口协议")}</label><SelectMenu id={`${id}-protocol`} value={draft.protocol} options={AI_PROTOCOLS} onChange={value => set('protocol', value)} isDark={isDark} disabled={busy} className="mt-1" /></div></div>
      <label className="block text-xs">{tr("服务地址")}<input aria-label={tr("AI 服务地址")} required placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => set('baseUrl', event.target.value)} disabled={busy} className={input} /></label>
      <label className="block text-xs">{tr("API 密钥")}<input aria-label={tr("AI API 密钥")} type="password" autoComplete="new-password" maxLength={8192} value={draft.apiKey} onChange={event => set('apiKey', event.target.value)} disabled={busy || draft.clearKey} placeholder={provider?.hasCredential ? tr("已保存密钥，留空保持不变") : tr("可稍后填写；无凭据不会发送网络请求")} className={input} /></label>
      {provider?.hasCredential && <label className={`flex items-center gap-2 text-xs ${theme.textMuted}`}><input type="checkbox" checked={draft.clearKey} disabled={busy} onChange={event => set('clearKey', event.target.checked)} />{tr("明确移除此供应商已保存的 API 密钥")}</label>}
      <AiClaudeModelsEditor value={{ model: draft.model, ...(draft.claudeModels === undefined ? {} : { claudeModels: draft.claudeModels }) }} onChange={value => { setError(''); setDraft(previous => ({ ...previous, ...value })); }} protocol={draft.protocol} onReadModels={onReadModels} readBlockedReason={providerModelReadBlockReason(draft, provider)} catalogKey={`${provider?.id || 'new'}:${draft.protocol}:${draft.baseUrl}`} focusModels={focusModels} theme={theme} isDark={isDark} disabled={busy} />
      <fieldset className="rounded-lg border border-slate-400/20 p-3"><legend className="px-1 text-xs">{tr("准备使用的工具（仅标记，不会立即写入）")}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{tools.map(tool => <label key={tool.id} title={tool.configSupported ? undefined : tool.launchSupported ? tr("仅用于受管项目启动，不改写全局配置") : tool.reason} className={`flex items-center gap-1.5 text-xs ${!(tool.configSupported || tool.launchSupported) ? 'opacity-50' : ''}`}><input type="checkbox" disabled={busy || !(tool.configSupported || tool.launchSupported)} checked={draft.targetApps.includes(tool.id)} onChange={event => set('targetApps', event.target.checked ? [...draft.targetApps, tool.id] : draft.targetApps.filter(value => value !== tool.id))} />{tool.label}</label>)}</div></fieldset>
      {draft.targetApps.some(tool => ['grokbuild', 'kimi'].includes(tool)) && <label className="block text-xs">{tr("模型上下文上限（按服务商说明填写）")}<input aria-label={tr("AI 模型上下文上限")} type="number" min={1} max={2147483647} step={1} value={draft.contextWindow} onChange={event => set('contextWindow', event.target.value)} disabled={busy} className={input} /><span className={`mt-1 block text-[11px] ${theme.textMuted}`}>{tr("应用 Grok Build / Kimi Code 配置前必须填写真实值，不会代填默认容量。")}</span></label>}
      <AiCliConfigEditor value={draft.cliConfig} onChange={value => set('cliConfig', value)} targetApps={draft.targetApps} protocol={draft.protocol} theme={theme} isDark={isDark} disabled={busy} />
      <details className="rounded-lg border border-slate-400/20 p-3"><summary className="cursor-pointer text-xs">{tr("额度查询设置（可选）")}</summary><div className="mt-3 space-y-3"><div><label htmlFor={`${id}-quota`} className="text-xs">{tr("额度适配器")}</label><SelectMenu id={`${id}-quota`} value={draft.quota?.adapter || ''} options={draft.quota?.adapter && !QUOTA_OPTIONS.some(item => item.value === draft.quota.adapter) ? [...QUOTA_OPTIONS, { value: draft.quota.adapter, label: tr("{0}（已保存）", { 0: draft.quota.adapter }) }] : QUOTA_OPTIONS} onChange={adapter => set('quota', adapter ? { ...(draft.quota?.adapter === adapter ? draft.quota : {}), adapter } : null)} isDark={isDark} disabled={busy} className="mt-1" /></div>
        {draft.quota && <><label className="block text-xs">{tr("独立额度密钥的授权域名（HTTPS origin）")}<input aria-label={tr("AI 额度密钥授权域名")} value={draft.quota.credentialOrigin || ''} onChange={event => set('quota', { ...draft.quota, credentialOrigin: event.target.value })} disabled={busy} className={input} /></label><label className="block text-xs">{tr("独立额度查询密钥（可选）")}<input aria-label={tr("AI 额度查询密钥")} type="password" autoComplete="new-password" maxLength={8192} value={draft.quotaKey} onChange={event => set('quotaKey', event.target.value)} disabled={busy || draft.clearQuotaKey} placeholder={provider?.hasQuotaCredential ? tr("已保存，留空保持不变") : tr("仅在额度接口需要独立密钥时填写")} className={input} /></label>{provider?.hasQuotaCredential && <label className={`flex items-center gap-2 text-xs ${theme.textMuted}`}><input type="checkbox" checked={draft.clearQuotaKey} disabled={busy} onChange={event => set('clearQuotaKey', event.target.checked)} />{tr("移除已保存的额度查询密钥")}</label>}<p className={`text-xs ${theme.textMuted}`}>{tr("额度来自服务商接口，与本机用量不同；未支持的接口会明确显示不可用。")}</p></>}
        {!draft.quota && provider?.hasQuotaCredential && <label className={`flex items-center gap-2 text-xs ${theme.textMuted}`}><input type="checkbox" checked={draft.clearQuotaKey} disabled={busy} onChange={event => set('clearQuotaKey', event.target.checked)} />{tr("同时移除已保存的额度查询密钥")}</label>}
        {draft.quota?.adapter === 'custom' && <AiQuotaTemplateEditor value={draft.quotaTemplate} onChange={value => set('quotaTemplate', value)} theme={theme} disabled={busy} />}
      </div></details>
      {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
      <div className="flex justify-end gap-2 pt-1"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("取消")}</button><button type="submit" disabled={busy} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{tr("保存供应商")}</button></div>
    </form>
  </AiToolsDialog>;
}
