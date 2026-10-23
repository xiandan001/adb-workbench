import { useId, useState } from 'react';
import { FileDiff, Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';

export default function AiConfigPanel({ providers, tools, theme, isDark, canPreview, onPreview }) {
  const id = useId(); const [providerId, setProviderId] = useState(''); const [toolId, setToolId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const provider = providers.find(item => item.id === providerId) || providers[0];
  const supported = tool => tool.configSupported && (!provider || tool.protocols.includes(provider.protocol) && provider.targetApps?.includes(tool.id));
  const toolLabel = tool => `${tool.label}${!tool.configSupported ? tool.launchSupported ? '（项目受管启动）' : '（暂不支持）' : provider && !tool.protocols.includes(provider.protocol) ? '（协议不匹配）' : provider && !provider.targetApps?.includes(tool.id) ? '（请先在供应商中勾选）' : ''}`;
  const tool = tools.find(item => item.id === toolId && supported(item)) || tools.find(supported);
  const preview = async () => {
    if (!provider || !tool || busy) return; setBusy(true); setError('');
    try { await onPreview({ providerId: provider.id, toolId: tool.id }); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <section aria-label="AI 工具配置" className={`rounded-xl border p-4 ${theme.card}`}><h3 className="text-sm font-semibold">先预览，再应用到本机工具</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>不会自动导入已有登录凭据；点击预览后才读取目标配置。应用时只写入受管理字段，并创建恢复备份。</p>
    <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"><div><label htmlFor={`${id}-provider`} className="text-xs">供应商</label><SelectMenu id={`${id}-provider`} value={provider?.id || ''} options={providers.map(item => ({ value: item.id, label: item.name }))} emptyText="请先保存供应商" onChange={setProviderId} isDark={isDark} disabled={busy} className="mt-1" /></div><div><label htmlFor={`${id}-tool`} className="text-xs">目标工具</label><SelectMenu id={`${id}-tool`} value={tool?.id || ''} options={tools.map(item => ({ value: item.id, label: toolLabel(item), disabled: !supported(item) }))} emptyText="暂无可用配置适配器" onChange={setToolId} isDark={isDark} disabled={busy} className="mt-1" /></div><button type="button" disabled={!provider || !tool || !canPreview || busy} onClick={preview} className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{busy ? <Loader2 size={15} className="animate-spin" /> : <FileDiff size={15} />}预览变更</button></div>
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{tools.map(item => <span key={item.id} title={item.reason || item.protocols.join(' / ')} className={`rounded-md border border-slate-400/20 px-2 py-1 text-[11px] ${item.configSupported ? (isDark ? 'text-emerald-300' : 'text-emerald-600') : theme.textMuted}`}>{item.label} · {item.configSupported ? '配置适配已接通' : item.launchSupported ? '项目受管启动（不改全局）' : '未接通，不会修改'}</span>)}</div>
  </section>;
}
