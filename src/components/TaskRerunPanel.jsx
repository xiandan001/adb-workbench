import { useEffect, useMemo, useRef, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';

export default function TaskRerunPanel({ taskId, onStarted }) {
  useLocale();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState([]);
  const [acceptChanges, setAcceptChanges] = useState(false);
  const [started, setStarted] = useState(false);
  const scriptText = useMemo(() => preview?.script ? JSON.stringify(preview.script, null, 2) : '', [preview?.script]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    Promise.resolve(window.electronAPI?.taskRerunPreview?.({ taskId })).then(result => {
      if (!live.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('复跑预览读取失败。'));
      setPreview(result.preview);
      setSelected((result.preview.failedDeviceIds || []).filter(id => !(result.preview.offlineDeviceIds || []).includes(id)));
    }).catch(failure => { if (live.current) setError(failure.message); }).finally(() => { if (live.current) setBusy(false); });
    return () => { live.current = false; };
  }, [taskId]);
  async function run() {
    if (busy || started) return;
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI?.taskRerunFailed?.({ previewId: preview.id, deviceIds: selected, acceptInputChanges: acceptChanges });
      if (!live.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('复跑未开始。'));
      if (!result.cancelled) { setStarted(true); onStarted?.(result.task); }
    } catch (failure) { if (live.current) setError(failure.message); }
    finally { if (live.current) setBusy(false); }
  }
  const changed = preview?.inputs?.some(input => input.changed);
  const unavailable = preview?.inputs?.some(input => input.state !== 'available');
  return <section className="space-y-3 rounded-lg border border-emerald-500/30 p-4 text-sm" aria-label={tr('失败设备复跑预览')}>
    <h4 className="font-medium">{tr('失败设备复跑预览')}</h4>
    {busy && !preview && <p>{tr('正在读取原脚本并核验输入文件…')}</p>}
    {preview?.available === false && <p className="text-amber-500">{preview.reason}</p>}
    {preview?.available && <>
      <p className="text-xs leading-5 opacity-70">{tr('使用原脚本快照，从第一步完整运行；不是从失败步骤继续。执行前还会再次确认。')}</p>
      <p>{preview.scriptName} · {tr('{0} 个步骤', { 0: preview.steps.length })}</p>
      <details className="rounded border border-current/10 p-3"><summary className="cursor-pointer font-medium">{tr('查看完整原脚本参数（仅本机）')}</summary><p className="mt-2 text-xs opacity-70">{tr('这里显示即将执行的完整参数，可能包含手工输入的敏感内容；不会作为 AI 证据或包含在导出的证据包中。')}</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{scriptText}</pre></details>
      <div className="space-y-1">{preview.failedDeviceIds.map(id => <label key={id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selected.includes(id)} disabled={busy || started || preview.offlineDeviceIds.includes(id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, id] : ids.filter(item => item !== id))} />{id}{preview.offlineDeviceIds.includes(id) && <span className="text-amber-500">{tr('已离线')}</span>}</label>)}</div>
      {preview.inputs.map((input, index) => <div key={`${input.stepId}-${input.field}-${index}`} className="break-all rounded border border-current/10 p-2 text-xs"><span>{input.path}</span><p className={input.state !== 'available' || input.changed ? 'text-amber-500' : 'opacity-70'}>{input.state !== 'available' ? tr('文件缺失或不可读取') : input.changed ? tr('内容已变化') : tr('内容与原运行一致')}</p></div>)}
      {changed && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={acceptChanges} disabled={busy || started} onChange={event => setAcceptChanges(event.target.checked)} />{tr('我已核对输入文件的变化，允许使用当前文件重新执行原脚本。')}</label>}
      <button type="button" onClick={run} disabled={busy || started || !selected.length || unavailable || (changed && !acceptChanges)} className="rounded-lg bg-emerald-600 px-3 py-2 text-white disabled:opacity-40">{started ? tr('新的运行已创建') : tr('确认所选设备并复跑')}</button>
    </>}
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
  </section>;
}
