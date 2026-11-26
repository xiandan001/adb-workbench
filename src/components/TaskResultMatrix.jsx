import { useEffect, useId, useMemo, useState } from 'react';
import { Check, Circle, CircleX, Clock, Image, Minus, SkipForward } from 'lucide-react';
import { tr } from '../shared/i18n';
import { buildTaskResultMatrix, buildTaskStepEvidenceReference, taskStepLogs } from '../shared/taskResultMatrix.js';
import { getTaskStatusLabel } from '../shared/taskCenterWorkspace.js';

const statusView = {
  passed: [() => tr('已通过'), Check, 'bg-emerald-500/10', 'text-emerald-700', 'text-emerald-300'],
  failed: [() => tr('失败'), CircleX, 'bg-red-500/10', 'text-red-700', 'text-red-300'],
  skipped: [() => tr('已跳过'), SkipForward, 'bg-amber-500/10', 'text-amber-800', 'text-amber-300'],
  'not-run': [() => tr('未执行'), Minus, 'bg-slate-400/10'],
  cancelled: [() => tr('已取消'), CircleX, 'bg-amber-500/10', 'text-amber-800', 'text-amber-300'],
  running: [() => tr('运行中'), Clock, 'bg-sky-500/10', 'text-sky-700', 'text-sky-300'],
  unavailable: [() => tr('记录未保留'), Circle, 'bg-slate-400/10'],
  unknown: [() => tr('未知状态'), Circle, 'bg-slate-400/10'],
};

function stepLabel(column) {
  return column.label ? tr(column.label) : column.index === null ? tr('执行步骤') : tr('步骤 {0}', { 0: column.index + 1 });
}

