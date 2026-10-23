import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, Loader2, Pencil, Pin, Plus, RefreshCw, Trash2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import AiProjectForm from './AiProjectForm';
import AiProjectLaunch from './AiProjectLaunch';
import { projectDraft, projectInput } from './aiProjectsModel';

export default function AiProjectsPanel({ active = true, providers, tools, onRequest, can, theme, isDark, showToast }) {
  const [data, setData] = useState(null); const [environment, setEnvironment] = useState(null); const [error, setError] = useState('');
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const [search, setSearch] = useState('');
  const [form, setForm] = useState(null); const [remove, setRemove] = useState(null); const [launch, setLaunch] = useState(null);
  const pending = useRef(false); const alive = useRef(true); const ticket = useRef(0);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const load = useCallback(async () => {
    const current = ++ticket.current; setLoading(true);
    try { const result = await onRequest('projects_snapshot', {}); if (!Array.isArray(result?.projects) || !Array.isArray(result?.tools)) throw new Error('项目库状态格式无效'); if (alive.current && current === ticket.current) setData(result); }
    finally { if (alive.current && current === ticket.current) setLoading(false); }
  }, [onRequest]);
  useEffect(() => { alive.current = true; void load().catch(failure => { if (alive.current) setError(failure.message); }); return () => { alive.current = false; }; }, [load]);
  const refreshAfterWrite = async () => { try { await load(); } catch (failure) { if (alive.current) setError(`操作已完成，但项目列表刷新失败：${failure.message}`); } };
  const save = async project => { const result = await onRequest('projects_save', { project }); if (alive.current) { await refreshAfterWrite(); showToast?.('项目入口已保存，尚未启动工具'); } return result; };
  const act = async (command, args, after) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { const result = await onRequest(command, args); if (alive.current) await after?.(result); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const projectTools = (data?.tools || []).map(item => ({ ...item, label: tools.find(tool => tool.id === item.id)?.label || item.id }));
  const visible = (data?.projects || []).filter(item => `${item.name} ${item.path} ${item.oldPath || ''} ${item.toolId}`.toLowerCase().includes(search.toLowerCase()));
  return <section aria-label="AI 项目入口" className="space-y-3"><div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">项目与 CLI 启动</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>保存常用项目目录。启动前展示真实程序、路径与影响，不自动安装软件或切换供应商。</p></div><button type="button" aria-label="刷新 AI 项目" disabled={busy || loading} onClick={() => { setError(''); void load().catch(failure => setError(failure.message)); }} className={button}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button><button type="button" disabled={busy || !can('projects_environment')} onClick={() => act('projects_environment', {}, result => setEnvironment(result.tools))} className={button}>检测已安装工具</button><button type="button" disabled={!data || busy || !can('projects_save') || !can('projects_pick')} onClick={() => setForm({ project: null })} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Plus size={14} />添加项目</button></div><input aria-label="搜索 AI 项目" placeholder="搜索项目名称或路径" value={search} onChange={event => setSearch(event.target.value)} className={`mt-3 w-full rounded-lg border px-3 py-2 text-xs ${theme.input}`} />{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
    {environment && <details className="mt-3 rounded-lg border border-slate-400/20 p-3" open><summary className="cursor-pointer text-xs">本机 PATH 检测结果（不执行 CLI）</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{environment.map(item => <div key={item.id} className="min-w-0 text-xs"><span className="font-medium">{projectTools.find(tool => tool.id === item.id)?.label || item.id}</span><p title={item.path || ''} className={`mt-1 truncate font-mono text-[11px] ${theme.textMuted}`}>{item.path || 'PATH 中未发现，请自行安装或检查 PATH'}</p></div>)}</div></details>}</div>
    <div className="grid gap-3 xl:grid-cols-2">{visible.map(project => {
      const needsRelocation = project.needsRelocation === true; const shownPath = needsRelocation ? project.oldPath : project.path;
      return <article key={project.id} aria-label={`AI 项目 ${project.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}>
        <div className="flex items-center gap-2"><h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{project.name}</h4>{project.pinned && <Pin size={14} className="text-emerald-500" />}<span className={`text-xs ${theme.textMuted}`}>{projectTools.find(tool => tool.id === project.toolId)?.label || project.toolId}</span></div>
        <p title={shownPath} className={`mt-2 truncate font-mono text-xs ${theme.textMuted}`}>{needsRelocation ? '来源路径（仅供参考）：' : ''}{shownPath || '未关联目录'}</p>
        {needsRelocation && <p role="status" className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>从备份导入，需重新选择本机目录后才能打开或启动。</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {needsRelocation && <button type="button" disabled={busy || !can('projects_save') || !can('projects_pick')} onClick={() => setForm({ project })} className={button}><FolderOpen size={13} />重新选择目录</button>}
          <button type="button" disabled={needsRelocation || busy || !can('projects_launch_preview') || !can('projects_launch')} title={needsRelocation ? '请先重新选择本机项目目录' : undefined} onClick={() => setLaunch(project)} className={button}><ExternalLink size={13} />启动预览</button>
          <button type="button" title={needsRelocation ? '请先重新选择本机项目目录' : '打开项目文件夹'} aria-label={`打开项目文件夹 ${project.name}`} disabled={needsRelocation || busy || !can('projects_open')} onClick={() => act('projects_open', { projectId: project.id })} className={button}><FolderOpen size={13} /></button>
          <button type="button" aria-label={`复制项目路径 ${project.name}`} disabled={!shownPath} onClick={() => { void navigator.clipboard.writeText(shownPath).then(() => showToast?.(needsRelocation ? '已复制来源路径，仅供参考' : '已复制项目路径'), failure => setError(failure.message)); }} className={button}><Copy size={13} /></button>
          <button type="button" aria-label={`${project.pinned ? '取消置顶' : '置顶'}项目 ${project.name}`} disabled={busy || !can('projects_save')} onClick={() => act('projects_save', { project: projectInput({ ...projectDraft(project), pinned: !project.pinned }, projectTools) }, refreshAfterWrite)} className={button}><Pin size={13} /></button>
          <button type="button" aria-label={`编辑项目 ${project.name}`} disabled={busy || !can('projects_save')} onClick={() => setForm({ project })} className={button}><Pencil size={13} /></button><button type="button" aria-label={`移除项目 ${project.name}`} disabled={busy || !can('projects_remove')} onClick={() => setRemove(project)} className={button}><Trash2 size={13} /></button>
        </div>
      </article>;
    })}</div>
    {!loading && !visible.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>{data?.projects.length ? '没有匹配的项目' : '先选择一个具体项目文件夹，建立常用启动入口。'}</p>}
    {active && form && <AiProjectForm project={form.project} tools={projectTools} onRequest={onRequest} onSave={save} onClose={() => setForm(null)} theme={theme} isDark={isDark} />}
    {active && launch && <AiProjectLaunch project={launch} providers={providers} onRequest={onRequest} theme={theme} isDark={isDark} showToast={showToast} onClose={() => setLaunch(null)} />}
    {active && remove && <AiToolsDialog title="移除 AI 项目入口？" theme={theme} busy={busy} onClose={() => setRemove(null)}><p className="text-sm">{remove.name}</p><p className={`mt-2 text-xs ${theme.textMuted}`}>仅移除保存的快捷入口，不删除项目文件夹或文件。</p>{error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setRemove(null)} className={button}>取消</button><button type="button" disabled={busy} onClick={() => act('projects_remove', { projectId: remove.id }, async () => { setRemove(null); await refreshAfterWrite(); showToast?.('项目入口已移除，文件未删除'); })} className="rounded-lg bg-red-500 px-3 py-2 text-xs text-white disabled:opacity-40">确认移除项目</button></div></AiToolsDialog>}
  </section>;
}
