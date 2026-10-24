import { tr, useLocale } from '../../shared/i18n.js';
import { useId, useMemo, useState } from 'react';
import { Braces, Check, Code2 } from 'lucide-react';
import { parseQuotaTemplate, stringifyQuotaTemplate } from './aiQuotaTemplateModel';

export default function AiQuotaTemplateEditor({ value, onChange, theme, disabled = false }) {
  useLocale();
  const id = useId(); const [touched, setTouched] = useState(false);
  const validation = useMemo(() => {
    if (!value.trim()) return { valid: false, message: tr("请填写接口请求及字段提取规则。") };
    try { parseQuotaTemplate(value); return { valid: true, message: tr("JSON 与字段校验通过；尚未联网验证路径和响应。") }; }
    catch (error) { return { valid: false, message: error.message }; }
  }, [value]);
  const format = () => { setTouched(true); try { onChange(JSON.stringify(parseQuotaTemplate(value), null, 2)); } catch { /* Inline validation explains the failure; retain the draft. */ } };
  return <section aria-label={tr("自定义额度查询模板")} className="rounded-lg border border-slate-400/20 p-3">
    <div className="flex flex-wrap items-center gap-2"><Code2 size={15} className="text-emerald-500" /><label htmlFor={id} className="min-w-0 flex-1 text-xs font-medium">{tr("高级：声明式 JSON 查询模板")}</label><button type="button" disabled={disabled || !validation.valid} onClick={format} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] disabled:opacity-40 ${theme.button.secondary}`}><Braces size={12} />{tr("格式化 JSON")}</button></div>
    <p className={`mt-2 text-[11px] leading-5 ${theme.textMuted}`}>{tr("只支持 HTTPS 相对路径、GET / POST 及 JSON 字段提取，不运行 JavaScript。密钥和授权域名请填写外层专用字段，不要写入模板。只填写服务商明确的只读额度接口，POST 是否只读由服务商定义。")}</p>
    <textarea id={id} aria-describedby={`${id}-status`} spellCheck={false} value={value} onChange={event => onChange(event.target.value)} onBlur={() => setTouched(true)} disabled={disabled} rows={13} maxLength={256 * 1024} className={`mt-2 w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-5 disabled:opacity-50 ${theme.input}`} />
    <p id={`${id}-status`} role={touched && !validation.valid ? 'alert' : 'status'} className={`mt-1 flex items-start gap-1 text-[11px] leading-5 ${validation.valid ? 'text-emerald-500' : touched ? 'text-red-500' : theme.textMuted}`}>{validation.valid && <Check size={12} className="mt-1 shrink-0" />}{validation.valid || touched ? tr(validation.message) : tr("格式化和保存只校验配置，不会发送请求；额度查询需另行点击刷新。")}</p>
    <details className="mt-2"><summary className={`cursor-pointer text-[11px] ${theme.textMuted}`}>{tr("结构示例与字段说明")}</summary><p className="mt-2 text-[11px] leading-5 text-amber-500">{tr("这只是结构示例，不代表任何服务商的真实接口。必须替换真实路径、响应字段和单位，再保存使用。")}</p><pre className={`mt-2 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[10px] ${theme.input}`}>{stringifyQuotaTemplate()}</pre><p className={`mt-2 text-[11px] leading-5 ${theme.textMuted}`}>{tr("kind：balance 或 plan。metrics：每项填写 label、unit，以及 remaining / used / total 中至少一个 JSON 路径；resetAt 可选。支持 data.items[0].balance，不支持计算表达式。请求头只接受公开 JSON 类型和用户 / 组织 / 项目标识，Authorization 自动使用外层已保存密钥。")}</p>{!value.trim() && <button type="button" disabled={disabled} onClick={() => onChange(stringifyQuotaTemplate())} className={`mt-2 rounded-md px-2 py-1 text-[11px] disabled:opacity-40 ${theme.button.secondary}`}>{tr("填入结构示例")}</button>}</details>
  </section>;
}