function StepEvidence({ task, row, cell, roundIndex, isDark, muted, onOpenPath }) {
  const reference = buildTaskStepEvidenceReference(task.id, row, cell, roundIndex);
  const { step, column, status } = cell;
  const file = step?.screenshotArtifact || step?.artifact;
  const evidenceStepId = reference?.stepId;
  const evidenceIndex = reference?.stepIndex;
  const imageCandidate = Boolean(reference && typeof file === 'string' && /\.png$/i.test(file));
  const logCandidate = Boolean(reference && typeof step?.artifact === 'string' && /\.log$/i.test(step.artifact));
  const fileCandidate = Boolean(reference && typeof step?.artifact === 'string' && step.artifact);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if ((!imageCandidate && !fileCandidate) || !window.electronAPI?.taskStepEvidence) return;
    let current = true;
    const input = { taskId: task.id, deviceId: row.deviceId, stepIndex: evidenceIndex, stepId: evidenceStepId, roundIndex };
    Promise.resolve().then(() => window.electronAPI.taskStepEvidence(input)).then(result => {
      if (!current) return;
      setPreview(result?.ok ? result : {});
    }, () => { if (current) setPreview({}); });
    return () => { current = false; };
  }, [imageCandidate, fileCandidate, task.id, row.deviceId, evidenceIndex, evidenceStepId, roundIndex]);
  const hasPreviewApi = typeof window !== 'undefined' && Boolean(window.electronAPI?.taskStepEvidence);
  const image = typeof preview?.screenshot === 'string' && preview.screenshot.startsWith('data:image/png;base64,') ? preview.screenshot : '';
  const logs = taskStepLogs(task.logs, reference);
  const statusLabel = statusView[status][0]();
  return (
    <section aria-label={tr('步骤证据')} className="min-w-0 rounded-xl border border-current/10 bg-slate-400/5 p-3.5 text-sm">
      <header className="pb-2" aria-live="polite">
        <h5 className="font-semibold break-words">{stepLabel(column)} · {statusLabel}</h5>
        <p className={`mt-0.5 break-all font-mono text-xs ${muted}`}>{row.label}</p>
      </header>
      {!step ? <p className={`text-xs ${muted}`}>{tr('此单元格没有可查看的步骤证据。')}</p> : <div className="space-y-3">
        {step.error && <div><h6 className="text-xs font-semibold">{tr('错误信息')}</h6><p className={`mt-1 whitespace-pre-wrap break-words ${isDark ? 'text-red-300' : 'text-red-600'}`}>{tr(step.error)}</p></div>}
        <div className="space-y-1">
          <h6 className="flex items-center gap-1.5 text-xs font-semibold"><Image size={14} aria-hidden="true" />{tr('该步骤截图')}</h6>
          {image
            ? <img src={image} alt={tr('该步骤截图')} className="max-h-64 w-full rounded-lg border border-current/10 object-contain" />
            : <p className={`text-xs ${muted}`}>{imageCandidate && preview === null && hasPreviewApi ? tr('正在读取预览…') : tr('此步骤没有可预览的截图。')}</p>}
          {fileCandidate && preview?.ok === true && !preview.artifactConflict && onOpenPath &&
            <button type="button" onClick={() => onOpenPath(step.artifact)} className={`text-xs underline-offset-2 hover:underline ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>{tr('打开该步骤证据')}</button>}
        </div>
        {step.output && <details><summary className="cursor-pointer text-xs font-semibold">{tr('查看输出')}</summary><pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-current/10 p-2 text-xs">{step.output}</pre></details>}
        <div><h6 className="text-xs font-semibold">{tr('该步骤日志')}</h6>
          {logs.length || preview?.logText ? <pre className={`mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-current/10 p-2 text-xs ${muted}`}>{[logs.map(line => [line.at, line.message].filter(Boolean).join(' ')).join('\n'), preview?.logText].filter(Boolean).join('\n\n')}</pre>
            : logCandidate && preview === null && hasPreviewApi ? <p className={`mt-1 text-xs ${muted}`}>{tr('正在读取预览…')}</p>
            : <p className={`mt-1 text-xs ${muted}`}>{tr('没有可确认属于该设备此步骤的日志。')}</p>}
          {preview?.logTruncated && <p className="text-xs text-amber-600">{tr('文件较大，仅预览前 512 KB；原文件未修改。')}</p>}
        </div>
      </div>}
    </section>
  );
}

export default function TaskResultMatrix({ task, isDark, muted, onOpenPath }) {
  const title = useId();
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [requestedRound, setRequestedRound] = useState(null);
  const [selected, setSelected] = useState(null);
  const matrix = useMemo(() => buildTaskResultMatrix(task, { onlyAbnormal, requestedRound }), [task, onlyAbnormal, requestedRound]);
  const activeRow = selected?.roundIndex === matrix.roundIndex ? matrix.rows.find(row => row.key === selected?.row) : null;
  const activeCell = activeRow?.cells.find(cell => cell.column.key === selected.column && (!onlyAbnormal || cell.abnormal));
  const stickyBackground = isDark ? 'bg-[#202124]' : 'bg-white';
  return (
    <section aria-labelledby={title} className="min-w-0 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={title} className="font-semibold">{tr('多设备结果矩阵')}</h4>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {matrix.rounds.length > 0 && <label className="inline-flex items-center gap-2">
            <span>{tr('压测轮次')}</span>
            <select value={matrix.roundIndex} onChange={event => setRequestedRound(Number(event.target.value))} className={`rounded-md border border-current/15 p-1.5 ${stickyBackground}`}>
              {matrix.rounds.map(round => <option key={round} value={round}>{tr('第 {0} 轮', { 0: round })}</option>)}
            </select>
          </label>}
          <label className="inline-flex min-h-8 items-center gap-1.5">
            <input type="checkbox" checked={onlyAbnormal} onChange={event => setOnlyAbnormal(event.target.checked)} className="size-3.5 accent-emerald-500" />{tr('仅异常')}
          </label>
        </div>
      </div>
      {matrix.rows.length > 0 && matrix.columns.length > 0 ? (
        <div className={`grid min-w-0 gap-3 ${activeCell ? 'lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]' : ''}`}>
          <div className="max-h-[22rem] min-w-0 overflow-auto rounded-xl border border-current/10 focus-visible:outline focus-visible:outline-emerald-500" role="region" tabIndex={0} aria-label={tr('多设备结果矩阵')}>
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <thead>
                <tr>
                  <th scope="col" className={`sticky left-0 top-0 z-20 min-w-28 border-b border-r border-current/10 p-2.5 ${stickyBackground}`}>{tr('运行设备')}</th>
                  {matrix.columns.map(column => <th key={column.key} scope="col" className={`sticky top-0 z-10 min-w-24 max-w-44 border-b border-current/10 p-2.5 align-bottom break-words ${stickyBackground}`}>
                    {column.label && column.index !== null && <span className={`mr-1 font-mono ${muted}`}>{column.index + 1}</span>}{stepLabel(column)}
                  </th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map(row => <tr key={row.key}>
                  <th scope="row" className={`sticky left-0 z-10 max-w-40 border-b border-r border-current/10 p-2.5 break-all font-medium ${stickyBackground}`}>
                    <span className="block font-mono">{row.label}</span>
                    {row.runStatus && <span className={`block pt-0.5 font-normal ${muted}`}>{getTaskStatusLabel(row.runStatus)}</span>}
                  </th>
                  {row.cells.map(cell => {
                    const [name, Icon, background, light = '', dark = ''] = statusView[cell.status];
                    const status = name();
                    const pressed = matrix.roundIndex === selected?.roundIndex && selected?.row === row.key && selected?.column === cell.column.key;
                    return <td key={cell.column.key} className="border-b border-current/10 p-1.5">
                      {onlyAbnormal && !cell.abnormal ? <span aria-label={tr('已隐藏正常结果')} className={`block text-center ${muted}`}>—</span>
                        : <button type="button" aria-label={`${row.label} · ${stepLabel(cell.column)} · ${status}`}
                          aria-pressed={pressed} onClick={() => setSelected({ row: row.key, column: cell.column.key, roundIndex: matrix.roundIndex })}
                          className={`inline-flex min-h-9 w-full items-center justify-center gap-1 rounded-md px-2 font-medium hover:ring-1 hover:ring-current focus-visible:outline focus-visible:outline-emerald-500 ${background} ${isDark ? dark : light} ${pressed ? 'ring-1 ring-emerald-500' : ''}`}><Icon size={13} aria-hidden="true" />{status}</button>}
                    </td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>
          {activeCell && <StepEvidence key={JSON.stringify([activeRow.key, activeCell.column.key, matrix.roundIndex, activeCell.step?.screenshotArtifact || activeCell.step?.artifact])}
            task={task} row={activeRow} cell={activeCell} roundIndex={matrix.roundIndex} isDark={isDark} muted={muted} onOpenPath={onOpenPath} />}
        </div>
      ) : <p role="status" className={`rounded-lg border border-dashed border-current/15 p-3 text-xs ${muted}`}>
        {onlyAbnormal ? tr('没有异常步骤。') : tr('暂无步骤结果；任务可能尚未执行。')}
      </p>}
    </section>
  );
}
