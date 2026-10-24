import { tr, useLocale } from '../../shared/i18n.js';
import { Loader2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import { skillChangeSummary } from './aiSkillsModel';

export default function AiSkillsPreview({ preview, theme, busy, used, error, canApply, onApply, onClose }) {
  useLocale();
  const summary = skillChangeSummary(preview);
  const label = preview.operation === 'restore' ? tr("恢复") : preview.operation === 'uninstall' ? tr("卸载") : tr("安装");
  return <AiToolsDialog title={tr("预览技能{0}", { 0: label })} wide theme={theme} busy={busy} onClose={onClose}>
    <p className="text-sm font-semibold">{preview.name} · {preview.toolId}</p>
    <p className={`mt-2 break-all rounded-lg border border-slate-400/20 p-3 font-mono text-xs ${theme.textMuted}`}>{preview.targetPath}</p>
    <p className={`my-3 text-xs ${theme.textMuted}`}>{tr("新增 {0} · 替换 {1} · 移除 {2}。仅操作上方技能子目录，不执行任何脚本。", { 0: summary.add, 1: summary.replace, 2: summary.remove })}</p>
    <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-400/20">
      {summary.shown.map(row => <div key={row.path} className="flex gap-3 border-b border-slate-400/10 px-3 py-2 text-xs last:border-b-0">
        <span className={`w-10 shrink-0 ${row.action === 'remove' ? 'text-red-500' : row.action === 'add' ? 'text-emerald-500' : 'text-amber-500'}`}>{row.action === 'remove' ? tr("移除") : row.action === 'add' ? tr("新增") : tr("替换")}</span>
        <span className="min-w-0 break-all font-mono">{row.path}</span>
      </div>)}
      {!summary.total && <p className={`p-3 text-xs ${theme.textMuted}`}>{tr("文件内容没有差异；确认后仅更新本应用的安装记录。")}</p>}
    </div>
    {summary.hidden > 0 && <p className={`mt-2 text-xs ${theme.textMuted}`}>{tr("还有 {0} 项变更；以上为前 100 项，后端会对完整目录进行校验和备份。", { 0: summary.hidden })}</p>}
    {(preview.warnings || []).map((warning, index) => <p key={index} className="mt-2 text-xs leading-5 text-amber-500">{tr(warning)}</p>)}
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{tr(error)}</p>}
    {used && !busy && <p className={`mt-2 text-xs ${theme.textMuted}`}>{tr("本次确认已经提交；如需重试，请关闭后重新预览。")}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("取消")}</button>
      <button type="button" aria-label={tr("确认{0}技能", { 0: label })} disabled={busy || used || !canApply} onClick={onApply} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>
        {busy && <Loader2 size={14} className="animate-spin" />}{tr("确认{0}", { 0: label })}</button>
    </div>
  </AiToolsDialog>;
}
