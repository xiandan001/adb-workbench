import { tr, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';
import { createProjectScope, projectLaunchProvider, projectPreviewFor } from './aiProjectsModel';

export default function AiProjectLaunch({ project, providers, onRequest, theme, isDark, showToast, onClose, canPreview = false, canLaunch = false }) {
  useLocale();
  const id = useId(); const eligible = useMemo(() => providers.filter(projectLaunchProvider), [providers]); const [providerId, setProviderId] = useState(eligible[0]?.id || '');
  const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [scope] = useState(createProjectScope); const pending = useRef(false); const autoPrepared = useRef(false);
  useLayoutEffect(() => { scope.setActive(true); return () => scope.setActive(false); }, [scope]);
  const needsProvider = project.toolId === 'agy';
  const prepare = useCallback(async () => {
    const requestScope = scope.capture();
    if (requestScope === null || pending.current || !canPreview || needsProvider && !eligible.some(item => item.id === providerId)) return;
    pending.current = true; setBusy('preview'); setError('');
    try {
      const result = await onRequest('projects_launch_preview', { projectId: project.id, ...(needsProvider ? { providerId } : {}) });
      if (scope.current(requestScope)) setPreview(projectPreviewFor(project, result));
    } catch (failure) { if (scope.current(requestScope)) setError(failure.message); }
    finally { pending.current = false; if (scope.current(requestScope)) setBusy(''); }
  }, [scope, canPreview, needsProvider, eligible, providerId, onRequest, project]);
  useEffect(() => {
    if (needsProvider || !canPreview || autoPrepared.current) return;
    let cancelled = false;
    // Wait until React's mount/cleanup cycle settles; closing never replays a stale preview.
    queueMicrotask(() => { if (!cancelled && !autoPrepared.current) { autoPrepared.current = true; void prepare(); } });
    return () => { cancelled = true; };
  }, [needsProvider, canPreview, prepare]);
  const launch = async () => {
    const requestScope = scope.capture();
    if (requestScope === null || pending.current || !preview || !canLaunch) return;
    pending.current = true; setBusy('launch'); setError('');
    try {
      const validPreview = projectPreviewFor(project, preview);
      const result = await onRequest('projects_launch', { token: validPreview.token });
      if (!scope.current(requestScope)) return;
      if (result?.launched !== true) throw new Error(tr("未能确认外部终端已启动"));
      showToast?.(tr("交互终端已打开，CLI 的运行结果请查看终端")); onClose();
    } catch (failure) { if (scope.current(requestScope)) { setError(failure.message); setPreview(null); } }
    finally { pending.current = false; if (scope.current(requestScope)) setBusy(''); }
  };
  return <AiToolsDialog title={tr("预览 AI 项目启动")} theme={theme} busy={busy === 'launch'} onClose={onClose}><h4 className="text-sm font-semibold">{project.name} · {project.toolId}</h4><p className={`mt-2 break-all font-mono text-xs ${theme.textMuted}`}>{project.path}</p>
    {!preview && <><p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>{tr("下一步只检查已安装 CLI 并生成启动预览，不安装软件、不执行命令。确认后才打开外部终端，CLI 可能修改项目或产生服务商费用。")}</p>{needsProvider && <div className="mt-3"><label htmlFor={`${id}-provider`} className="text-xs">{tr("本次受管启动的 Gemini 供应商")}</label><SelectMenu id={`${id}-provider`} value={providerId} options={eligible.map(item => ({ value: item.id, label: `${item.name} · ${item.model}` }))} onChange={setProviderId} emptyText={tr("需要已配置密钥、模型并勾选 AGY 的 Gemini 供应商")} disabled={Boolean(busy)} isDark={isDark} className="mt-1" /></div>}</>}
    {preview && <div className="mt-4 space-y-3"><dl className="space-y-2 text-xs"><div><dt className={theme.textMuted}>{tr("将执行的已安装程序")}</dt><dd className="mt-1 break-all font-mono">{preview.executable}</dd></div><div><dt className={theme.textMuted}>{tr("工作目录")}</dt><dd className="mt-1 break-all font-mono">{preview.cwd}</dd></div><div><dt className={theme.textMuted}>{tr("供应商")}</dt><dd className="mt-1">{preview.providerName || tr("使用 CLI 当前原生配置")}</dd></div></dl>{preview.warnings?.map((warning, index) => <p key={index} className="rounded-lg border border-amber-500/25 p-2 text-xs leading-5 text-amber-500">{tr(warning)}</p>)}</div>}
    {busy === 'preview' && <p role="status" className={`mt-3 text-xs ${theme.textMuted}`}>{tr("正在核对程序与项目目录，尚未执行 CLI；可以取消。")}</p>}
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{tr(error)}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy === 'launch'} onClick={onClose} className={`rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>{tr("取消")}</button><button type="button" disabled={Boolean(busy) || (preview ? !canLaunch : !canPreview || needsProvider && !eligible.some(item => item.id === providerId))} onClick={preview ? launch : prepare} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}{preview ? tr("确认启动外部终端") : busy === 'preview' ? tr("正在准备预览…") : tr("生成启动预览")}</button></div>
  </AiToolsDialog>;
}
