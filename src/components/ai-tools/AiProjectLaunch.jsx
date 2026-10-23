import { useId, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';
import { projectLaunchProvider } from './aiProjectsModel';

export default function AiProjectLaunch({ project, providers, onRequest, theme, isDark, showToast, onClose }) {
  const id = useId(); const eligible = providers.filter(projectLaunchProvider); const [providerId, setProviderId] = useState(eligible[0]?.id || '');
  const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const needsProvider = project.toolId === 'agy';
  const prepare = async () => {
    if (busy) return; setBusy(true); setError('');
    try {
      const result = await onRequest('projects_launch_preview', { projectId: project.id, ...(needsProvider ? { providerId } : {}) });
      if (!result?.token || !result.executable || !result.cwd) throw new Error('启动预览格式无效，未执行');
      setPreview(result);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const launch = async () => {
    if (busy || !preview) return; setBusy(true); setError('');
    try {
      if (preview.expiresAt <= Date.now()) throw new Error('启动预览已过期，请重新预览');
      const result = await onRequest('projects_launch', { token: preview.token });
      if (result?.launched !== true) throw new Error('未能确认外部终端已启动');
      showToast?.('已在外部终端启动项目工具'); onClose();
    } catch (failure) { setError(failure.message); setPreview(null); } finally { setBusy(false); }
  };
  return <AiToolsDialog title="预览 AI 项目启动" theme={theme} busy={busy} onClose={onClose}><h4 className="text-sm font-semibold">{project.name} · {project.toolId}</h4><p className={`mt-2 break-all font-mono text-xs ${theme.textMuted}`}>{project.path}</p>
    {!preview && <><p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>下一步只检查已安装 CLI 并生成启动预览，不安装软件、不执行命令。确认后才打开外部终端，CLI 可能修改项目或产生服务商费用。</p>{needsProvider && <div className="mt-3"><label htmlFor={`${id}-provider`} className="text-xs">本次受管启动的 Gemini 供应商</label><SelectMenu id={`${id}-provider`} value={providerId} options={eligible.map(item => ({ value: item.id, label: `${item.name} · ${item.model}` }))} onChange={setProviderId} emptyText="需要已配置密钥、模型并勾选 AGY 的 Gemini 供应商" disabled={busy} isDark={isDark} className="mt-1" /></div>}</>}
    {preview && <div className="mt-4 space-y-3"><dl className="space-y-2 text-xs"><div><dt className={theme.textMuted}>将执行的已安装程序</dt><dd className="mt-1 break-all font-mono">{preview.executable}</dd></div><div><dt className={theme.textMuted}>工作目录</dt><dd className="mt-1 break-all font-mono">{preview.cwd}</dd></div><div><dt className={theme.textMuted}>供应商</dt><dd className="mt-1">{preview.providerName || '使用 CLI 当前原生配置'}</dd></div></dl>{preview.warnings?.map((warning, index) => <p key={index} className="rounded-lg border border-amber-500/25 p-2 text-xs leading-5 text-amber-500">{warning}</p>)}</div>}
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>取消</button><button type="button" disabled={busy || (!preview && needsProvider && !eligible.some(item => item.id === providerId))} onClick={preview ? launch : prepare} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}{preview ? '确认启动外部终端' : '生成启动预览'}</button></div>
  </AiToolsDialog>;
}
