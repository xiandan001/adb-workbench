import { useId } from 'react';
import { tr, useLocale } from '../shared/i18n';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Square,
  Trash2
} from 'lucide-react';
import { isDarkTheme } from '../shared/theme';

function TaskCenterRecordingWorkspace({
  theme,
  tapOnly,
  guided = tapOnly,
  harmony,
  draft,
  recorderPanel,
  saving,
  task,
  onBack,
  onSave,
  onReplay,
  onCancel,
  onClearSteps,
  onOpenAdvanced,
  selectedStepIndex = -1,
  onSelectStep,
  onUpdateStep,
  onMoveStep,
  onRemoveStep,
  renderSelectedStep,
  canReplay = true,
  replayBlock,
}) {
  useLocale();
  const stepEditorId = useId();
  const isDark = isDarkTheme(theme);
  const panelClass = isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white';
  const divider = isDark ? 'border-white/10' : 'border-slate-200';
  const textClass = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const mutedClass = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  const running = task?.status === 'running' || task?.status === 'queued';
  const locked = running || saving;
  const selectedStep = steps[selectedStepIndex];
  const tool = `rounded-lg border p-2 disabled:opacity-40 ${theme.button.secondary}`;

  return (
    <div className="min-w-0 space-y-4" data-task-recording="">
      <header className="space-y-2">
        <button type="button" onClick={onBack} className={`inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-500/10 ${mutedClass}`}>
          <ArrowLeft size={15} aria-hidden="true" />{tr("返回任务中心")}
        </button>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className={`min-w-0 break-words text-xl font-semibold ${textClass}`}>{draft.name || tr("录制操作")}</h3>
          {draft.name && <span className={`text-xs ${mutedClass}`}>{tr("录制操作")}</span>}
        </div>
        <p className={`text-xs leading-5 ${mutedClass}`}>{tapOnly
          ? tr("选择设备并读取界面，直接点击设备画面即可生成回放步骤。")
          : harmony ? tr("鸿蒙支持点击、原生长按和直线滑动，不录制曲线。")
            : tr("在设备画面上点击、长按，或拖出直线和曲线路径；录制会执行一次该操作。")}</p>
      </header>

      <div className="grid min-w-0 items-start gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(19rem,28%)]">
        <div className="min-w-0">{recorderPanel}</div>
        <section className={`min-w-0 overflow-hidden rounded-xl border ${panelClass}`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 ${divider}`}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h4 className={`font-semibold ${textClass}`}>{tr("已录制步骤")}</h4>
              <span className={`text-xs ${mutedClass}`}>{tr("{0} 个步骤", { 0: steps.length })}</span>
            </div>
            <button type="button" disabled={!steps.length || locked} onClick={onClearSteps}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-red-500/10 disabled:opacity-40 ${mutedClass}`}>
              <Trash2 size={14} aria-hidden="true" />{tr("清空")}
            </button>
          </div>
          {steps.length === 0 ? (
            <div className={`px-4 py-8 text-center text-sm ${mutedClass}`}>{tapOnly
              ? tr("读取界面后，在设备画面中点击一个安全位置。")
              : tr("读取界面后，直接点击、长按或拖拽设备画面生成步骤。")}</div>
          ) : (
            <ol className="max-h-56 space-y-1 overflow-auto p-2" aria-label={tr("已录制步骤")}>
              {steps.map((step, index) => {
                const active = index === selectedStepIndex;
                return <li key={step.id || index}>
                  <button type="button" onClick={() => onSelectStep?.(active ? -1 : index)} aria-pressed={active}
                    aria-controls={active && renderSelectedStep ? stepEditorId : undefined}
                    className={`flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-emerald-500 ${active ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-transparent hover:bg-slate-500/10'}`}>
                    <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${active ? 'bg-emerald-500/20 text-emerald-500' : 'bg-slate-500/10'}`}>{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block break-words text-sm font-medium ${textClass}`}>{step.label || stepTypeLabel(step)}</span>
                      <span className={`mt-0.5 block break-words text-xs ${mutedClass}`}>{stepSummary(step)}</span>
                    </span>
                    {active && <ChevronDown size={14} aria-hidden="true" className="shrink-0 opacity-70" />}
                  </button>
                </li>;
              })}
            </ol>
          )}
          {selectedStep && renderSelectedStep && <fieldset id={stepEditorId} disabled={locked} className={`min-w-0 space-y-3 border-t px-3 py-3 ${divider}`}>
            <legend className="sr-only">{tr("步骤 {0}", { 0: selectedStepIndex + 1 })}</legend>
            {onUpdateStep && <label className="block space-y-1.5">
              <span className={`text-xs ${mutedClass}`}>{tr("步骤名称")}</span>
              <input value={selectedStep.label || ''} onChange={(event) => onUpdateStep(selectedStepIndex, { label: event.target.value })}
                className={`w-full rounded-lg border px-3 py-2 text-sm ${panelClass} ${textClass}`} />
            </label>}
            <div className="grid min-w-0 gap-2.5">{renderSelectedStep(selectedStep, selectedStepIndex)}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {onUpdateStep && <label className={`mr-auto flex min-h-8 items-center gap-1.5 text-xs ${textClass}`}>
                <input type="checkbox" className="accent-emerald-500" checked={selectedStep.critical === true}
                  onChange={event => onUpdateStep(selectedStepIndex, { critical: event.target.checked })} />{tr("验收点")}
              </label>}
              {onMoveStep && <>
                <button type="button" className={tool} disabled={selectedStepIndex === 0} aria-label={tr("上移")} title={tr("上移")}
                  onClick={() => onMoveStep(selectedStepIndex, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className={tool} disabled={selectedStepIndex === steps.length - 1} aria-label={tr("下移")} title={tr("下移")}
                  onClick={() => onMoveStep(selectedStepIndex, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
              </>}
              {onRemoveStep && <button type="button" className="rounded-lg border border-red-500/30 p-2 text-red-500 hover:bg-red-500/10"
                aria-label={tr("删除步骤")} title={tr("删除步骤")} onClick={() => onRemoveStep(selectedStepIndex)}><Trash2 size={14} aria-hidden="true" /></button>}
            </div>
          </fieldset>}
          <div className={`border-t px-3 py-2 ${divider}`}>
            <button type="button" onClick={onOpenAdvanced} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-xs hover:bg-slate-500/10 ${mutedClass}`}>
              <Settings2 size={15} aria-hidden="true" />{tr("更多录制方式 / 高级编排")}
            </button>
          </div>
        </section>
      </div>

      <div className={`sticky bottom-2 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 shadow-sm ${panelClass}`}>
        <div className={`min-w-0 text-xs ${mutedClass}`}>
          {task && !running ? <div className="flex items-center gap-2" role="status">
            <CheckCircle2 size={15} className={`shrink-0 ${task.status === 'success' ? 'text-emerald-500' : 'text-amber-500'}`} aria-hidden="true" />
            <span>{tr("最近一次回放：{0}", { 0: taskStatusLabel(task.status) })} · {tr("完成 ")}{task.completedSteps || 0}{tr("，失败 ")}{task.failedSteps || 0}{tr("，总计 ")}{task.totalSteps || steps.length}</span>
          </div> : tr("{0} 个步骤，将按顺序回放一次。", { 0: steps.length })}
          {replayBlock && !running && <div className="mt-1 text-amber-600 dark:text-amber-400">{replayBlock}</div>}
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <button type="button" disabled={locked || steps.length === 0} onClick={onSave} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}>
            {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}{tr("保存流程")}</button>
          {running ? (
            <button type="button" onClick={onCancel} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-500 hover:bg-red-500/10">
              <Square size={14} />{tr("取消回放")}</button>
          ) : (
            <button
              type="button"
              data-task-center-guide="replay"
              disabled={locked || steps.length === 0 || !canReplay}
              onClick={onReplay}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={15} />{guided ? tr("开始回放") : tr("试跑")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function stepTypeLabel({ type, points }) {
  if (type === 'tap') return tr("点击");
  if (type === 'longPress') return tr("长按");
  if (type === 'swipe') return Array.isArray(points) && points.length > 2 ? tr("曲线滑动") : tr("滑动");
  if (type === 'input') return tr("输入文本");
  return tr("操作步骤");
}

function stepSummary(step) {
  if (step.type === 'tap') return tr("点击坐标 {0}, {1}", { 0: step.x ?? '-', 1: step.y ?? '-' });
  const duration = Number.isFinite(step.durationMs) ? ` · ${step.durationMs} ms` : '';
  if (step.type === 'longPress') return tr("长按坐标 {0}, {1}", { 0: step.x ?? '-', 1: step.y ?? '-' }) + duration;
  if (step.type === 'swipe') {
    const { x, y, endX, endY, points } = step;
    return (Array.isArray(points) && points.length > 2
      ? tr("从 {0},{1} 经过 {2} 个轨迹点到 {3},{4}", { 0: x ?? '-', 1: y ?? '-', 2: points.length, 3: endX ?? '-', 4: endY ?? '-' })
      : tr("从 {0},{1} 滑动到 {2},{3}", { 0: x ?? '-', 1: y ?? '-', 2: endX ?? '-', 3: endY ?? '-' })) + duration;
  }
  return step.description || step.command || stepTypeLabel(step);
}

function taskStatusLabel(status) {
  if (status === 'success') return tr("成功");
  if (status === 'failed') return tr("失败");
  if (status === 'cancelled') return tr("已取消");
  return status || tr("未知");
}

export default TaskCenterRecordingWorkspace;
