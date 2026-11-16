import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { freezeLogSnapshot } from '../shared/logSessionWorkflow';
import SelectMenu from './SelectMenu';

export default function LogExportDialog(props) {
  return props.open ? <LogExportForm {...props} /> : null;
}
function LogExportForm({ isDark, onClose, scopes, getSnapshot, onMessage }) {
  useLocale();
  const first = scopes[0]?.id || 'loaded';
  const [scope, setScope] = useState(first), [snapshot, setSnapshot] = useState(() => freezeLogSnapshot(() => getSnapshot(first)));
  const [format, setFormat] = useState('raw'), [includeAi, setIncludeAi] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const dialog = useRef(null), alive = useRef(true), activeRequest = useRef(''), flight = useRef(false);
  const panel = isDark ? 'bg-[#202124] border-slate-600 text-slate-100' : 'bg-white border-slate-200 text-slate-800';
  useEffect(() => { const node = dialog.current, previous = document.activeElement; alive.current = true; node.showModal(); return () => {
    alive.current = false; node.close(); previous?.focus?.({ preventScroll: true });
    if (activeRequest.current) void window.electronAPI.logSessionCancel?.({ requestId: activeRequest.current });
  }; }, []);
  const close = () => { alive.current = false; if (activeRequest.current) void window.electronAPI.logSessionCancel?.({ requestId: activeRequest.current }); onClose(); };
  const selectScope = value => { try { const frozen = freezeLogSnapshot(() => getSnapshot(value)); setSnapshot(frozen); setScope(value); setPreview(null); setError(''); } catch (failure) { setError(failure.message); } };
  async function previewShare() {
    if (flight.current) return;
    const requestId = crypto.randomUUID(); flight.current = true; activeRequest.current = requestId; setBusy(true); setError('');
    try {
      const result = await window.electronAPI.logSessionExportPreview({ requestId, scope, format: 'bundle', redact: true, includeAi,
        snapshot: { ...snapshot, name: snapshot.name || tr('日志导出') } });
      if (!alive.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('脱敏预览失败，请重试。'));
      setPreview(result.preview);
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { flight.current = false; activeRequest.current = ''; if (alive.current) setBusy(false); }
  }
  async function exportNow() {
    if (flight.current) return;
    const requestId = crypto.randomUUID(), frozen = snapshot;
    flight.current = true; activeRequest.current = requestId; setBusy(true); setError('');
    try {
      const response = await window.electronAPI.logSessionExport({ requestId, scope, format, redact: format === 'bundle', includeAi: format === 'bundle' && includeAi,
        snapshot: { ...frozen, name: frozen.name || tr('日志导出') } });
      if (!alive.current) return;
      if (response?.cancelled) return;
      if (!response?.ok) throw new Error(response?.error || tr('日志导出失败，请重试。'));
      onMessage?.(tr('日志已导出，原始记录保持不变。')); onClose();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { flight.current = false; activeRequest.current = ''; if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-label={tr('导出日志')}
    className={`m-auto max-h-[85vh] w-[min(44rem,94vw)] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
    <header className="flex items-center justify-between"><h2 className="font-semibold">{tr('导出日志')}</h2><button type="button" autoFocus aria-label={tr('关闭')} onClick={close}><X size={18} /></button></header>
    <div className="mt-4 space-y-4"><SelectMenu value={scope} onChange={selectScope} options={scopes.map(item => ({ value: item.id, label: item.label }))} isDark={isDark} disabled={busy} ariaLabel={tr('导出范围')} />
      <p className="text-sm">{tr('已冻结 {0} 条日志、{1} 个标记；后续新日志不会改变本次导出。', { 0: snapshot.entries.length.toLocaleString(), 1: snapshot.markers.length })}</p>
      <fieldset disabled={busy} className="space-y-3 text-sm"><legend className="mb-2 text-xs opacity-70">{tr('导出方式')}</legend>
        <label className="flex items-start gap-2"><input type="radio" name="log-export-format" checked={format === 'raw'} onChange={() => setFormat('raw')} /><span>{tr('保留原文（.log）')}<span className="mt-1 block text-xs opacity-70">{tr('直接保存原始 raw 行，保留 Android / HiLog 字段。可能包含敏感内容，仅在你选择的位置保存。')}</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" name="log-export-format" checked={format === 'bundle'} onChange={() => setFormat('bundle')} /><span>{tr('脱敏问题包（.zip）')}<span className="mt-1 block text-xs opacity-70">{tr('包含所选日志、标记与范围说明。分享前应用敏感字段脱敏，不修改原件；仍请人工核对内容。')}</span></span></label>
        {format === 'bundle' && <label className="flex items-center gap-2"><input type="checkbox" checked={includeAi} onChange={event => setIncludeAi(event.target.checked)} />{tr('包含已有 AI 报告（不会调用 AI）')}</label>}
      </fieldset>
      {format === 'bundle' && <div className="space-y-2"><button type="button" disabled={busy} onClick={previewShare} className="rounded-lg border border-current/20 px-3 py-2 text-xs disabled:opacity-40">{tr('预览脱敏内容')}</button>{preview && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-current/15 p-2 text-xs">{preview.lines.join('\n')}</pre>}</div>}
      <details><summary className="cursor-pointer text-xs">{tr('核对原始选段（仅本机）')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-current/15 p-2 text-xs">{snapshot.entries.slice(0, 8).map(entry => entry.raw.slice(0, 2000)).join('\n')}</pre><p className="mt-1 text-xs opacity-70">{tr('这里只预览前 8 行，每行最多 2,000 字；导出保留所选范围的完整原文。')}</p></details>
      {error && <p role="alert" className="text-sm text-red-500">{tr(error)}</p>}
      <footer className="flex justify-end gap-2"><button type="button" onClick={close} className="rounded-lg border border-current/20 px-4 py-2 text-sm">{busy ? tr('取消导出') : tr('取消')}</button><button type="button" disabled={busy || !snapshot.entries.length} onClick={exportNow} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40"><Download size={15} />{busy ? tr('正在导出…') : tr('选择位置并导出')}</button></footer>
    </div>
  </dialog>;
}
