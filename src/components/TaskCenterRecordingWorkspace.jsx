import {
  ArrowLeft,
  CheckCircle2,
  Play,
  RefreshCw,
  Save,
  Settings2,
  Square,
  Trash2
} from 'lucide-react';

function TaskCenterRecordingWorkspace({
  theme,
  draft,
  recorderPanel,
  saving,
  task,
  onBack,
  onSave,
  onReplay,
  onCancel,
  onClearSteps,
  onOpenAdvanced
}) {
  const isDark = theme.primary === 'tech';
  const panelClass = isDark ? 'border-[#3E4145] bg-slate-800/80' : 'border-slate-200 bg-white';
  const softClass = isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-slate-50';
  const textClass = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const mutedClass = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  const running = task?.status === 'running' || task?.status === 'queued';

  return (
    <div className="space-y-5">
      <section className={`rounded-xl border p-5 shadow-sm ${panelClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onBack} className={`rounded-lg border p-2 ${theme.button.secondary}`} title="返回任务中心">
              <ArrowLeft size={16} />
            </button>
            <div>
              <h3 className={`text-lg font-semibold ${textClass}`}>录制操作</h3>
              <p className={`mt-1 text-sm ${mutedClass}`}>选择设备并读取界面，直接点击设备画面即可生成回放步骤。</p>
            </div>
          </div>
          <button type="button" onClick={onOpenAdvanced} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}>
            <Settings2 size={15} />
            更多录制方式 / 高级编排
          </button>
        </div>
      </section>

      {recorderPanel}

      <section className={`rounded-xl border p-5 shadow-sm ${panelClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className={`font-semibold ${textClass}`}>已录制步骤</h4>
            <p className={`mt-1 text-xs ${mutedClass}`}>{steps.length} 个步骤，将按顺序回放一次。</p>
          </div>
          <button
            type="button"
            disabled={steps.length === 0 || running}
            onClick={onClearSteps}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 size={14} />
            清空
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {steps.length === 0 ? (
            <div className={`rounded-lg border border-dashed px-4 py-8 text-center text-sm ${isDark ? 'border-[#5F6368]' : 'border-slate-300'} ${mutedClass}`}>
              读取界面后，在设备画面中点击一个安全位置。
            </div>
          ) : steps.map((step, index) => (
            <div key={step.id || index} className={`flex items-center gap-3 rounded-lg border p-3 ${softClass}`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-500">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${textClass}`}>{step.label || stepTypeLabel(step.type)}</div>
                <div className={`mt-1 text-xs ${mutedClass}`}>{stepSummary(step)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button type="button" disabled={saving || steps.length === 0} onClick={onSave} className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}>
            {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
            保存流程
          </button>
          {running ? (
            <button type="button" onClick={onCancel} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-500 hover:bg-red-500/10">
              <Square size={14} />
              取消回放
            </button>
          ) : (
            <button
              type="button"
              data-task-center-guide="replay"
              disabled={steps.length === 0}
              onClick={onReplay}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={15} />
              开始回放
            </button>
          )}
        </div>
      </section>

      {task && !running && (
        <section className={`rounded-xl border p-5 shadow-sm ${panelClass}`}>
          <div className="flex items-center gap-3">
            <CheckCircle2 size={20} className={task.status === 'success' ? 'text-emerald-500' : 'text-amber-500'} />
            <div>
              <h4 className={`font-semibold ${textClass}`}>最近一次回放：{taskStatusLabel(task.status)}</h4>
              <p className={`mt-1 text-xs ${mutedClass}`}>完成 {task.completedSteps || 0}，失败 {task.failedSteps || 0}，总计 {task.totalSteps || steps.length}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function stepTypeLabel(type) {
  if (type === 'tap') return '点击';
  if (type === 'longPress') return '长按';
  if (type === 'swipe') return '滑动';
  if (type === 'input') return '输入文本';
  return '操作步骤';
}

function stepSummary(step) {
  if (step.type === 'tap') return `点击坐标 ${step.x ?? '-'}, ${step.y ?? '-'}`;
  if (step.type === 'longPress') return `长按坐标 ${step.x ?? '-'}, ${step.y ?? '-'}`;
  if (step.type === 'swipe') return `从 ${step.x ?? '-'},${step.y ?? '-'} 滑动到 ${step.endX ?? '-'},${step.endY ?? '-'}`;
  return step.description || step.command || stepTypeLabel(step.type);
}

function taskStatusLabel(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return status || '未知';
}

export default TaskCenterRecordingWorkspace;
