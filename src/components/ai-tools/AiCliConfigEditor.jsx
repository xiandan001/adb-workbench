import { useId } from 'react';
import { RotateCcw, X } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { AI_CLI_CONFIG_FIELDS, updateCliOption } from './aiCliConfigModel';

function NativeField({ descriptor, value, onChange, theme, isDark, disabled }) {
  const id = useId(); const auth = descriptor.key === 'authField'; const cleared = value === null && !auth;
  const options = [{ value: '', label: auth ? '默认：ANTHROPIC_AUTH_TOKEN' : '保持原配置' }, ...(!auth ? [{ value: '__clear__', label: '移除此项，恢复工具默认' }] : []), ...(descriptor.type === 'boolean' ? [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }] : (descriptor.values || []).map(item => ({ value: item, label: item })))];
  return <div className="min-w-0"><div className="mb-1 flex items-center gap-1"><label htmlFor={id} className="min-w-0 flex-1 text-xs">{descriptor.label}</label>{descriptor.type === 'integer' && <><button type="button" disabled={disabled} aria-label={`${descriptor.label}恢复默认`} title="明确移除此项，恢复工具默认" onClick={() => onChange(null)} className="rounded p-1 disabled:opacity-40"><RotateCcw size={12} /></button><button type="button" disabled={disabled || value === undefined} aria-label={`${descriptor.label}保持原配置`} title="本次不修改此项" onClick={() => onChange(undefined)} className="rounded p-1 disabled:opacity-40"><X size={12} /></button></>}</div>
    {descriptor.type === 'integer' ? <input id={id} aria-label={descriptor.label} type="number" min={descriptor.min} max={descriptor.max} step={1} value={value ?? ''} placeholder={cleared ? '应用后移除此项' : '保持原配置'} disabled={disabled} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value)} className={`w-full rounded-lg border px-3 py-2 text-xs disabled:opacity-50 ${theme.input}`} /> : <SelectMenu id={id} value={value === undefined || auth && value === null ? '' : cleared ? '__clear__' : String(value)} options={options} disabled={disabled} isDark={isDark} compact onChange={next => onChange(next === '' ? undefined : next === '__clear__' ? null : descriptor.type === 'boolean' ? next === 'true' : next)} />}
    {(cleared || descriptor.hint) && <p className={`mt-1 text-[10px] leading-4 ${cleared ? 'text-amber-500' : theme.textMuted}`}>{cleared ? '将从原生配置移除此项；其余项目保持不变。' : descriptor.hint}</p>}
  </div>;
}

export default function AiCliConfigEditor({ value, onChange, targetApps, protocol, theme, isDark, disabled }) {
  const tools = ['claude', 'codex'].filter(tool => targetApps.includes(tool) || tool === 'claude' && protocol === 'anthropic' || tool === 'codex' && protocol === 'openai-responses');
  if (!tools.length) return null;
  const set = (tool, key, item) => onChange(updateCliOption(value, tool, key, item));
  const textarea = `mt-2 w-full resize-y rounded-lg border p-3 font-mono text-xs leading-5 disabled:opacity-50 ${theme.input}`;
  return <details className="rounded-lg border border-slate-400/20 p-3"><summary className="cursor-pointer text-xs font-medium">CLI 原生高级设置（可选）</summary><div className="mt-3 space-y-4">
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>留空 / 保持原配置不会修改本机值；「移除此项」需在预览确认后才生效。仅修改列出的原生字段，并创建可恢复备份，不读取或改写 OAuth 登录文件。</p>
    {tools.map(tool => <section key={tool} aria-label={`${tool === 'claude' ? 'Claude Code' : 'Codex'} 原生高级设置`} className="space-y-3"><h4 className="text-sm font-semibold">{tool === 'claude' ? 'Claude Code · settings.json' : 'Codex · config.toml'}</h4>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{AI_CLI_CONFIG_FIELDS[tool].map(descriptor => <NativeField key={descriptor.key} descriptor={descriptor} value={value?.[tool]?.[descriptor.key]} onChange={item => set(tool, descriptor.key, item)} theme={theme} isDark={isDark} disabled={disabled} />)}</div>
      {tool === 'codex' && <label className="block text-xs">自定义请求头（JSON，可选）<textarea aria-label="Codex 自定义请求头 JSON" rows={4} maxLength={8192} value={value?.codex?.httpHeadersText || ''} onChange={event => set('codex', 'httpHeadersText', event.target.value)} disabled={disabled} spellCheck={false} placeholder={'{\n  "User-Agent": "my-client",\n  "OpenAI-Project": "project-id"\n}'} className={textarea} /><span className={`mt-1 block text-[11px] leading-5 ${theme.textMuted}`}>支持 User-Agent、OpenAI-Organization、OpenAI-Project、HTTP-Referer、X-Title。认证密钥仅填专用字段；单个值写 null 可删除该头，整个输入为 null 清除自定义头。</span></label>}
      <details className="rounded-lg border border-slate-400/15 p-3"><summary className="cursor-pointer text-xs">{tool === 'claude' ? '原生补充 JSON / JSONC' : '原生补充 TOML'}</summary>
        <textarea aria-label={tool === 'claude' ? 'Claude 补充 JSON' : 'Codex 补充 TOML'} rows={7} maxLength={65536} spellCheck={false} disabled={disabled} value={value?.[tool]?.[tool === 'claude' ? 'settingsJson' : 'extraToml'] || ''} onChange={event => set(tool, tool === 'claude' ? 'settingsJson' : 'extraToml', event.target.value)} placeholder={tool === 'claude' ? '{\n  "language": "简体中文",\n  "showTurnDuration": true\n}' : 'hide_agent_reasoning = false\n\n[tui]\nanimations = true\nalternate_screen = "auto"'} className={textarea} />
        <p className={`mt-1 text-[11px] leading-5 ${theme.textMuted}`}>{tool === 'claude' ? '支持 language、outputStyle、alwaysThinkingEnabled、respectGitignore、showTurnDuration、spinnerTipsEnabled、terminalProgressBarEnabled、teammateMode、attribution.commit / pr。JSON 叶子字段为 null 时删除该字段。' : '支持 hide_agent_reasoning、show_raw_agent_reasoning、check_for_update_on_startup、file_opener、project_doc_max_bytes，以及 history.persistence / max_bytes、tui.animations / alternate_screen、feedback.enabled。'}</p>
        <p className="mt-2 text-[11px] leading-5 text-amber-500">补充配置不得重复模型、地址或凭据字段。权限绕过、Hooks、命令、MCP / 插件不在此自动启用，已有值保持原样；请在工具原生配置中单独管理。清空补充文本不会回滚已应用内容，可使用配置备份恢复。任意自定义请求 body 不是这些 CLI 的通用原生选项。</p>
      </details>
    </section>)}
  </div></details>;
}
