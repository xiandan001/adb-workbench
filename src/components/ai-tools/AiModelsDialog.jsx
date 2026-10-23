import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';

export default function AiModelsDialog({ provider, models, theme, isDark, canSave, onSave, onClose }) {
  const id = useId(); const [search, setSearch] = useState(''); const [model, setModel] = useState(provider.model || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const matching = models.filter(item => `${item.id} ${item.name || ''}`.toLowerCase().includes(search.toLowerCase()));
  const options = matching.slice(0, 200).map(item => ({ value: item.id, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id }));
  if (model && !options.some(item => item.value === model)) options.unshift({ value: model, label: model });
  const save = async () => { if (busy || !model) return; setBusy(true); setError(''); try { await onSave(model); onClose(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
  return <AiToolsDialog title={`${provider.name} 的模型列表`} theme={theme} busy={busy} onClose={onClose}><p className={`mb-3 text-xs leading-5 ${theme.textMuted}`}>已读取 {models.length} 个模型。保存默认模型只更新供应商配置，尚不会改写任何工具。</p><input aria-label="搜索 AI 模型" value={search} onChange={event => setSearch(event.target.value)} placeholder="按模型名称或 ID 搜索" className={`mb-3 w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`} /><label htmlFor={id} className="text-xs">默认模型</label><SelectMenu id={id} value={model} options={options} onChange={setModel} isDark={isDark} disabled={busy} emptyText="没有匹配的模型" className="mt-1" />{matching.length > 200 && <p className={`mt-2 text-xs ${theme.textMuted}`}>仅展示前 200 项，可输入关键词缩小范围。</p>}{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>关闭</button><button type="button" disabled={busy || !canSave || !model} onClick={save} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}保存默认模型</button></div></AiToolsDialog>;
}
