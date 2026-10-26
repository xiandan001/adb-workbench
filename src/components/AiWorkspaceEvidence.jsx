import { useEffect, useState } from 'react';
import { AlertTriangle, FileSearch, LockKeyhole, Send } from 'lucide-react';
import { formatDateTime, formatNumber, tr, useLocale } from '../shared/i18n';
import { workspacePreviewFresh } from './AiWorkspaceState';

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

export default function AiWorkspaceEvidence({ preview, busy, entitled, onAnalyze, theme }) {
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
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{tr('发送内容预览')}</h3>
        <p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('仅以下问题和脱敏证据会发送给内置 AI；采集本身不会上传。')}</p>
      </div>
      <span className={`shrink-0 text-xs ${theme.textMuted}`}>{tr('{0} 份证据 · {1} KiB', { 0: formatNumber(preview.entries.length), 1: formatNumber((preview.bytes || 0) / 1024, { maximumFractionDigits: 1 }) })}</span>
    </div>
    <div className="space-y-3 p-4">
      <div className={`rounded-lg border p-3 ${theme.input}`}><p className={`mb-1 text-xs ${theme.textMuted}`}>{tr('本次问题')}</p><p className="whitespace-pre-wrap break-words text-sm">{preview.question}</p></div>
      {preview.truncated && <p className="flex items-start gap-2 text-xs leading-5 text-amber-600 dark:text-amber-400"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{tr('部分证据已达到大小限制，AI 只能分析预览中保留的内容。')}</p>}
      <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
        {preview.entries.map((entry, index) => <details key={entry.id} id={`ai-evidence-${preview.id}-${entry.id}`} open={index === 0 || undefined} tabIndex={-1} className={`rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500/50 ${theme.input}`}>
          <summary className="cursor-pointer px-3 py-2.5 text-xs"><span className="ml-1 font-semibold text-emerald-500">[{entry.id}]</span> <span className="font-medium">{entry.label || entry.source}</span>{entry.target && <span className={`ml-2 break-all ${theme.textMuted}`}>{entry.target}</span>}</summary>
          <div className="space-y-2 border-t border-slate-400/15 px-3 pb-3 pt-2">
            <div className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] ${theme.textMuted}`}>
              <span>{tr('采集于 {0}', { 0: formatDateTime(entry.capturedAt) })}</span><span>{entry.timeBasis}</span>
              {entry.redactions > 0 && <span>{tr('已脱敏 {0} 行', { 0: formatNumber(entry.redactions) })}</span>}
              {entry.truncated && <span className="text-amber-500">{tr('内容已截断')}</span>}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 [tab-size:2]">{entry.text}</pre>
          </div>
        </details>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-400/15 pt-3">
        <p className={`flex max-w-md items-start gap-1.5 text-xs leading-5 ${fresh ? theme.textMuted : 'text-amber-600'}`}><LockKeyhole size={14} className="mt-0.5 shrink-0" />{fresh ? tr('请核对敏感信息；点击分析即同意发送上述内容。') : tr('预览已过期，请重新采集后再分析。')}</p>
        <button type="button" onClick={onAnalyze} disabled={Boolean(busy) || !entitled || !fresh} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`}><Send size={15} />{tr('发送并分析')}</button>
      </div>
    </div>
  </section>;
}
