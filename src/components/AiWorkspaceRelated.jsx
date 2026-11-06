import { useEffect, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { loadWorkspaceRelatedSnapshot, mergeWorkspaceRelatedState, workspaceRelatedTasks } from './AiWorkspaceFlow';

export default function AiWorkspaceRelated({ view, onOpen, disabled, theme, active = true }) {
  useLocale();
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    if (!open || !active) return;
    let alive = true, received = false;
    const accept = value => { received = true; if (alive) setSnapshot(previous => mergeWorkspaceRelatedState(previous, value)); };
    const off = window.electronAPI?.onTaskCenterUpdate?.(accept);
    loadWorkspaceRelatedSnapshot(window.electronAPI).then(value => {
      if (alive) setSnapshot(previous => received ? { ...previous, scripts: value.scripts } : value);
    }).catch(failure => { if (alive) setError(failure.message || tr('关联记录读取失败，请重试。')); });
    return () => { alive = false; off?.(); };
  }, [open, revision, active]);
  const items = workspaceRelatedTasks(view, snapshot || {});
  const statuses = { draft: tr('已保存任务，尚未运行'), success: tr('运行成功，仍需人工验证'), completed: tr('运行完成，仍需人工验证'), failed: tr('运行失败'), running: tr('正在运行'), queued: tr('等待运行'), cancelled: tr('已取消') };
  return <details open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setError(''); }} className={`rounded-xl border p-3 ${theme.card}`}>
    <summary className="cursor-pointer text-xs font-medium">{tr('关联任务与运行')}</summary>
    <div className="mt-3 space-y-2">
      <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('仅关联保存的来源标识；运行完成不等于根因已验证。')}</p>
      {items.map(item => <button key={item.runId || item.scriptId} type="button" disabled={disabled || !onOpen} onClick={() => onOpen(item.runId ? { runId: item.runId } : { scriptId: item.scriptId })} className={`block w-full rounded-lg border p-3 text-left text-xs disabled:opacity-40 ${theme.input}`}>
        <span className="block break-words font-medium">{item.label}</span><span className={`mt-1 block ${theme.textMuted}`}>{statuses[item.status] || tr('查看记录')}</span>
      </button>)}
      {!items.length && <p className={`text-xs ${theme.textMuted}`}>{snapshot ? tr('尚无关联任务或运行记录。') : tr('正在读取关联记录…')}</p>}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <button type="button" disabled={disabled} onClick={() => { setError(''); setRevision(value => value + 1); }} className={`rounded-lg px-3 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{tr('刷新关联记录')}</button>
    </div>
  </details>;
}
