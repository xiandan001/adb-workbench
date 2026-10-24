import { tr, useLocale } from '../../shared/i18n.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, Loader2, WandSparkles } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { CLAUDE_MODEL_ROLES, claudeRoleSupports1m, fillClaudeRoles, modelCatalogOptions, modelReadFeedback, updateClaudeRole } from './aiClaudeModelsModel';

function ModelField({ id, label, value, onChange, options, hasCatalog, theme, isDark, disabled, autoFocus = false, compact = false, placeholder = tr("填写服务商提供的模型 ID") }) {
  useLocale();
  return <div className="min-w-0"><label htmlFor={id} className={compact ? 'sr-only' : 'text-xs'}>{label}</label><div className={`grid gap-2 ${compact ? '' : 'mt-1'} ${hasCatalog ? compact ? 'grid-cols-[minmax(0,1fr)_72px]' : 'sm:grid-cols-[minmax(0,1fr)_150px]' : ''}`}>
    <input id={id} aria-label={label} autoFocus={autoFocus} maxLength={256} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} spellCheck={false} placeholder={placeholder} className={`min-w-0 w-full rounded-lg border px-3 py-2 font-mono text-xs disabled:opacity-50 ${theme.input}`} />
    {hasCatalog && <><label htmlFor={`${id}-choice`} className="sr-only">{tr("选择{0}", { 0: label })}</label><SelectMenu id={`${id}-choice`} value={value} options={options} onChange={onChange} isDark={isDark} disabled={disabled} placeholder={compact ? tr("选择") : tr("从列表选择")} emptyText={tr("没有匹配模型，请修改搜索或手填")} compact /></>}
  </div></div>;
}

