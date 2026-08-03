import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  HelpCircle,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  X
} from 'lucide-react';
import {
  getOnboardingGuide,
  isTerminalTask,
  ONBOARDING_STAGES
} from '../shared/taskCenterOnboarding';
import SpotlightGuide from './SpotlightGuide';

function TaskCenterOnboarding({
  open,
  stage,
  taskId,
  task,
  theme,
  onStart,
  onRequestSkip,
  onTemporaryClose,
  onPersistStatus,
  onReplay,
  onRestartRecording,
  onCancelTask,
  onRetryStateLoad,
  dismissLabel = '跳过',
  initialError = ''
}) {
  const [savingStatus, setSavingStatus] = useState(false);
  const [refreshingState, setRefreshingState] = useState(false);
  const [error, setError] = useState(initialError);
  const isDark = theme.primary === 'tech';
  const panelClass = isDark
    ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]'
    : 'border-slate-200 bg-white text-slate-800';
  const mutedClass = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const softClass = isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-slate-50';
  const secondaryButton = isDark
    ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]'
    : 'border-slate-200 text-slate-700 hover:bg-slate-50';

  useEffect(() => {
    if (!open) return;
    setSavingStatus(false);
    setRefreshingState(false);
    setError(initialError);
  }, [open, initialError]);

  if (!open || typeof document === 'undefined') return null;

  const completeTutorial = async () => {
    if (savingStatus) return;
    setSavingStatus(true);
    setError('');
    try {
      const saved = await onPersistStatus('completed');
      if (!saved) setError('教程状态保存失败，请重试保存');
    } finally {
      setSavingStatus(false);
    }
  };

  const retryStateLoad = async () => {
    if (refreshingState) return;
    setRefreshingState(true);
    try {
      const loaded = await onRetryStateLoad?.();
      if (!loaded) setError(initialError || '教程状态读取失败，请重试');
    } finally {
      setRefreshingState(false);
    }
  };

  if (stage === ONBOARDING_STAGES.WELCOME) {
    return createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
        <section className={`relative w-full max-w-lg rounded-2xl border p-6 shadow-2xl ${panelClass}`}>
          <button
            type="button"
            aria-label={`${dismissLabel}新手教程`}
            onClick={onRequestSkip}
            className={`absolute right-4 top-4 rounded-lg border p-2 ${secondaryButton}`}
          >
            <X size={16} />
          </button>
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500">
            <HelpCircle size={24} />
          </div>
          <h3 className="mt-5 text-xl font-semibold">跟着操作，录制一次真实点击</h3>
          <p className={`mt-3 text-sm leading-7 ${mutedClass}`}>
            教程会引导你选择一台在线设备、读取真实画面，并在你确认安全的位置录制一次点击后回放。整个过程使用任务中心的真实功能。
          </p>
          <div className={`mt-4 rounded-xl border p-4 text-sm leading-6 ${softClass}`}>
            设备画面上的点击会真实发送到设备。教程不会替你选择位置，请点击不会造成删除、提交或付款等操作的安全区域。
          </div>
          {error && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-500">
              <span>{error}</span>
              {initialError && error === initialError && (
                <button type="button" disabled={refreshingState} onClick={retryStateLoad} className="shrink-0 rounded-md border border-red-500/30 px-3 py-1.5 disabled:opacity-50">
                  {refreshingState ? '正在重试...' : '重试读取'}
                </button>
              )}
            </div>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onRequestSkip} className={`rounded-lg border px-4 py-2 text-sm ${secondaryButton}`}>
              {dismissLabel}
            </button>
            <button type="button" onClick={onStart} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              开始教程
            </button>
          </div>
        </section>
      </div>,
      document.body
    );
  }

  if (stage === ONBOARDING_STAGES.REPLAY && taskId) {
    return createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
        <section className={`w-full max-w-md rounded-2xl border p-6 text-center shadow-2xl ${panelClass}`}>
          <Loader2 size={34} className="mx-auto animate-spin text-emerald-500" />
          <h3 className="mt-4 text-lg font-semibold">正在回放刚才的点击</h3>
          <p className={`mt-2 text-sm ${mutedClass}`}>请保持设备连接，任务完成后会自动显示结果。</p>
          <div className={`mt-4 rounded-lg border p-3 text-sm ${softClass}`}>
            当前状态：{taskStatusLabel(task?.status || 'queued')}
          </div>
          {!isTerminalTask(task) && (
            <button type="button" onClick={onCancelTask} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-500 hover:bg-red-500/10">
              <Square size={14} />
              取消回放
            </button>
          )}
        </section>
      </div>,
      document.body
    );
  }

  if (stage === ONBOARDING_STAGES.RESULT) {
    const succeeded = task?.status === 'success';
    return createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
        <section className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl ${panelClass}`}>
          <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${succeeded ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}>
            <CheckCircle2 size={24} />
          </div>
          <div className="mt-4 text-xs font-medium text-emerald-500">第 6/6 步</div>
          <h3 className="mt-1 text-xl font-semibold">你已经完成一次真实录制和回放</h3>
          <p className={`mt-2 text-sm leading-6 ${mutedClass}`}>
            本次回放状态：{taskStatusLabel(task?.status)}。即使设备环境导致失败或取消，你仍可以完成教程或重新尝试。
          </p>
          <div className={`mt-4 rounded-xl border p-4 text-sm ${softClass}`}>
            <div>录制步骤：1 个点击</div>
            {task?.error && <div className="mt-2 text-red-500">{task.error}</div>}
          </div>
          {error && <div className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onRestartRecording} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${secondaryButton}`}>
              <RotateCcw size={14} />
              重新录制
            </button>
            <button type="button" onClick={onReplay} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${secondaryButton}`}>
              <Play size={14} />
              重新回放
            </button>
            <button type="button" disabled={savingStatus} onClick={completeTutorial} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {savingStatus ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              完成教程
            </button>
          </div>
          <button type="button" onClick={onTemporaryClose} className={`mt-4 w-full text-center text-xs ${mutedClass} hover:underline`}>
            暂时关闭，下次继续从头开始
          </button>
        </section>
      </div>,
      document.body
    );
  }

  return (
    <SpotlightGuide
      guide={getOnboardingGuide(stage)}
      theme={theme}
      onSkip={onRequestSkip}
      skipLabel={dismissLabel === '关闭' ? '退出教程' : '跳过教程'}
    />
  );
}

function taskStatusLabel(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'running') return '执行中';
  if (status === 'queued') return '等待中';
  return '等待结果';
}

export default TaskCenterOnboarding;
