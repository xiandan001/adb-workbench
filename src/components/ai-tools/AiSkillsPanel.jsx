import { tr, getLocale, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useId, useLayoutEffect, useState } from 'react';
import { BookOpen, Download, FolderPlus, History, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import AiToolsDialog from './AiToolsDialog';
import AiSkillsPreview from './AiSkillsPreview';
import { createSkillsRequestGate, executeSkillMutation, skillActionEnabled, skillApplyRequest, skillInstallation } from './aiSkillsModel';

const bytesLabel = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.ceil((bytes || 0) / 1024)} KiB`;

export default function AiSkillsPanel({ active = true, onRequest, can, theme, isDark, showToast, recoveryOnly = false }) {
  useLocale();
  const id = useId(); const [gate] = useState(createSkillsRequestGate);
  const [skills, setSkills] = useState([]); const [tools, setTools] = useState([]); const [toolId, setToolId] = useState('claude');
  const [backups, setBackups] = useState([]); const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [dialog, setDialog] = useState(null);
  const [used, setUsed] = useState(false); const [dialogError, setDialogError] = useState('');
  const allowed = useCallback((command, options = {}) => skillActionEnabled(can, command, { ...options, recoveryOnly }), [can, recoveryOnly]);
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  const selected = tools.find(tool => tool.id === toolId) || tools[0];
  useLayoutEffect(() => { gate.setActive(active, recoveryOnly); }, [active, recoveryOnly, gate]);
  useEffect(() => () => { gate.setActive(false); }, [gate]);

  const fetchData = useCallback(async () => {
    const [library, recovery] = await Promise.all([
      allowed('skills_list') ? onRequest('skills_list', {}) : Promise.resolve({ skills: [], tools: [] }),
      allowed('skills_backups_list') ? onRequest('skills_backups_list', {}) : Promise.resolve({ backups: [] }),
    ]);
    if (!Array.isArray(library?.skills) || !Array.isArray(library?.tools) || !Array.isArray(recovery?.backups)) throw new Error(tr("技能列表格式无效，请刷新后重试"));
    return { skills: library.skills, tools: library.tools, backups: recovery.backups };
  }, [allowed, onRequest]);
  const accept = useCallback(value => { setSkills(value.skills); setTools(value.tools); setBackups(value.backups); if (value.backups.some(row => row.recoveryPending)) setExpanded(true); }, []);
  const acceptMutation = value => { if (value.data) accept(value.data); if (value.refreshError) setError(tr("操作已完成，但列表刷新失败：{0}", { 0: value.refreshError })); };
  const run = useCallback(async (name, operation, success, modal = false) => {
    const ticket = gate.start(); if (!ticket) return;
    setBusy(name); if (modal) setDialogError(''); else setError('');
    try { const result = await operation(); if (gate.current(ticket)) success?.(result); }
    catch (failure) { if (gate.current(ticket)) { if (modal) setDialogError(failure.message); else setError(failure.message); } }
    finally { if (gate.finish(ticket)) setBusy(''); }
  }, [gate]);
  const refresh = useCallback(() => run('refresh', fetchData, value => { accept(value); setDialog(null); }), [run, fetchData, accept]);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  const importSkill = () => run('import', () => executeSkillMutation(onRequest, 'skills_import', {}, undefined, fetchData), value => {
    if (!value.result?.cancelled) { acceptMutation(value); showToast?.(tr("技能已加密导入本地库，尚未安装或执行")); }
  });
  const view = skill => run('read', () => onRequest('skills_read', { id: skill.id }), result => {
    if (typeof result?.content !== 'string' || result.id !== skill.id) throw new Error(tr("技能文本与所选记录不一致"));
    setDialog({ type: 'text', ...result });
  });
  const preview = (skill, operation) => {
    if (!selected) return;
    void run('preview', () => onRequest(operation === 'install' ? 'skills_install_preview' : 'skills_uninstall_preview', { skillId: skill.id, toolId: selected.id }), result => {
      skillApplyRequest(result); setUsed(false); setDialogError(''); setDialog({ type: 'preview', value: result });
    });
  };
  const restore = backup => run('restore-preview', () => onRequest('skills_backup_preview_restore', { backupId: backup.id }), result => {
    skillApplyRequest(result); if (result.operation !== 'restore') throw new Error(tr("恢复预览类型不匹配"));
    setUsed(false); setDialogError(''); setDialog({ type: 'preview', value: result });
  });
  const apply = () => {
    if (used || busy || !dialog?.value) return;
    let request;
    try { request = skillApplyRequest(dialog.value); } catch (failure) { setDialogError(failure.message); return; }
    if (!allowed(request.command, request.options)) { setDialogError(tr("当前权限不允许此操作，未修改文件")); return; }
    void run('apply', () => { setUsed(true); return executeSkillMutation(onRequest, request.command, request.args, request.options, fetchData); }, value => {
      if (value.result?.cancelled) return;
      acceptMutation(value); setDialog(null);
      showToast?.(value.result.operation === 'uninstall' ? tr("技能已卸载，原内容保留在加密备份中") : value.result.operation === 'restore' ? tr("技能已恢复") : tr("技能已安装，未执行任何脚本"));
    }, true);
  };
  const remove = () => {
    if (dialog?.type !== 'remove') return;
    void run('remove', () => executeSkillMutation(onRequest, 'skills_remove', { id: dialog.skill.id }, undefined, fetchData), value => {
      if (value.result?.cancelled) return;
      acceptMutation(value); setDialog(null); showToast?.(value.result.archiveRetained ? tr("库记录已移除；原加密文件发生变化，已保留待检查") : tr("库记录已删除；源目录和历史备份保留"));
    }, true);
  };
  const recoveryAllowed = allowed('skills_backup_preview_restore') && allowed('skills_apply', { restoring: true });

  return <section aria-label={tr("AI 技能管理")} className="space-y-4">
    {!recoveryOnly && <>
      <div className={`rounded-xl border p-4 ${theme.card}`}>
        <div className="flex flex-wrap items-center gap-2"><BookOpen size={19} className="text-emerald-500" /><h3 className="min-w-0 flex-1 text-sm font-semibold">{tr("本地技能库")}</h3>
          <button type="button" aria-label={tr("刷新 AI 技能")} disabled={Boolean(busy)} onClick={refresh} className={button}>{busy === 'refresh' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{tr("刷新")}</button>
          <button type="button" disabled={Boolean(busy) || !allowed('skills_import')} onClick={importSkill} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><FolderPlus size={14} />{tr("导入本地技能")}</button>
        </div>
        <p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("选择直接包含 SKILL.md 的文件夹。库内容与备份均加密；安装前可以查看说明并核对文件变更，不会下载或运行脚本。")}</p>
        <div className="mt-3 max-w-xs"><label htmlFor={`${id}-tool`} className="text-xs">{tr("安装目标工具")}</label><SelectMenu id={`${id}-tool`} value={selected?.id || ''} options={tools.map(tool => ({ value: tool.id, label: tool.label }))} onChange={setToolId} isDark={isDark} disabled={Boolean(busy)} emptyText={tr("暂无可用目标工具")} className="mt-1" /></div>
      </div>
      {error && <p role="alert" className="break-words rounded-lg border border-red-500/20 p-3 text-xs text-red-500">{tr(error)}</p>}
      <div className="grid gap-3 xl:grid-cols-2">{skills.map(skill => {
        const installation = skillInstallation(skill, selected?.id);
        return <article key={skill.id} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}>
          <div className="flex items-start gap-2"><h4 className="min-w-0 flex-1 break-all text-sm font-semibold">{skill.name}</h4>{installation && <span className={`shrink-0 rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}>{installation.currentLibraryVersion ? tr("已有安装记录") : tr("可更新")}</span>}</div>
          <p className={`mt-2 break-words text-xs leading-5 ${theme.textMuted}`}>{skill.description || tr("暂无技能描述，请先查看 SKILL.md。")}</p>
          <p className={`mt-2 text-[11px] ${theme.textMuted}`}>{tr("{0} 个文件 · {1}{2}", { 0: skill.fileCount, 1: bytesLabel(skill.bytes), 2: skill.installations?.length ? tr(" · 记录于 {0}", { 0: skill.installations.map(item => tools.find(tool => tool.id === item.toolId)?.label || item.toolId).join('、') }) : '' })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-label={tr("查看技能 {0}", { 0: skill.name })} disabled={Boolean(busy) || !allowed('skills_read')} onClick={() => view(skill)} className={button}><BookOpen size={13} />{tr("查看说明")}</button>
            <button type="button" aria-label={tr("安装技能 {0}", { 0: skill.name })} disabled={Boolean(busy) || !selected || !allowed('skills_install_preview')} onClick={() => preview(skill, 'install')} className={button}><Download size={13} />{installation ? installation.currentLibraryVersion ? tr("预览重装") : tr("预览更新") : tr("预览安装")}</button>
            <button type="button" aria-label={tr("卸载技能 {0}", { 0: skill.name })} disabled={Boolean(busy) || !installation || !allowed('skills_uninstall_preview')} onClick={() => preview(skill, 'uninstall')} className={button}><Upload size={13} />{tr("预览卸载")}</button>
            <button type="button" aria-label={tr("删除技能 {0}", { 0: skill.name })} disabled={Boolean(busy) || !allowed('skills_remove')} onClick={() => { setDialogError(''); setDialog({ type: 'remove', skill }); }} className={button}><Trash2 size={13} /></button>
          </div>
        </article>;
      })}{!skills.length && <p className={`rounded-xl border border-dashed border-slate-400/25 p-7 text-center text-xs xl:col-span-2 ${theme.textMuted}`}>{busy === 'refresh' ? tr("正在读取技能库…") : tr("尚未导入技能。只会读取你通过目录选择器明确选择的文件夹。")}</p>}</div>
    </>}
    <section aria-label={tr("AI 技能备份")} className={`rounded-xl border p-4 ${theme.card}`}>
      <div className="flex items-center gap-2"><History size={17} className="text-emerald-500" /><button type="button" aria-expanded={recoveryOnly || expanded} onClick={() => setExpanded(value => !value)} className="min-w-0 flex-1 text-left text-sm font-semibold">{tr("技能备份与恢复 · {0}", { 0: backups.length })}</button><button type="button" aria-label={tr("刷新技能备份")} disabled={Boolean(busy)} onClick={refresh} className={button}><RefreshCw size={14} /></button></div>
      {(recoveryOnly || expanded) && <><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("恢复不会受会员到期影响。目录若有外部变化会停止；有中断记录时，请优先恢复标出的备份。")}</p>
        {recoveryOnly && error && <p role="alert" className="mt-2 text-xs text-red-500">{tr(error)}</p>}
        <div className="mt-3 space-y-2">{backups.map(backup => <div key={backup.id} className="flex items-center gap-2 rounded-lg border border-slate-400/20 p-3">
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{backup.name} · {tools.find(tool => tool.id === backup.toolId)?.label || backup.toolId}{backup.recoveryPending ? tr(" · 中断待恢复") : ''}</p><p className={`mt-1 text-[11px] ${theme.textMuted}`}>{new Date(backup.createdAt).toLocaleString(getLocale())}</p><p title={backup.targetPath} className={`mt-1 truncate text-[11px] ${theme.textMuted}`}>{backup.targetPath}</p></div>
          <button type="button" aria-label={tr("恢复技能备份 {0}", { 0: backup.id })} disabled={Boolean(busy) || !recoveryAllowed} onClick={() => restore(backup)} className={button}>{tr("预览恢复")}</button>
        </div>)}{!backups.length && <p className={`p-4 text-center text-xs ${theme.textMuted}`}>{tr("暂无技能备份。")}</p>}</div>
      </>}
    </section>
    {active && dialog?.type === 'text' && !recoveryOnly && <AiToolsDialog title={`${dialog.name} · SKILL.md`} wide theme={theme} busy={false} onClose={() => setDialog(null)}><p className={`mb-3 text-xs ${theme.textMuted}`}>{tr("以下仅显示原始文本，不渲染 HTML，也不执行其中指令。")}</p><pre aria-label={tr("技能说明原始文本")} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-400/20 p-3 text-xs leading-6">{dialog.content}</pre></AiToolsDialog>}
    {active && dialog?.type === 'preview' && <AiSkillsPreview preview={dialog.value} theme={theme} busy={Boolean(busy)} used={used} error={tr(dialogError)} canApply={allowed('skills_apply', { restoring: dialog.value.operation === 'restore' })} onApply={apply} onClose={() => setDialog(null)} />}
    {active && dialog?.type === 'remove' && !recoveryOnly && <AiToolsDialog title={tr("删除本地技能库记录？")} theme={theme} busy={Boolean(busy)} onClose={() => setDialog(null)}><p className="break-all text-sm">{dialog.skill.name}</p><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("只移除本应用的加密库记录；不删除来源文件夹或历史备份。仍安装到工具中的技能需先卸载。")}</p>{dialogError && <p role="alert" className="mt-2 text-xs text-red-500">{tr(dialogError)}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => setDialog(null)} className={button}>{tr("取消")}</button><button type="button" disabled={Boolean(busy) || !allowed('skills_remove')} onClick={remove} className="rounded-lg bg-red-500 px-4 py-2 text-sm text-white disabled:opacity-40">{tr("确认删除库记录")}</button></div></AiToolsDialog>}
  </section>;
}
