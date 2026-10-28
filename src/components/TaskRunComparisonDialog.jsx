import { tr, useLocale, getLocale } from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, X } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { getTaskStatusLabel } from '../shared/taskCenterWorkspace';
import { compareTaskRuns } from '../shared/taskRunComparison';
import SelectMenu from './SelectMenu';

const CHANGE_LABELS = () => ({
  'new-failure': tr("新增失败"), recovered: tr("已恢复"), 'still-failing': tr("仍然失败"),
  unchanged: tr("保持成功"), unobserved: tr("未完成，不判定")
});

function durationLabel(ms) {
  return ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function runLabel(run) {
  const date = new Date(run.startedAt || run.createdAt);
  const time = Number.isNaN(date.getTime()) ? tr("时间未知") : date.toLocaleString(getLocale(), { hour12: false });
  return `${run.scriptName || tr("未命名脚本")} · ${time} · ${getTaskStatusLabel(run.status)}`;
}

export default function TaskRunComparisonDialog({ history, theme, onClose, onOpenPath }) {
  const locale = useLocale();
  const dialogRef = useRef(null);
  const isDark = isDarkTheme(theme);
  const [beforeId, setBeforeId] = useState(history[1]?.id || '');
  const [afterId, setAfterId] = useState(history[0]?.id || '');
  const [changesOnly, setChangesOnly] = useState(true);
  const before = history.find(run => run.id === beforeId);
  const after = history.find(run => run.id === afterId);
  const comparison = useMemo(() => { void locale; return compareTaskRuns(before, after); }, [before, after, locale]);
  const options = history.map(run => ({ value: run.id, label: runLabel(run) }));
  const visibleSteps = comparison.steps.filter(step => !changesOnly || step.change !== 'unchanged');
  const panel = isDark ? 'bg-[#202124] text-[#E8EAED] border-[#3E4145]' : 'bg-white text-slate-800 border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); previousFocus?.focus?.(); };
  }, []);

  return createPortal(
    <dialog ref={dialogRef} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="task-comparison-title" className={`fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl rounded-xl border p-0 shadow-2xl backdrop:bg-black/50 ${panel}`}>
      <div className="flex max-h-[90dvh] flex-col">
        <header className="flex items-center justify-between border-b border-current/10 px-5 py-4">
          <div><h3 id="task-comparison-title" className="font-semibold">{tr("比较两次运行")}</h3><p className={`mt-1 text-xs ${muted}`}>{tr("同一脚本、相同运行参数、同一设备，才判断步骤变化。")}</p></div>
          <button type="button" autoFocus aria-label={tr("关闭运行对比")} onClick={onClose} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={20} /></button>
        </header>
        <div className="space-y-4 overflow-auto p-5">
          <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr]">
            <div className="min-w-0"><label htmlFor="compare-before" className={`mb-2 block text-xs ${muted}`}>{tr("基准运行")}</label><SelectMenu id="compare-before" value={beforeId} options={options} onChange={setBeforeId} isDark={isDark} placeholder={tr("选择基准运行")} /></div>
            <button type="button" onClick={() => { setBeforeId(afterId); setAfterId(beforeId); }} aria-label={tr("交换基准和本次运行")} className={`justify-self-center rounded-lg border p-2.5 ${theme.button.secondary}`}><ArrowLeftRight size={17} /></button>
            <div className="min-w-0"><label htmlFor="compare-after" className={`mb-2 block text-xs ${muted}`}>{tr("本次运行")}</label><SelectMenu id="compare-after" value={afterId} options={options} onChange={setAfterId} isDark={isDark} placeholder={tr("选择本次运行")} /></div>
          </div>
          {!comparison.comparable ? <p role="status" className={`rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>{comparison.reason}</p> : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-current/10 p-3 text-sm">
                <span className="text-red-500">{tr("新增失败 {0}", { 0: comparison.newFailures })}</span><span className="text-emerald-500">{tr("恢复 {0}", { 0: comparison.recovered })}</span>
                <span className={muted}>{tr("未完成 / 未执行 {0}", { 0: comparison.unobserved })}</span>
                <span>{tr("总耗时 {0} → {1}", { 0: durationLabel(comparison.beforeMs), 1: durationLabel(comparison.afterMs) })}</span>
              </div>
              <p className={`text-xs leading-5 ${muted}`}>{tr('只比较两次均实际完成的步骤；取消、未执行或仍在运行的步骤不算成功。耗时受设备状态影响。')}</p>
              <p className={`text-xs leading-5 ${before.inputHash && after.inputHash && before.inputHash === after.inputHash ? muted : 'text-amber-500'}`}>
                {before.inputHash && after.inputHash ? before.inputHash === after.inputHash ? tr('已记录的输入文件内容一致。') : tr('输入文件内容不同，请结合版本变化判断结果；不能视为完全相同的运行条件。') : tr('至少一次运行缺少输入文件内容校验，不能仅凭相同路径判断输入一致。')}
              </p>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={changesOnly} onChange={event => setChangesOnly(event.target.checked)} className="accent-emerald-500" />{tr("隐藏两次都成功的步骤")}</label>
              {visibleSteps.length === 0 && <p className={`py-8 text-center text-sm ${muted}`}>{tr("没有失败或待确认的步骤；取消勾选可查看全部步骤和耗时。")}</p>}
              <div className="space-y-2">
                {visibleSteps.map(step => <section key={step.id} className="rounded-lg border border-current/10 p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">{step.label}</h4><span className={step.change === 'recovered' ? 'text-emerald-500' : step.change === 'new-failure' || step.change === 'still-failing' ? 'text-red-500' : muted}>{CHANGE_LABELS()[step.change]}</span></div>
                  <p className={`mt-1 break-all font-mono text-xs ${muted}`}>{step.deviceId}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {[[tr("基准"), step.before, step.beforeMs], [tr("本次"), step.after, step.afterMs]].map(([label, run, ms]) => <div key={label} className="min-w-0 rounded border border-current/10 p-2">
                      <p>{label}：{run ? getTaskStatusLabel(run.status) : tr("未执行")} · {durationLabel(ms)}</p>
                      {run?.error && <p className="mt-1 break-words text-xs text-red-500">{tr(run.error)}</p>}
                      {run?.artifact && <button type="button" onClick={() => onOpenPath(run.artifact)} className="mt-2 text-xs text-emerald-500 hover:underline">{tr("打开{0}步骤证据", { 0: label })}</button>}
                    </div>)}
                  </div>
                  {step.deltaMs !== null && <p className={`mt-2 text-xs ${muted}`}>{tr("耗时变化：")}{step.deltaMs > 0 ? '+' : step.deltaMs < 0 ? '−' : ''}{durationLabel(Math.abs(step.deltaMs))}</p>}
                </section>)}
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-3 border-t border-current/10 pt-3">
            {[[before, tr("基准")], [after, tr("本次")]].map(([run, label]) => run?.artifactDir ? <button type="button" key={label} onClick={() => onOpenPath(run.artifactDir)} className="text-sm text-emerald-500 hover:underline">{tr("打开{0}证据目录", { 0: label })}</button> : null)}
          </div>
        </div>
      </div>
    </dialog>, document.body
  );
}
