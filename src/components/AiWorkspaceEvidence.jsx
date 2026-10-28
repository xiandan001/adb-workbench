import { useEffect, useState } from 'react';
import { AlertTriangle, FileSearch, LockKeyhole, Send } from 'lucide-react';
import { formatNumber, tr, useLocale } from '../shared/i18n';
import { workspacePreviewFresh } from './AiWorkspaceState';
import AiWorkspaceEvidenceLines, { AiWorkspaceEvents } from './AiWorkspaceEvidenceLines';
import { AiWorkspaceContext } from './AiWorkspaceControls';
import AiWorkspaceHandoff from './AiWorkspaceHandoff';

export function AiWorkspaceUsage({ usage, cached, theme }) {
  useLocale();
  if (cached) return <p className={`text-xs ${theme.textMuted}`}>{tr('已复用本会话的相同分析，未再次调用 AI。')}</p>;
  if (!usage) return <p className={`text-xs ${theme.textMuted}`}>{tr('本次用量：服务未返回用量数据。')}</p>;
  return <p className={`text-xs ${theme.textMuted}`}>{tr('本次用量：输入 {0} · 输出 {1} · 合计 {2} tokens', {
    0: Number.isFinite(usage.inputTokens) ? formatNumber(usage.inputTokens) : '—',
    1: Number.isFinite(usage.outputTokens) ? formatNumber(usage.outputTokens) : '—',
    2: Number.isFinite(usage.totalTokens) ? formatNumber(usage.totalTokens) : '—',
  })}</p>;
}

export default function AiWorkspaceEvidence({ preview, busy, entitled, onAnalyze, theme, readOnly = false, highlight, onCitation }) {
  useLocale();
  const [expiredId, setExpiredId] = useState('');
  useEffect(() => {
    const expiresAt = typeof preview.expiresAt === 'string' ? Date.parse(preview.expiresAt) : preview.expiresAt;
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => setExpiredId(preview.id), Math.max(0, expiresAt - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [preview.id, preview.expiresAt]);
  const fresh = expiredId !== preview.id && workspacePreviewFresh(preview);
  return <section aria-label={tr('发送内容预览')} className={`rounded-xl border ${theme.card}`}>
    <div className="flex items-start gap-3 border-b border-slate-400/15 p-4">
      <FileSearch size={19} className="mt-0.5 shrink-0 text-emerald-500" />
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{readOnly ? tr('报告中的冻结证据') : tr('发送内容预览')}</h3>
        <p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{readOnly ? tr('以下内容属于已完成报告，仅供核验，不恢复发送授权。') : tr('仅以下问题和脱敏证据会发送给内置 AI；采集本身不会上传。')}</p>
      </div>
      <span className={`shrink-0 text-xs ${theme.textMuted}`}>{tr('{0} 份证据 · {1} KiB', { 0: formatNumber(preview.entries.length), 1: formatNumber((preview.bytes || 0) / 1024, { maximumFractionDigits: 1 }) })}</span>
    </div>
    <div className="space-y-3 p-4">
      <div className={`rounded-lg border p-3 ${theme.input}`}><p className={`mb-1 text-xs ${theme.textMuted}`}>{tr('本次问题')}</p><p className="whitespace-pre-wrap break-words text-sm">{preview.question}</p></div>
      <AiWorkspaceContext context={preview.context} theme={theme} />
      {preview.handoff && <AiWorkspaceHandoff handoff={preview.handoff} theme={theme} />}
      {preview.diagnostic?.packageName && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('目标应用：{0}', { 0: preview.diagnostic.packageName })}</p>}
      {preview.comparison && <div className="space-y-2 rounded-lg border border-emerald-500/25 p-3 text-xs leading-5">
        <p>{tr('之前：{0} · 证据 {1}', { 0: preview.comparison.beforeName, 1: preview.comparison.beforeIds.join(', ') })}</p>
        <p>{tr('之后：{0} · 证据 {1}', { 0: preview.comparison.afterName, 1: preview.comparison.afterIds.join(', ') })}</p>
        {!preview.comparison.comparable && <p className="text-amber-600 dark:text-amber-400">{tr('当前证据不足以可靠比较，结论应为“无法判断”。')}</p>}
        {preview.comparison.warnings?.map((warning, index) => <p key={index} className={theme.textMuted}>{warning}</p>)}
      </div>}
      {preview.truncated && <p className="flex items-start gap-2 text-xs leading-5 text-amber-600 dark:text-amber-400"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{tr('部分证据已达到大小限制，AI 只能分析预览中保留的内容。')}</p>}
      <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
        {preview.entries.map((entry, index) => <AiWorkspaceEvidenceLines key={entry.id} entry={entry} first={index === 0} highlight={highlight} theme={theme} />)}
      </div>
      <AiWorkspaceEvents entries={preview.entries} onCitation={onCitation} theme={theme} />
      {!readOnly && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-400/15 pt-3">
        <p className={`flex max-w-md items-start gap-1.5 text-xs leading-5 ${fresh ? theme.textMuted : 'text-amber-600'}`}><LockKeyhole size={14} className="mt-0.5 shrink-0" />{fresh ? tr('继续后将显示最终发送预览；确认前不会联网。') : tr('预览已过期，请重新采集后再分析。')}</p>
        <button type="button" onClick={onAnalyze} disabled={Boolean(busy) || !entitled || !fresh} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Send size={15} />{tr('查看并确认发送')}</button>
      </div>}
    </div>
  </section>;
}
