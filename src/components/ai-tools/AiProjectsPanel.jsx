import { tr, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, Loader2, Pencil, Pin, Plus, RefreshCw, Trash2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import AiProjectForm from './AiProjectForm';
import AiProjectLaunch from './AiProjectLaunch';
import { createProjectScope, projectDraft, projectInput, projectQuickStartAvailable } from './aiProjectsModel';

export default function AiProjectsPanel({ active = true, providers, tools, onRequest, can, theme, isDark, showToast }) {
  useLocale();
  const [data, setData] = useState(null); const [environment, setEnvironment] = useState(null); const [error, setError] = useState('');
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const [search, setSearch] = useState('');
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [launch, setLaunch] = useState(null);
  const pending = useRef(false); const alive = useRef(true); const ticket = useRef(0);
  const [scope] = useState(createProjectScope);
  useLayoutEffect(() => { scope.setActive(active); return () => scope.setActive(false); }, [active, scope]);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const load = useCallback(async () => {
    const requestScope = scope.capture(); if (requestScope === null) return;
    const current = ++ticket.current; setLoading(true);
    try { const result = await onRequest('projects_snapshot', {}); if (!Array.isArray(result?.projects) || !Array.isArray(result?.tools)) throw new Error(tr("项目库状态格式无效")); if (alive.current && scope.current(requestScope) && current === ticket.current) setData(result); }
    finally { if (alive.current && current === ticket.current) setLoading(false); }
  }, [onRequest, scope]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const requestScope = scope.capture(); if (active) void load().catch(failure => { if (scope.current(requestScope)) setError(failure.message); }); }, [active, load, scope]);
  const refresh = () => { const requestScope = scope.capture(); setError(''); void load().catch(failure => { if (scope.current(requestScope)) setError(failure.message); }); };
  const refreshAfterWrite = async requestScope => { try { await load(); } catch (failure) { if (alive.current && scope.current(requestScope)) setError(tr("操作已完成，但项目列表刷新失败：{0}", { 0: failure.message })); } };
  const openForm = (project = null, defaultToolId, launchAfterSave = false) => {
    const requestScope = scope.capture(); if (requestScope === null || busy || !can('projects_save') || !project && !can('projects_pick')) return;
    setError(''); setForm({ project, defaultToolId, launchAfterSave, scope: requestScope });
  };
  const save = async project => {
    const requestScope = scope.capture(); const context = form;
    if (pending.current || !context || !scope.current(context.scope) || requestScope === null) throw new Error(tr("项目页面状态已变化，请重新打开表单"));
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await onRequest('projects_save', { project });
      if (alive.current && scope.current(requestScope)) {
        await refreshAfterWrite(requestScope);
        if (scope.current(requestScope)) {
          setForm(null);
          if (context.launchAfterSave && can('projects_launch_preview') && can('projects_launch')) setLaunch({ project: result, scope: requestScope });
          showToast?.(context.launchAfterSave ? tr("项目已保存，请核对启动预览；尚未执行 CLI") : tr("项目入口已保存，尚未启动工具"));
        }
      }
      return result;
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const act = async (command, args, after) => {
    const requestScope = scope.capture(); if (requestScope === null || pending.current || !can(command)) return; pending.current = true; setBusy(true); setError('');
    try { const result = await onRequest(command, args); if (alive.current && scope.current(requestScope)) await after?.(result, requestScope); }
    catch (failure) { if (alive.current && scope.current(requestScope)) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const projectTools = (data?.tools || []).map(item => ({ ...item, label: tools.find(tool => tool.id === item.id)?.label || item.id }));
  const visible = (data?.projects || []).filter(item => `${item.name} ${item.path} ${item.oldPath || ''} ${item.toolId}`.toLowerCase().includes(search.toLowerCase()));
  return <section aria-label={tr("AI 项目入口")} className="space-y-3"><div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{tr("项目与 CLI 启动")}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr("检测工具后可直接创建项目并进入启动确认；已有项目点击“启动”。不会自动安装软件或切换供应商。")}</p></div><button type="button" aria-label={tr("刷新 AI 项目")} disabled={busy || loading || !active} onClick={refresh} className={button}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button><button type="button" disabled={busy || !active || !can('projects_environment')} onClick={() => act('projects_environment', {}, result => setEnvironment(result.tools))} className={button}>{tr("检测已安装工具")}</button><button type="button" disabled={!data || busy || !active || !can('projects_save') || !can('projects_pick')} onClick={() => openForm()} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Plus size={14} />{tr("添加项目")}</button></div><input aria-label={tr("搜索 AI 项目")} placeholder={tr("搜索项目名称或路径")} value={search} onChange={event => setSearch(event.target.value)} className={`mt-3 w-full rounded-lg border px-3 py-2 text-xs ${theme.input}`} />{error && <p role="alert" className="mt-3 text-xs text-red-500">{tr(error)}</p>}
    {environment && <details className="mt-3 rounded-lg border border-slate-400/20 p-3" open><summary className="cursor-pointer text-xs">{tr("本机 PATH 检测结果（不执行 CLI）")}</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{environment.map(item => <div key={item.id} role="group" aria-label={tr("检测结果 {0}", { 0: item.id })} className="min-w-0 rounded-lg border border-slate-400/15 p-2 text-xs"><span className="font-medium">{projectTools.find(tool => tool.id === item.id)?.label || item.id}</span><p title={item.path || ''} className={`mt-1 truncate font-mono text-[11px] ${theme.textMuted}`}>{item.path || tr("PATH 中未发现，请自行安装或检查 PATH")}</p>{item.path && <button type="button" aria-label={tr("创建项目并启动 {0}", { 0: projectTools.find(tool => tool.id === item.id)?.label || item.id })} disabled={busy || !active || !projectQuickStartAvailable(item, projectTools, can)} onClick={() => openForm(null, item.id, true)} className={`mt-2 ${button}`}><ExternalLink size={13} />{tr("创建项目并启动")}</button>}</div>)}</div></details>}</div>
    <div className="grid gap-3 xl:grid-cols-2">{visible.map(project => {
      const needsRelocation = project.needsRelocation === true; const shownPath = needsRelocation ? project.oldPath : project.path;
      return <article key={project.id} aria-label={tr("AI 项目 {0}", { 0: project.name })} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}>
        <div className="flex items-center gap-2"><h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{project.name}</h4>{project.pinned && <Pin size={14} className="text-emerald-500" />}<span className={`text-xs ${theme.textMuted}`}>{projectTools.find(tool => tool.id === project.toolId)?.label || project.toolId}</span></div>
        <p title={shownPath} className={`mt-2 truncate font-mono text-xs ${theme.textMuted}`}>{needsRelocation ? tr("来源路径（仅供参考）：") : ''}{shownPath || tr("未关联目录")}</p>
        {needsRelocation && <p role="status" className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>{tr("从备份导入，需重新选择本机目录后才能打开或启动。")}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {needsRelocation && <button type="button" disabled={busy || !active || !can('projects_save') || !can('projects_pick')} onClick={() => openForm(project)} className={button}><FolderOpen size={13} />{tr("重新选择目录")}</button>}
          <button type="button" disabled={needsRelocation || busy || !active || !can('projects_launch_preview') || !can('projects_launch')} title={needsRelocation ? tr("请先重新选择本机项目目录") : tr("先预览真实程序与目录，最终确认后才启动")} onClick={() => setLaunch({ project, scope: scope.capture() })} className={button}><ExternalLink size={13} />{tr("启动")}</button>
          <button type="button" title={needsRelocation ? tr("请先重新选择本机项目目录") : tr("打开项目文件夹")} aria-label={tr("打开项目文件夹 {0}", { 0: project.name })} disabled={needsRelocation || busy || !can('projects_open')} onClick={() => act('projects_open', { projectId: project.id })} className={button}><FolderOpen size={13} /></button>
          <button type="button" aria-label={tr("复制项目路径 {0}", { 0: project.name })} disabled={!shownPath} onClick={() => { void navigator.clipboard.writeText(shownPath).then(() => showToast?.(needsRelocation ? tr("已复制来源路径，仅供参考") : tr("已复制项目路径")), failure => setError(failure.message)); }} className={button}><Copy size={13} /></button>
          <button type="button" aria-label={tr("{0}项目 {1}", { 0: project.pinned ? tr("取消置顶") : tr("置顶"), 1: project.name })} disabled={busy || !active || !can('projects_save')} onClick={() => act('projects_save', { project: projectInput({ ...projectDraft(project), pinned: !project.pinned }, projectTools) }, (_result, requestScope) => refreshAfterWrite(requestScope))} className={button}><Pin size={13} /></button>
          <button type="button" aria-label={tr("编辑项目 {0}", { 0: project.name })} disabled={busy || !active || !can('projects_save')} onClick={() => openForm(project)} className={button}><Pencil size={13} /></button><button type="button" aria-label={tr("移除项目 {0}", { 0: project.name })} disabled={busy || !active || !can('projects_remove')} onClick={() => setRemove({ ...project, scope: scope.capture() })} className={button}><Trash2 size={13} /></button>
        </div>
      </article>;
    })}</div>
    {!loading && !visible.length && <div className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}><p>{data?.projects.length ? tr("没有匹配的项目") : tr("先添加项目，或检测已安装工具后点击“创建项目并启动”。")}</p>{data && !data.projects.length && <button type="button" disabled={busy || !active || !can('projects_save') || !can('projects_pick')} onClick={() => openForm()} className={`mt-3 ${button}`}><Plus size={13} />{tr("添加第一个项目")}</button>}</div>}
    {active && form && scope.current(form.scope) && <AiProjectForm project={form.project} defaultToolId={form.defaultToolId} launchAfterSave={form.launchAfterSave} tools={projectTools} onRequest={onRequest} onSave={save} onClose={() => setForm(previous => previous === form ? null : previous)} theme={theme} isDark={isDark} />}
    {active && launch && scope.current(launch.scope) && <AiProjectLaunch key={launch.project.id} project={launch.project} providers={providers} onRequest={onRequest} theme={theme} isDark={isDark} showToast={showToast} canPreview={can('projects_launch_preview')} canLaunch={can('projects_launch')} onClose={() => setLaunch(previous => previous === launch ? null : previous)} />}
    {active && remove && scope.current(remove.scope) && <AiToolsDialog title={tr("移除 AI 项目入口？")} theme={theme} busy={busy} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs ${theme.textMuted}`}>{tr("仅移除保存的快捷入口，不删除项目文件夹或文件。")}</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{tr(error)}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setRemove(null)} className={button}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => act('projects_remove', { projectId: remove.id }, async (_result, requestScope) => { setRemove(null); await refreshAfterWrite(requestScope); if (scope.current(requestScope)) showToast?.(tr("项目入口已移除，文件未删除")); })} className="rounded-lg bg-red-500 px-3 py-2 text-xs text-white disabled:opacity-40">{tr("确认移除项目")}</button></div></AiToolsDialog>}
  </section>;
}
