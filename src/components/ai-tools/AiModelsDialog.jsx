import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import AiClaudeModelsEditor from './AiClaudeModelsEditor';
import { cloneClaudeModels, modelConfigurationInput } from './aiClaudeModelsModel';

export default function AiModelsDialog({ provider, models = [], theme, isDark, canSave, onSave, onClose, onReadModels }) {
  const [value, setValue] = useState(() => ({ model: provider.model || '', ...(provider.claudeModels === undefined ? {} : { claudeModels: cloneClaudeModels(provider.claudeModels) }) }));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true); setError('');
    try { await onSave(modelConfigurationInput(value, { requireModel: true })); onClose(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <AiToolsDialog title={`${provider.name} 的模型配置`} theme={theme} busy={busy} onClose={onClose} wide>
    <p className={`mb-3 text-xs leading-5 ${theme.textMuted}`}>直接填写默认模型即可开始使用。Claude 角色映射可选；服务不提供模型列表时仍可手动保存。</p>
    <AiClaudeModelsEditor value={value} onChange={next => { setError(''); setValue(next); }} protocol={provider.protocol} models={models} onReadModels={onReadModels} readBlockedReason={provider.hasCredential ? '' : '请先保存 API 密钥，再读取模型列表；手动配置不受影响。'} catalogKey={`${provider.id}:${provider.protocol}:${provider.baseUrl}`} focusModels theme={theme} isDark={isDark} disabled={busy || !canSave} />
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
    <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>关闭</button><button type="button" disabled={busy || !canSave || !value.model.trim()} onClick={save} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}保存模型配置</button></div>
  </AiToolsDialog>;
}
