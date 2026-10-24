import { tr, useLocale, getLocale } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, MapPin, Trash2, X } from 'lucide-react';
import { logEntryIdentity } from '../shared/logMarkers';

export default function LogMarkers({ markers, onChange, draft, onDismissDraft, isDark, onLocate }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [removeId, setRemoveId] = useState('');
  const [locateMessage, setLocateMessage] = useState('');
  const dialogRef = useRef(null);
  const panel = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-800';
  const button = `rounded-lg border px-2.5 py-1.5 text-xs ${panel}`;
  const selected = markers.find(marker => marker.id === selectedId);
  const visible = open || Boolean(draft);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (visible && !dialog.open) dialog.showModal();
    if (!visible && dialog.open) dialog.close();
  }, [visible]);

  function close() { setOpen(false); setRemoveId(''); onDismissDraft(); }

  return (
    <>
      <button type="button" className={`${button} flex items-center gap-1`} onClick={() => setOpen(true)}><BookmarkPlus size={13} />{tr("问题标记")}{markers.length ? ` ${markers.length}` : ''}</button>
      <dialog ref={dialogRef} aria-label={draft ? tr("添加问题标记") : tr("问题标记")} onCancel={close} onClose={close}
        className={`m-auto w-[min(56rem,94vw)] max-h-[85vh] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{draft ? tr("标记这个问题") : tr("问题标记")}</h2><button type="button" aria-label={tr("关闭问题标记")} onClick={close}><X size={18} /></button></div>
        {draft ? <MarkerEditor key={draft.id} draft={draft} panel={panel} onSave={note => {
          onChange(previous => [...previous, { ...draft, note }]); setSelectedId(draft.id); setOpen(true); onDismissDraft();
        }} /> : (
          <>
            <p className="my-3 text-xs opacity-75">{tr("点击日志时间旁的标记图标，备注问题发生的位置。标记保留原文与当时前后各最多 5 条日志，不受过滤或清空影响；请用“保存会话”持久保存。")}</p>
            {!markers.length && <p className="py-6 text-center text-sm opacity-70">{tr("还没有问题标记，例如可备注“这里开始黑屏”。")}</p>}
            <div className="max-h-52 overflow-y-auto space-y-2">
              {markers.map(marker => <div key={marker.id} className={`flex items-center gap-2 rounded-lg border p-2 ${selected?.id === marker.id ? 'border-emerald-500 bg-emerald-500/10' : panel}`}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setSelectedId(marker.id); setRemoveId(''); setLocateMessage(''); }}><span className="block truncate text-sm font-medium">{marker.note}</span><span className="block truncate text-xs opacity-70">{formatMarkerTime(marker.entry.ts)} · {marker.entry.deviceId || tr("文件日志")}</span></button>
                <button type="button" className="shrink-0 p-1 opacity-70 hover:opacity-100" aria-label={tr("移除标记 {0}", { 0: marker.note })} onClick={() => setRemoveId(marker.id)}><Trash2 size={14} /></button>
              </div>)}
            </div>
            {removeId && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 p-3 text-xs"><span>{tr("移除这个标记？原始日志和已保存的会话不受影响。")}</span><button type="button" className={button} onClick={() => { onChange(previous => previous.filter(marker => marker.id !== removeId)); setRemoveId(''); }}>{tr("确认移除")}</button><button type="button" className={button} onClick={() => setRemoveId('')}>{tr("取消")}</button></div>}
            {selected && <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{selected.note}</h3><button type="button" className={`${button} flex items-center gap-1`} onClick={() => { const result = onLocate(selected); if (result === true) close(); else setLocateMessage(result); }}><MapPin size={12} />{tr("定位原日志")}</button></div>
              {locateMessage && <p role="status" className="mb-2 text-xs text-amber-500">{locateMessage}</p>}
              <p className="mb-2 text-xs opacity-70">{tr("标记时冻结的上下文。定位仅查找当前视图，不改变过滤条件。")}</p>
              <div className="max-h-[35vh] overflow-auto rounded-lg border border-emerald-500/30 font-mono text-xs">
                {(selected.context.length ? selected.context : [selected.entry]).map((entry, index) => <pre key={index} className={`whitespace-pre-wrap break-all border-b border-slate-500/15 px-3 py-2 ${logEntryIdentity(entry) === logEntryIdentity(selected.entry) ? 'bg-emerald-500/15' : ''}`}>{entry.raw}</pre>)}
              </div>
            </div>}
          </>
        )}
      </dialog>
    </>
  );
}

function formatMarkerTime(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(getLocale()) : tr("原日志未记录时间");
}

function MarkerEditor({ draft, panel, onSave }) {
  useLocale();
  const [note, setNote] = useState('');
  return <form onSubmit={event => { event.preventDefault(); if (note.trim()) onSave(note.trim()); }}>
    <p className="my-3 text-xs opacity-70">{formatMarkerTime(draft.entry.ts)} · {draft.entry.deviceId || tr("文件日志")}{tr(" · 原文和上下文已冻结")}</p>
    <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-emerald-500/30 p-3 text-xs">{draft.entry.raw}</pre>
    <label htmlFor="log-marker-note" className="block text-sm">{tr("问题备注")}</label>
    <input autoFocus id="log-marker-note" maxLength={240} value={note} onChange={event => setNote(event.target.value)} placeholder={tr("例如：这里开始黑屏")} className={`mt-1 w-full rounded-lg border p-2 text-sm ${panel}`} />
    <button type="submit" disabled={!note.trim()} className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{tr("添加标记")}</button>
  </form>;
}
