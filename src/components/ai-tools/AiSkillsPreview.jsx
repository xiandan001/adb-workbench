import { Loader2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import { skillChangeSummary } from './aiSkillsModel';

export default function AiSkillsPreview({ preview, theme, busy, used, error, canApply, onApply, onClose }) {
  const summary = skillChangeSummary(preview);
  const label = preview.operation === 'restore' ? '恢复' : preview.operation === 'uninstall' ? '卸载' : '安装';
  return <AiToolsDialog title={`预览技能${label}`} wide theme={theme} busy={busy} onClose={onClose}>
    <p className="text-sm font-semibold">{preview.name} · {preview.toolId}</p>
    <p className={`mt-2 break-all rounded-lg border border-slate-400/20 p-3 font-mono text-xs ${theme.textMuted}`}>{preview.targetPath}</p>
    <p className={`my-3 text-xs ${theme.textMuted}`}>新增 {summary.add} · 替换 {summary.replace} · 移除 {summary.remove}。仅操作上方技能子目录，不执行任何脚本。</p>
    <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-400/20">
      {summary.shown.map(row => <div key={row.path} className="flex gap-3 border-b border-slate-400/10 px-3 py-2 text-xs last:border-b-0">
        <span className={`w-10 shrink-0 ${row.action === 'remove' ? 'text-red-500' : row.action === 'add' ? 'text-emerald-500' : 'text-amber-500'}`}>{row.action === 'remove' ? '移除' : row.action === 'add' ? '新增' : '替换'}</span>
        <span className="min-w-0 break-all font-mono">{row.path}</span>
      </div>)}
      {!summary.total && <p className={`p-3 text-xs ${theme.textMuted}`}>文件内容没有差异；确认后仅更新本应用的安装记录。</p>}
    </div>
    {summary.hidden > 0 && <p className={`mt-2 text-xs ${theme.textMuted}`}>还有 {summary.hidden} 项变更；以上为前 100 项，后端会对完整目录进行校验和备份。</p>}
    {(preview.warnings || []).map((warning, index) => <p key={index} className="mt-2 text-xs leading-5 text-amber-500">{warning}</p>)}
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
    {used && !busy && <p className={`mt-2 text-xs ${theme.textMuted}`}>本次确认已经提交；如需重试，请关闭后重新预览。</p>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>取消</button>
      <button type="button" aria-label={`确认${label}技能`} disabled={busy || used || !canApply} onClick={onApply} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>
        {busy && <Loader2 size={14} className="animate-spin" />}确认{label}
      </button>
    </div>
  </AiToolsDialog>;
}
