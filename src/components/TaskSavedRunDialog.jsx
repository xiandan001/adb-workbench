import { useEffect, useRef } from 'react';
import { Play, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import { taskPlatformMismatch } from '../shared/taskPlatform';
import { trapAppMessageFocus } from '../shared/appMessageDialog';

export default function TaskSavedRunDialog({ request, devices, busy, error, theme, onTargetsChange, onConfirm, onCancel }) {
  useLocale();
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current, previous = document.activeElement;
    node.showModal();
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const dark = isDarkTheme(theme), script = request.script;
  const targets = request.deviceIds;
  const rows = [...devices, ...targets.filter(id => !devices.some(item => item.id === id)).map(id => ({ id, status: 'offline' }))];
  const offline = targets.some(id => !devices.some(item => item.id === id && item.status === 'device'));
  const mismatch = taskPlatformMismatch(script, targets);
  return <dialog ref={dialog} aria-labelledby="saved-task-run-title" onKeyDown={trapAppMessageFocus}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    className={`m-auto max-h-[90vh] w-[min(44rem,calc(100vw-2rem))] rounded-2xl border p-0 shadow-2xl backdrop:bg-black/55 ${dark ? 'bg-[#202124] border-[#3E4145] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-800'}`}>
    <header className="flex items-center justify-between gap-3 border-b border-current/10 px-5 py-4"><div className="min-w-0"><h3 id="saved-task-run-title" className="font-semibold">{tr('运行已保存测试')}</h3><p className="mt-1 break-words text-sm">{script.name}</p></div><button type="button" autoFocus disabled={busy} onClick={onCancel} aria-label={tr('关闭')} className="rounded-lg p-2 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button></header>
    <div className="max-h-[65vh] space-y-4 overflow-y-auto p-5">
      <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('核对目标和已保存参数后运行；当前编辑草稿保持不变。')}</p>
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-medium">{tr('目标设备')}</legend>
        {!rows.length && <p className={`text-xs ${theme.textMuted}`}>{tr('请至少选择一台在线设备')}</p>}
        {rows.map(device => <label key={device.id} className="flex items-start gap-2 break-words text-xs"><input type="checkbox" checked={targets.includes(device.id)} disabled={busy || device.status !== 'device' && !targets.includes(device.id)} onChange={event => onTargetsChange(event.target.checked ? [...targets, device.id] : targets.filter(id => id !== device.id))} className="mt-0.5 accent-emerald-500" /><span>{device.model || device.id} · {device.id}{device.status !== 'device' ? ` · ${tr('已离线')}` : ''}</span></label>)}
      </fieldset>
      {mismatch && <p role="alert" className="text-xs text-amber-500">{tr('任务平台与设备不一致，请为当前设备新建任务；旧脚本不会自动转换。')}</p>}
      <details open className={`rounded-xl border p-3 ${theme.input}`}><summary className="cursor-pointer text-sm font-medium">{tr('查看完整原脚本参数（仅本机）')}</summary><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr('这里显示即将执行的完整参数，可能包含手工输入的敏感内容；不会作为 AI 证据或包含在导出的证据包中。')}</p><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">{JSON.stringify(script, null, 2)}</pre></details>
      {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
    </div>
    <footer className="flex flex-wrap justify-end gap-2 border-t border-current/10 p-4"><button type="button" disabled={busy} onClick={onCancel} className={`rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}>{tr('取消')}</button><button type="button" disabled={busy || !targets.length || offline || mismatch || !script.steps?.length} onClick={onConfirm} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Play size={15} />{busy ? tr('正在准备') : tr('确认目标并运行')}</button></footer>
  </dialog>;
}
