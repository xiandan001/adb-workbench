import { useId, useRef, useState } from 'react';
import { FileText, FolderOpen, Loader2, Lock, Sparkles } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

function actionClass(isDark) {
  return `inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`;
}

function LegacyEvidence({ sources, muted }) {
  if (!sources) return null;
  const labels = [
    sources.report && tr('报告正文'),
    sources.summary && tr('报告摘要'),
    sources.logs && tr('命中日志片段'),
    sources.performance && tr('性能快照'),
  ].filter(Boolean);
  if (!labels.length) return null;
  return <div className="flex flex-wrap items-center gap-1.5 text-xs">
    <span className={muted}>{tr('将使用的本机证据')}</span>
    {labels.map(label => <span key={label} className="rounded-md bg-emerald-500/10 px-2 py-1">{label}</span>)}
  </div>;
}

export function ReportSummaryAction({
  result, muted, isDark, canGenerateSummary, isVipLoading, onOpenSummaryMembership, onAiSummary, onOpenPath,
  disabled = false, onPendingChange,
}) {
  useLocale();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const running = useRef(false);
  const legacy = result.legacy === true;
  const generated = result.aiSummary?.ok === true;
  const savedSeparately = Boolean(result.aiSummaryPath);
  const button = actionClass(isDark);

  const generate = async () => {
    if (running.current || disabled || isVipLoading || !result.reportRef) return;
    if (!canGenerateSummary) {
      onOpenSummaryMembership?.(result);
      return;
    }
    running.current = true;
    setPending(true);
    onPendingChange?.(true);
    setFailure('');
    try {
      const response = await window.electronAPI?.troubleshootingGenerateSummary?.(result.reportRef);
      if (response?.ok && response.taskId === result.taskId) {
        onAiSummary(result.taskId, response.aiSummary, response.summaryPath);
      } else setFailure(response?.cancelled ? tr('AI 发送已取消。') : response?.error || tr('AI 总结异常'));
    } catch { setFailure(tr('AI 总结异常')); }
    finally {
      running.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  };
  const cancel = async () => {
    try { await window.electronAPI?.troubleshootingCancelSummary?.(result.taskId); }
    catch { setFailure(tr('AI 总结异常')); }
  };
  const buttonLabel = pending ? tr('正在生成 AI 总结')
    : failure ? tr('重试 AI 总结') : generated ? tr('重新生成 AI 总结') : tr('生成 AI 总结');

  return <div className="mt-4 space-y-3 border-t border-current/10 pt-3" aria-busy={pending}>
    {legacy && <LegacyEvidence sources={result.evidenceSources} muted={muted} />}
    {legacy && result.evidenceLimited && <p className="text-xs text-amber-500">
      {tr('部分证据已达到大小限制，AI 只能分析预览中保留的内容。')}
    </p>}
    {generated ? <p role="status" className={`text-sm ${muted}`}>
      {savedSeparately ? tr('AI 总结已单独保存，原报告保持不变。') : tr('AI 总结已写入报告')}
    </p> : !legacy && <p className={`text-xs ${muted}`}>{tr('报告已保存。可使用本次证据生成 AI 总结，无需重新采集。')}</p>}
    {(!generated || legacy) && <div className="flex flex-wrap gap-2">
      <button type="button" onClick={generate} disabled={pending || isVipLoading || disabled} className={button}>
        {pending ? <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin" />
          : canGenerateSummary ? <Sparkles size={15} aria-hidden="true" className="shrink-0" />
            : <Lock size={15} aria-hidden="true" className="shrink-0" />}
        {buttonLabel}
      </button>
      {pending && <button type="button" onClick={cancel} className={button}>{tr('取消')}</button>}
      {savedSeparately && <button type="button" onClick={() => onOpenPath(result.aiSummaryPath)} className={button}>
        <FileText size={15} className="shrink-0" aria-hidden="true" />{tr('打开 AI 总结')}
      </button>}
    </div>}
    {failure && <p role="status" className="break-words text-xs text-amber-500">{failure}</p>}
  </div>;
}

export function LegacyReportSummary({
  isDark, text, muted, panel, soft, onOpenPath, canGenerateSummary, isVipLoading, onOpenSummaryMembership,
}) {
  useLocale();
  const titleId = useId();
  const [report, setReport] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState('');
  const selectingRef = useRef(false);
  const api = window.electronAPI;
  const button = actionClass(isDark);

  const chooseReport = async () => {
    if (selectingRef.current || summarizing || !api?.troubleshootingChooseReport) return;
    selectingRef.current = true;
    setSelecting(true);
    setError('');
    try {
      const result = await api.troubleshootingChooseReport();
      if (result?.cancelled) return;
      if (result?.ok && result.report?.reportRef) setReport(result.report);
      else setError(result?.error || tr('未能读取所选报告，请重新选择。'));
    } catch { setError(tr('未能读取所选报告，请重新选择。')); }
    finally { selectingRef.current = false; setSelecting(false); }
  };
  const updateSummary = (taskId, aiSummary, aiSummaryPath) => {
    setReport(current => current?.taskId === taskId ? { ...current, aiSummary, aiSummaryPath } : current);
  };

  return <section aria-labelledby={titleId} className={`min-w-0 rounded-xl border p-4 ${panel}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
          <FolderOpen size={20} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 id={titleId} className={`text-base font-semibold ${text}`}>{tr('使用已有排查报告')}</h3>
          <p className={`mt-1 break-words text-xs ${muted}`}>{tr('使用本机报告和已保存的证据，无需连接设备。发送前可核对具体内容。')}</p>
        </div>
      </div>
      <button type="button" onClick={chooseReport} disabled={selecting || summarizing || !api?.troubleshootingChooseReport} className={button}>
        {selecting ? <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin" />
          : <FileText size={16} aria-hidden="true" className="shrink-0" />}
        {tr('选择 Markdown 报告')}
      </button>
    </div>
    {error && <p role="alert" className="mt-3 break-words text-sm text-amber-500">{error}</p>}
    {report && <div className={`mt-4 min-w-0 rounded-lg border px-4 py-3 ${soft}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`min-w-0 break-all text-sm font-medium ${text}`}>{report.filename || report.title}</p>
        {report.reportPath && <button type="button" onClick={() => onOpenPath(report.reportPath)} className={button}>
          <FileText size={15} className="shrink-0" aria-hidden="true" />{tr('打开报告')}
        </button>}
      </div>
      <ReportSummaryAction key={report.reportRef.importId || report.taskId}
        result={report} muted={muted} isDark={isDark} onOpenPath={onOpenPath}
        canGenerateSummary={canGenerateSummary} isVipLoading={isVipLoading} onOpenSummaryMembership={onOpenSummaryMembership}
        disabled={selecting} onPendingChange={setSummarizing} onAiSummary={updateSummary} />
    </div>}
  </section>;
}