export default function AiClaudeModelsEditor({ value, onChange, protocol, models = [], onReadModels, readBlockedReason = '', catalogKey = '', focusModels = false, theme, isDark, disabled = false }) {
  useLocale();
  const id = useId(); const mounted = useRef(false);
  const [search, setSearch] = useState(''); const [reading, setReading] = useState(false); const [catalog, setCatalog] = useState(null);
  const [feedback, setFeedback] = useState(null); const [expanded, setExpanded] = useState(focusModels);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sourceModels = readBlockedReason ? [] : catalog?.key === catalogKey ? catalog.models : models;
  const { options, count } = modelCatalogOptions(sourceModels, search); const hasCatalog = sourceModels.length > 0;
  const currentFeedback = feedback?.key === catalogKey && (!feedback.network || !readBlockedReason) ? feedback : null;
  const readModels = async () => {
    if (!onReadModels || readBlockedReason || disabled || reading) return;
    setReading(true); setFeedback(null); const key = catalogKey;
    try {
      const result = await onReadModels();
      if (!Array.isArray(result?.models) || result.models.some(row => typeof row?.id !== 'string')) throw new Error(tr("模型列表格式无效，仍可手动配置。"));
      if (mounted.current) { setCatalog({ key, models: result.models }); setFeedback({ key, network: true, kind: result.models.length ? 'success' : 'warning', message: result.models.length ? tr("已读取 {0} 个模型，可搜索后在各行选择。", { 0: result.models.length }) : tr("服务返回了空模型列表，请手动填写模型 ID。") }); }
    } catch (error) { if (mounted.current) setFeedback({ key, network: true, ...modelReadFeedback(error) }); }
    finally { if (mounted.current) setReading(false); }
  };
  const fill = () => {
    try { onChange({ ...value, claudeModels: fillClaudeRoles(value.claudeModels, value.model) }); setFeedback({ key: catalogKey, kind: 'success', message: tr("已将默认模型填入四个角色；子任务模型保持不变，1M 需另行明确勾选。") }); }
    catch (error) { setFeedback({ key: catalogKey, kind: 'error', message: error.message }); }
  };
  return <section aria-label={tr("模型配置")} className="rounded-lg border border-slate-400/20 p-3">
    <div className="mb-3 flex flex-wrap items-center gap-2"><h4 className="min-w-0 flex-1 text-sm font-medium">{tr("模型配置")}</h4><button type="button" onClick={readModels} disabled={disabled || reading || !onReadModels || Boolean(readBlockedReason)} title={readBlockedReason || tr("只读取已保存供应商的模型列表，不发送付费对话")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{reading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{tr("读取模型列表")}</button></div>
    <p className={`mb-3 text-[11px] leading-5 ${theme.textMuted}`}>{readBlockedReason || tr("模型 ID 可直接手填；读取列表仅作选择参考，不会自动切换供应商或发起对话。")}</p>
    {hasCatalog && <div className="mb-3"><input aria-label={tr("搜索已读取的 AI 模型")} value={search} onChange={event => setSearch(event.target.value)} disabled={disabled} placeholder={tr("搜索模型名称或 ID，再从下拉框选择")} className={`w-full rounded-lg border px-3 py-2 text-xs ${theme.input}`} />{count > 200 && <p className={`mt-1 text-[11px] ${theme.textMuted}`}>{tr("匹配 {0} 项，仅展示前 200 项，请缩小搜索范围。", { 0: count })}</p>}</div>}
    <ModelField id={`${id}-default`} label={tr("AI 默认模型")} value={value.model} onChange={model => onChange({ ...value, model })} options={options} hasCatalog={hasCatalog} theme={theme} isDark={isDark} disabled={disabled} autoFocus={focusModels} />
    <p className={`mt-1 text-[11px] ${theme.textMuted}`}>{tr("作为默认 / 兜底模型。保存只更新供应商，点击「使用」并确认预览后才应用到工具。")}</p>
    {protocol === 'anthropic' && <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} className="mt-3 border-t border-slate-400/20 pt-3"><summary className="cursor-pointer text-xs font-medium">{tr("高级：Claude 角色模型（可选）")}</summary><div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2"><p className={`min-w-0 flex-1 text-[11px] leading-5 ${theme.textMuted}`}>{tr("未编辑的角色保持原配置；已编辑的角色留空时，将在应用后移除该角色覆盖。")}</p><button type="button" disabled={disabled || !value.model.trim()} onClick={fill} className={`inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`}><WandSparkles size={13} />{tr("四个角色使用默认模型")}</button></div>
      <div className="overflow-hidden rounded-lg border border-slate-400/20"><div className={`hidden grid-cols-[72px_minmax(0,1fr)_minmax(0,1.5fr)_48px] gap-2 border-b border-slate-400/20 px-3 py-2 text-[11px] sm:grid ${theme.textMuted}`}><span>{tr("模型角色")}</span><span>{tr("显示名称（可选）")}</span><span>{tr("实际请求模型")}</span><span>{tr("1M 声明")}</span></div>{CLAUDE_MODEL_ROLES.map(role => {
        const row = value.claudeModels?.[role.id] || { model: '', displayName: '', supports1m: false };
        const change = patch => onChange({ ...value, claudeModels: updateClaudeRole(value.claudeModels, role.id, patch) });
        return <div key={role.id} className="grid items-center gap-2 border-b border-slate-400/15 p-3 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)_minmax(0,1.5fr)_48px]"><span className="text-xs font-semibold" title={role.description ? tr(role.description) : undefined}>{role.label}</span>
          {role.id !== 'subagent' ? <input aria-label={tr("{0} 显示名称", { 0: role.label })} maxLength={120} value={row.displayName || ''} onChange={event => change({ displayName: event.target.value })} disabled={disabled || !row.model.trim()} placeholder={tr("/model 菜单名称")} className={`w-full rounded-lg border px-2 py-2 text-xs disabled:opacity-50 ${theme.input}`} /> : <span className={`text-[10px] ${theme.textMuted}`}>{tr("子任务模型，不显示在菜单")}</span>}
          <ModelField id={`${id}-${role.id}`} label={tr("{0} 实际请求模型", { 0: role.label })} value={row.model} onChange={model => change({ model })} options={options} hasCatalog={hasCatalog} theme={theme} isDark={isDark} disabled={disabled} placeholder={tr("未配置；保持工具原行为")} compact />
          <label className={`flex items-center gap-1 text-[11px] sm:justify-center ${theme.textMuted}`} title={tr("仅向客户端声明 1M 上下文，不能证明服务商或套餐支持")}><input type="checkbox" aria-label={tr("{0} 声明支持 1M 上下文", { 0: role.label })} checked={claudeRoleSupports1m(row)} disabled={disabled || !row.model.trim()} onChange={event => change({ supports1m: event.target.checked })} /><span className="sm:hidden">{tr("声明支持 1M")}</span></label>
        </div>;
      })}</div><p className="text-[11px] leading-5 text-amber-500">{tr("1M 仅是向客户端声明上下文能力，不保证服务商或套餐支持；请按服务商说明勾选，默认不开启。")}</p>
    </div></details>}
    {currentFeedback && <p role={currentFeedback.kind === 'error' ? 'alert' : 'status'} className={`mt-3 text-xs leading-5 ${currentFeedback.kind === 'error' ? 'text-red-500' : currentFeedback.kind === 'warning' ? 'text-amber-500' : 'text-emerald-500'}`}>{tr(currentFeedback.message)}</p>}
  </section>;
}
