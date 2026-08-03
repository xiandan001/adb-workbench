import {
  Clock3,
  Settings2,
  Smartphone,
  Upload
} from 'lucide-react';

function TaskCenterQuickStart({
  theme,
  scripts,
  activeTasks,
  history,
  onRecord,
  onImport,
  onOpenScript,
  onOpenAdvanced
}) {
  const isDark = theme.primary === 'tech';
  const panelClass = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200';
  const cardClass = isDark
    ? 'border-[#3E4145] bg-[#2D2F33] hover:border-emerald-500/60 hover:bg-[#34373B]'
    : 'border-slate-200 bg-slate-50 hover:border-emerald-400 hover:bg-emerald-50/40';
  const textClass = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const mutedClass = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const secondaryButton = isDark
    ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]'
    : 'border-slate-200 text-slate-700 hover:bg-slate-50';
  const entries = [
    {
      id: 'record',
      title: '录制操作',
      description: '在设备画面上操作，生成可以重复执行的步骤。',
      icon: Smartphone,
      action: onRecord
    },
    {
      id: 'import',
      title: '导入脚本',
      description: '运行已有的 Python、Shell、JSON 或 YAML 脚本。',
      icon: Upload,
      action: onImport
    }
  ];
  const visibleScripts = (scripts || []).slice(0, 5);
  const recentHistory = (history || []).slice(0, 5);
  const runningTasks = (activeTasks || []).filter(
    task => task.status === 'running' || task.status === 'queued'
  );

  return (
    <div className="space-y-5">
      <section className={'rounded-xl border p-5 shadow-sm ' + panelClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className={'text-lg font-semibold ' + textClass}>你想完成什么？</h3>
            <p className={'mt-1 text-sm ' + mutedClass}>先选择目标，复杂设置会在需要时再显示。</p>
          </div>
          <button
            type="button"
            onClick={onOpenAdvanced}
            className={'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ' + secondaryButton}
          >
            <Settings2 size={15} />
            高级编排
          </button>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {entries.map(entry => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={entry.action}
                data-task-center-guide={entry.id === 'record' ? 'recording-entry' : undefined}
                className={'rounded-xl border p-5 text-left transition-colors ' + cardClass}
              >
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
                  <Icon size={20} />
                </span>
                <span className={'block font-semibold ' + textClass}>{entry.title}</span>
                <span className={'mt-2 block text-sm leading-6 ' + mutedClass}>{entry.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      {runningTasks.length > 0 && (
        <section className={'rounded-xl border p-5 ' + panelClass}>
          <h4 className={'font-semibold ' + textClass}>正在运行</h4>
          <div className="mt-3 space-y-2">
            {runningTasks.map(task => (
              <div key={task.id} className={'flex justify-between rounded-lg border p-3 text-sm ' + cardClass}>
                <span>{task.scriptName || task.id}</span>
                <span className="text-emerald-500">{statusLabel(task.status)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={'rounded-xl border p-5 ' + panelClass}>
          <h4 className={'font-semibold ' + textClass}>已保存测试</h4>
          <div className="mt-3 space-y-2">
            {visibleScripts.length === 0 ? (
              <p className={'py-6 text-center text-sm ' + mutedClass}>暂无已保存测试</p>
            ) : visibleScripts.map(script => (
              <button
                key={script.id}
                type="button"
                onClick={() => onOpenScript(script)}
                className={'block w-full rounded-lg border p-3 text-left transition-colors ' + cardClass}
              >
                <span className={'block truncate font-medium ' + textClass}>{script.name}</span>
                <span className={'mt-1 block text-xs ' + mutedClass}>{script.steps?.length || 0} 个步骤</span>
              </button>
            ))}
          </div>
        </section>

        <section className={'rounded-xl border p-5 ' + panelClass}>
          <h4 className={'font-semibold ' + textClass}>最近运行</h4>
          <div className="mt-3 space-y-2">
            {recentHistory.length === 0 ? (
              <p className={'py-6 text-center text-sm ' + mutedClass}>暂无运行记录</p>
            ) : recentHistory.map(task => (
              <div key={task.id} className={'flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ' + cardClass}>
                <div className="min-w-0">
                  <div className={'truncate font-medium ' + textClass}>{task.scriptName || task.id}</div>
                  <div className={'mt-1 flex items-center gap-1 text-xs ' + mutedClass}>
                    <Clock3 size={11} />
                    {formatTime(task.endedAt || task.createdAt)}
                  </div>
                </div>
                <span className={statusColor(task.status)}>{statusLabel(task.status)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function statusLabel(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'running') return '执行中';
  if (status === 'queued') return '等待中';
  return status || '未知';
}

function statusColor(status) {
  if (status === 'success') return 'shrink-0 text-emerald-500';
  if (status === 'failed') return 'shrink-0 text-red-500';
  if (status === 'running' || status === 'queued') return 'shrink-0 text-amber-500';
  return 'shrink-0 text-slate-500';
}

function formatTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default TaskCenterQuickStart;
