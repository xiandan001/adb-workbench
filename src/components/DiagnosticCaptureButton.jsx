import { useEffect, useRef, useState } from 'react';
import { Circle, FileText, Square, X } from 'lucide-react';
import { tr, useLocale, formatNumber } from '../shared/i18n.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';
import useApplicationLogCapture from '../shared/useApplicationLogCapture.js';
import ApplicationLogSection from './ApplicationLogSection.jsx';

export default function DiagnosticCaptureButton({ theme, open, onOpenChange }) {
  useLocale();
  const { view, model } = useApplicationLogCapture(), dialog = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  const recording = view.capture?.recording === true;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!open) return;
    const node = dialog.current, previous = document.activeElement;
    node?.showModal();
    return () => { node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  async function activate() {
    if (!view.loading && !view.busy && view.capture && !view.capture.available && !recording) {
      await model.start();
      return;
    }
    onOpenChange(true);
  }
  const elapsed = Math.max(0, Math.floor((now - (view.capture?.startedAt || now)) / 1000));
  return <>
    <button type="button" onClick={() => { void activate(); }} disabled={Boolean(view.busy)}
      aria-label={recording ? tr('诊断记录进行中，打开停止与导出') : tr('应用诊断记录')}
      title={tr('只记录卓控台运行日志；设备日志保持独立，不会自动上传。')}
      className={`inline-flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-50 ${recording ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : theme.button.secondary}`}>
      {recording ? <Circle size={13} fill="currentColor" className="shrink-0" /> : <FileText size={16} className="shrink-0" />}
      <span className="hidden min-w-0 sm:inline">{recording ? tr('记录中 {0}s', { 0: formatNumber(elapsed) }) : tr('诊断记录')}</span>
      {view.busy && <span className="text-xs">{tr('正在处理')}</span>}
    </button>
    {recording && <button type="button" disabled={Boolean(view.busy) || view.loading} onClick={() => { void model.stopAndExport(); }} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50 ${theme.button.secondary}`}><Square size={13} />{tr('停止并导出')}</button>}
    {view.error && !open && <button type="button" onClick={() => onOpenChange(true)} className="rounded px-2 py-1 text-xs text-red-500" role="alert">{tr('诊断记录未完成，查看详情')}</button>}
    {open && <dialog ref={dialog} aria-labelledby="application-diagnostics-title" onKeyDown={trapAppMessageFocus}
      onCancel={event => { event.preventDefault(); onOpenChange(false); }} className={`m-auto max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
      <header className="flex items-center justify-between gap-3 border-b border-current/10 p-4"><h2 id="application-diagnostics-title" className="font-semibold">{tr('卓控台诊断记录')}</h2><button type="button" autoFocus aria-label={tr('关闭')} onClick={() => onOpenChange(false)} className="rounded-lg p-2 hover:bg-slate-400/10"><X size={18} /></button></header>
      <div className="p-4"><p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('开始记录后复现问题，再停止并导出。这里不采集设备日志，也不执行设备操作。')}</p><ApplicationLogSection theme={theme} /></div>
    </dialog>}
  </>;
}
