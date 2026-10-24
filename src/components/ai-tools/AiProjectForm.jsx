import { tr, useLocale } from '../../shared/i18n.js';
import { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';
import { projectDraft, projectInput } from './aiProjectsModel';

export default function AiProjectForm({ project, defaultToolId, launchAfterSave = false, tools, theme, isDark, onRequest, onSave, onClose }) {
  useLocale();
  const id = useId(); const [draft, setDraft] = useState(() => projectDraft(project, defaultToolId || tools[0]?.id));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const input = `mt-1 w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`;
  const choose = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      const result = await onRequest('projects_pick', {});
      if (!alive.current) return;
      if (!result?.cancelled) {
        if (!result?.token || !result.path) throw new Error(tr("文件夹选择结果无效，请重新选择"));
        setDraft(previous => ({ ...previous, path: result.path, directoryToken: result.token, name: previous.name || result.name }));
      }
    } catch (failure) { if (alive.current) setError(failure.message); } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const submit = async event => {
    event.preventDefault(); if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await onSave(projectInput(draft, tools)); if (alive.current) onClose(); } catch (failure) { if (alive.current) setError(failure.message); } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <AiToolsDialog title={project ? tr("编辑 AI 项目") : launchAfterSave ? tr("创建项目并启动") : tr("添加 AI 项目")} theme={theme} busy={busy} onClose={onClose}><form onSubmit={submit} className="space-y-3">
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr("{0}路径必须通过本机选择器选取。", { 0: launchAfterSave ? tr("选择项目目录并保存后进入启动预览；最终确认前不会执行 CLI，也不改写项目内容。") : tr("保存项目快捷入口，不启动 CLI，也不改写项目内容。") })}</p>
    {draft.needsRelocation && <div className="rounded-lg border border-amber-500/30 p-3 text-xs leading-5"><p className={isDark ? 'text-amber-300' : 'text-amber-700'}>{tr("迁移项目尚未关联本机目录。请重新选择；在此之前不能打开或启动。")}</p><p className={`mt-1 break-all font-mono ${theme.textMuted}`}>{tr("来源路径（仅供参考）：{0}", { 0: draft.oldPath || tr("未记录") })}</p></div>}
    <label className="block text-xs">{tr("项目名称")}<input aria-label={tr("AI 项目名称")} autoFocus required maxLength={100} value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} disabled={busy} className={input} /></label>
    <div><span className="text-xs">{tr("项目文件夹")}</span><p aria-label={tr("AI 项目文件夹")} className={`mt-1 break-all rounded-lg border border-slate-400/20 p-3 font-mono text-xs ${theme.textMuted}`}>{draft.path || tr("尚未选择")}</p><button type="button" disabled={busy} onClick={choose} className={`mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`}><FolderOpen size={14} />{tr("选择项目文件夹")}</button></div>
    <div><label htmlFor={`${id}-tool`} className="text-xs">{tr("启动工具")}</label><SelectMenu id={`${id}-tool`} value={draft.toolId} options={tools.map(tool => ({ value: tool.id, label: `${tool.label || tool.id} · ${tool.command}` }))} onChange={toolId => setDraft(previous => ({ ...previous, toolId }))} isDark={isDark} disabled={busy} className="mt-1" /></div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.pinned} onChange={event => setDraft(previous => ({ ...previous, pinned: event.target.checked }))} disabled={busy} />{tr("常用项目置顶")}</label>
    {error && <p role="alert" className="text-xs text-red-500">{tr(error)}</p>}<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-xs ${theme.button.secondary}`}>{tr("取消")}</button><button type="submit" disabled={busy} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{launchAfterSave ? tr("保存并继续") : tr("保存项目")}</button></div>
  </form></AiToolsDialog>;
}
