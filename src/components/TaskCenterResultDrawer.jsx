import { tr, useLocale } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, FolderOpen, Square, X, Sparkles, RotateCcw } from 'lucide-react';
import TaskRerunPanel from './TaskRerunPanel';
import { isDarkTheme } from '../shared/theme';
import { getTaskStatusLabel } from '../shared/taskCenterWorkspace';
import { exportTaskResult } from '../shared/taskResultDelivery.js';

export default function TaskCenterResultDrawer({ task, theme, onClose, onCancel, onOpenPath, onRerun, onCompareParent, onOpenAnalysis }) {
  useLocale();
  const dialogRef = useRef(null);
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
  const running = task.status === 'running' || task.status === 'queued';
  const panel = isDark ? 'bg-[#202124] text-[#E8EAED] border-[#3E4145]' : 'bg-white text-slate-800 border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const steps = (task.deviceRuns || []).flatMap(run => (run.steps || []).map(step => ({ ...step, deviceId: run.deviceId })));
  const failures = steps.filter(step => step.status === 'failed' || step.error);
  const visibleSteps = failures.length ? failures : steps;
  const origin = task.analysisOrigin;
  const canOpenOrigin = origin && (origin.casebookId || origin.historyId || (origin.caseId && origin.turnId));
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
      className={`fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-2xl border-l p-0 shadow-2xl backdrop:bg-black/50 ${panel}`}
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
          {task.analysisOrigin && <details className="rounded-lg border border-current/10 p-3 text-sm"><summary className="cursor-pointer font-medium">{tr('原分析上下文（不是已验证结论）：')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{task.analysisOrigin.question}</p><p className="mt-2 whitespace-pre-wrap break-words opacity-70">{task.analysisOrigin.finding?.detail || task.analysisOrigin.summary}</p></details>}
          {rerunOpen && <TaskRerunPanel key={task.id} taskId={task.id} onStarted={onRerun} />}
          {handoffError && <p role="alert" className="text-sm text-red-500">{handoffError}</p>}
          {delivery && <div role={delivery.error ? 'alert' : 'status'} className={`rounded-lg border border-current/10 p-3 text-sm ${delivery.error ? 'text-red-500' : 'text-emerald-500'}`}><p>{delivery.error || delivery.message}</p>{delivery.path && <button type="button" onClick={() => onOpenPath(delivery.path)} className="mt-2 hover:underline">{tr('打开已导出的证据包')}</button>}{delivery.error && <button type="button" disabled={exporting} onClick={exportRun} className="mt-2 hover:underline disabled:opacity-40">{tr('重试导出')}</button>}</div>}
          {task.error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500 whitespace-pre-wrap break-words">{tr(task.error)}</div>}
          {task.stressSummary?.reason && task.stressSummary.reason !== task.error && <p className="text-sm text-amber-500">{task.stressSummary.reason}</p>}
          <section>
            <h4 className="font-medium">{tr("运行设备")}</h4>
            {task.targetPlatform === 'harmony' && (task.deviceRuns || []).some(run => !run.comparisonIdentity?.harmonyUdid) && <p className="mt-2 text-xs text-amber-500">{tr('未记录可靠鸿蒙 UDID；本连接可执行，但不能据此跨连接恢复、比较或自动复跑。')}</p>}
            <div className="mt-2 space-y-2">
              {(task.deviceRuns || []).map(run => <div key={run.originalDeviceId || run.deviceId} className="flex flex-wrap justify-between gap-2 rounded-lg border border-current/10 p-3 text-sm"><span className="font-mono break-all">{run.deviceId}</span><span>{getTaskStatusLabel(run.status)}</span></div>)}
            </div>
          </section>
          <section>
            <h4 className="font-medium">{failures.length ? tr("失败步骤（{0}）", { 0: failures.length }) : tr("执行步骤")}</h4>
            {visibleSteps.length === 0 && <p className={`mt-2 text-sm ${muted}`}>{tr("暂无步骤结果；任务可能尚未执行。")}</p>}
            <div className="mt-2 space-y-2">
              {visibleSteps.map((step, index) => (
                <div key={`${step.deviceId}-${step.id}-${index}`} className="rounded-lg border border-current/10 p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><span>{step.label || tr("步骤 {0}", { 0: (step.index ?? index) + 1 })}</span><span className={step.status === 'failed' ? 'text-red-500' : muted}>{getTaskStatusLabel(step.status)}</span></div>
                  <div className={`mt-1 text-xs font-mono break-all ${muted}`}>{step.deviceId}</div>
                  {step.error && <p className="mt-2 whitespace-pre-wrap break-words text-red-500">{tr(step.error)}</p>}
                  {step.output && <details className="mt-2"><summary className="cursor-pointer">{tr("查看输出")}</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">{step.output}</pre></details>}
                  {step.artifact && <button type="button" onClick={() => onOpenPath(step.artifact)} className="mt-2 text-emerald-500 hover:underline">{tr("打开该步骤证据")}</button>}
                </div>
              ))}
            </div>
            {failures.length > 0 && <p className={`mt-2 text-xs ${muted}`}>{tr("优先显示失败项；完整执行记录可查看运行数据。")}</p>}
          </section>
          <details open={Boolean(task.error) || failures.length > 0}>
            <summary className="cursor-pointer font-medium">{tr("运行日志")}</summary>
            <pre className={`mt-2 max-h-80 overflow-auto rounded-lg border border-current/10 p-3 text-xs whitespace-pre-wrap break-words ${muted}`}>{(task.logs || []).map(line => typeof line === 'string' ? line : `${line.at || ''} ${line.message || ''}`).join('\n') || tr("暂无日志")}</pre>
          </details>
          {task.artifactDir && <p className={`text-xs font-mono break-all ${muted}`}>{task.artifactDir}</p>}
        </div>
        <footer className="flex flex-wrap gap-2 border-t border-current/10 p-4">
          {!running && <button type="button" disabled={exporting} onClick={exportRun} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}><Download size={15} />{exporting ? tr('正在导出…') : tr('导出本次证据包')}</button>}
          {canOpenOrigin && onOpenAnalysis && <button type="button" onClick={() => onOpenAnalysis(origin)} className={`rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}>{tr('查看原分析')}</button>}
          {!running && task.mode === 'replay' && task.parentTaskId && onCompareParent && <button type="button" onClick={() => onCompareParent(task)} className={`rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}>{tr('与原失败运行比较')}</button>}
          <button type="button" disabled={handoffBusy} onClick={analyzeRun} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}><Sparkles size={15} />{tr('分析本次运行')}</button>
          {!running && ((task.deviceRuns || []).some(run => run.status === 'failed') || failures.length > 0) && <button type="button" onClick={() => setRerunOpen(value => !value)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}><RotateCcw size={15} />{tr('仅复跑失败设备')}</button>}
          {task.stressReportPath && <button type="button" onClick={() => onOpenPath(task.stressReportPath)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}><FileText size={15} />{tr("打开报告")}</button>}
          {(task.runResultPath || task.stressResultPath) && <button type="button" onClick={() => onOpenPath(task.runResultPath || task.stressResultPath)} className={`rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}>{tr("运行数据")}</button>}
          {task.artifactDir && <button type="button" onClick={() => onOpenPath(task.artifactDir)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}><FolderOpen size={15} />{tr("证据目录")}</button>}
          {running && onCancel && <button type="button" onClick={() => onCancel(task.id)} className="flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-500"><Square size={14} />{tr("取消任务")}</button>}
        </footer>
      </div>
    </dialog>,
    document.body
  );
}
