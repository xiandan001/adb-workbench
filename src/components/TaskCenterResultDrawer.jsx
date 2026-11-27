import { tr, useLocale } from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Square, X, Sparkles, RotateCcw, GitCompare } from 'lucide-react';
import TaskRerunPanel from './TaskRerunPanel';
import TaskResultMatrix from './TaskResultMatrix';
import { isDarkTheme } from '../shared/theme';
import { getTaskStatusLabel } from '../shared/taskCenterWorkspace';
import { findFirstTaskFailure, taskMatrixStepStatus } from '../shared/taskResultMatrix.js';
import { exportTaskResult } from '../shared/taskResultDelivery.js';
import { taskTechnicalActions } from '../shared/resultActions.js';
import ResultActionsMenu from './ResultActionsMenu';

export default function TaskCenterResultDrawer({ task, theme, onClose, onCancel, onOpenPath, onRerun, onCompareParent, onOpenAnalysis }) {
  useLocale();
  const dialogRef = useRef(null);
  const rerunRef = useRef(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  const [exporting, setExporting] = useState(false), [delivery, setDelivery] = useState(null);
  const isDark = isDarkTheme(theme);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previousFocus?.focus?.();
    };
  }, []);
  useEffect(() => {
    if (!rerunOpen) return;
    rerunRef.current?.scrollIntoView({ block: 'nearest' });
    rerunRef.current?.focus({ preventScroll: true });
  }, [rerunOpen]);
  const running = task.status === 'running' || task.status === 'queued';
  const panel = isDark ? 'bg-[#202124] text-[#E8EAED] border-[#3E4145]' : 'bg-white text-slate-800 border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const deviceRuns = task.deviceRuns || [];
  const firstFailure = useMemo(() => running ? null : findFirstTaskFailure(task), [running, task]);
  const hasFailures = Boolean(firstFailure) || deviceRuns.some(run => run.status === 'failed' || (run.steps || []).some(step => taskMatrixStepStatus(step) === 'failed'));
  const canRerun = !running && hasFailures;
  const technicalActions = taskTechnicalActions(task, { onOpenPath, onOpenAnalysis, onCompareParent });
  const comparison = technicalActions.find(action => action.id === 'compare');
  async function analyzeRun() {
    if (handoffBusy) return;
    setHandoffBusy(true); setHandoffError('');
    try {
      const result = await window.electronAPI?.aiHandoffCreate?.({ reference: { kind: 'task-run', taskId: task.id } });
      if (!result?.ok) throw new Error(result?.error || tr('运行结果交接失败。'));
    } catch (failure) { setHandoffError(failure.message); }
    finally { setHandoffBusy(false); }
  }
  async function exportRun() {
    if (exporting) return;
    setExporting(true); setDelivery(null);
    try {
      const result = await exportTaskResult(task.id, window.electronAPI);
      if (result?.cancelled) return;
      if (!result?.ok) throw new Error(result?.error || tr('证据包导出失败'));
      setDelivery({ path: result.path, message: tr('本次运行证据包已导出，原始文件保持不变。') });
    } catch (failure) { setDelivery({ error: failure.message }); }
    finally { setExporting(false); }
  }
  return createPortal(
    <dialog
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      aria-labelledby="task-result-title"
      className={`fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full border-l p-0 shadow-2xl backdrop:bg-black/50 ${deviceRuns.length > 1 ? 'max-w-5xl' : 'max-w-2xl'} ${panel}`}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-current/10 p-5">
          <div className="min-w-0">
            <h3 id="task-result-title" className="text-lg font-semibold break-words">{task.scriptName || tr("任务详情")}</h3>
            <p className={`mt-1 text-sm ${muted}`}>{getTaskStatusLabel(task.status)}{tr(" · 完成 ")}{task.completedSteps || 0}{tr("，失败 ")}{task.failedSteps || 0}</p>
          </div>
          <button type="button" autoFocus onClick={onClose} className="rounded-lg p-2 hover:bg-slate-500/10" aria-label={tr("关闭任务详情")}><X size={20} /></button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <section aria-label={tr('运行结果概览')} className={`rounded-xl border p-4 ${task.error || hasFailures ? 'border-red-500/25 bg-red-500/5' : running ? 'border-slate-400/25' : 'border-emerald-500/25 bg-emerald-500/5'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{tr('运行结果概览')}</h4><span className={`text-xs ${muted}`}>{getTaskStatusLabel(task.status)}</span></div>
            <p className={`mt-2 text-sm leading-6 ${muted}`}>{running ? tr('运行尚未结束，结果会继续更新。') : canRerun ? tr('优先处理失败步骤，再决定是否复跑。') : tr('本次运行已结束，可查看步骤证据或导出证据包。')}</p>
            {task.error && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-red-500">{tr(task.error)}</p>}
          </section>
          {task.analysisOrigin && <details className="rounded-lg border border-current/10 p-3 text-sm"><summary className="cursor-pointer font-medium">{tr('原分析上下文（不是已验证结论）：')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{task.analysisOrigin.question}</p><p className="mt-2 whitespace-pre-wrap break-words opacity-70">{task.analysisOrigin.finding?.detail || task.analysisOrigin.summary}</p></details>}
          {rerunOpen && <div ref={rerunRef} tabIndex={-1}><TaskRerunPanel key={task.id} taskId={task.id} onStarted={onRerun} /></div>}
          {handoffError && <p role="alert" className="text-sm text-red-500">{handoffError}</p>}
          {delivery && <div role={delivery.error ? 'alert' : 'status'} className={`rounded-lg border border-current/10 p-3 text-sm ${delivery.error ? 'text-red-500' : 'text-emerald-500'}`}><p>{delivery.error || delivery.message}</p>{delivery.path && <button type="button" onClick={() => onOpenPath(delivery.path)} className="mt-2 hover:underline">{tr('打开已导出的证据包')}</button>}{delivery.error && <button type="button" disabled={exporting} onClick={exportRun} className="mt-2 hover:underline disabled:opacity-40">{tr('重试导出')}</button>}</div>}
          {task.stressSummary?.reason && task.stressSummary.reason !== task.error && <p className="text-sm text-amber-500">{task.stressSummary.reason}</p>}
          {task.targetPlatform === 'harmony' && deviceRuns.some(run => !run.comparisonIdentity?.harmonyUdid) && <p className="text-xs text-amber-500">{tr('未记录可靠鸿蒙 UDID；本连接可执行，但不能据此跨连接恢复、比较或自动复跑。')}</p>}
          <TaskResultMatrix key={task.id} task={task} isDark={isDark} muted={muted} onOpenPath={onOpenPath} firstFailure={firstFailure} />
          <details open={!firstFailure && (Boolean(task.error) || hasFailures)}>
            <summary className="cursor-pointer font-medium">{tr("运行日志")}</summary>
            <pre className={`mt-2 max-h-80 overflow-auto rounded-lg border border-current/10 p-3 text-xs whitespace-pre-wrap break-words ${muted}`}>{(task.logs || []).map(line => typeof line === 'string' ? line : `${line.at || ''} ${line.message || ''}`).join('\n') || tr("暂无日志")}</pre>
          </details>
        </div>
        <footer className="flex flex-wrap gap-2 border-t border-current/10 p-4">
          {!running && <button type="button" disabled={exporting} onClick={exportRun} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${canRerun ? theme.button.secondary : theme.button.primary}`}><Download size={15} />{exporting ? tr('正在导出…') : tr('导出本次证据包')}</button>}
          <button type="button" disabled={handoffBusy} onClick={analyzeRun} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}><Sparkles size={15} />{tr('分析本次运行')}</button>
          {canRerun && <button type="button" aria-expanded={rerunOpen} onClick={() => setRerunOpen(value => !value)} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.primary}`}><RotateCcw size={15} />{tr('仅复跑失败设备')}</button>}
          {comparison && <button type="button" disabled={exporting || handoffBusy} onClick={comparison.onSelect} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}><GitCompare size={15} />{comparison.label}</button>}
          <ResultActionsMenu isDark={isDark} disabled={exporting || handoffBusy} actions={technicalActions.filter(action => action !== comparison)} />
          {running && onCancel && <button type="button" onClick={() => onCancel(task.id)} className="flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-500"><Square size={14} />{tr("取消任务")}</button>}
        </footer>
      </div>
    </dialog>,
    document.body
  );
}
