import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { trapAppMessageFocus } from '../shared/appMessageDialog';
import { isDarkTheme } from '../shared/theme';
import { AlertTriangle, Loader2, X } from 'lucide-react';

function DangerConfirmModal({
  open,
  theme,
  title = tr("确认操作"),
  message,
  detail,
  bullets = [],
  confirmLabel = tr("确定"),
  cancelLabel = tr("取消"),
  tone = 'danger',
  loading = false,
  rememberChoice = false,
  rememberLabel = tr("下次不再提示"),
  onRememberChoiceChange,
  onCancel,
  onConfirm
}) {
  useLocale();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const target = cancelRef.current?.disabled ? dialogRef.current : cancelRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (loading) dialogRef.current?.focus({ preventScroll: true });
    else if (document.activeElement === dialogRef.current) cancelRef.current?.focus({ preventScroll: true });
  }, [open, loading]);
  if (!open) return null;
  const isDark = isDarkTheme(theme);
  const panel = isDark ? 'bg-[#202124] border-[#3E4145] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const soft = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const iconTone = tone === 'warning' ? 'text-amber-400 bg-amber-500/10' : 'text-red-400 bg-red-500/10';
  const confirmTone = tone === 'warning' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-red-500 hover:bg-red-600';

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={loading ? undefined : onCancel}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!loading) onCancel(); }
          else trapAppMessageFocus(event);
        }}
        className={`workbench-device-dialog w-full max-w-md rounded-xl border shadow-2xl ${panel}`} onClick={(event) => event.stopPropagation()}>
        <div className={`flex items-start gap-3 border-b px-5 py-4 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconTone}`}>
            <AlertTriangle size={20} />
          </span>
          <div className="workbench-dialog-heading">
            <h3 id={titleId} className="workbench-wrap-anywhere text-base font-semibold">{title}</h3>
            {message && <p className={`workbench-wrap-anywhere select-text mt-1 text-sm leading-relaxed ${muted}`}>{message}</p>}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className={`workbench-dialog-close rounded-lg p-2 transition-colors disabled:opacity-50 ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}
            title={tr("关闭")}
          >
            <X size={18} />
          </button>
        </div>

        {(detail || bullets.length > 0) && (
          <div className="px-5 py-4">
            <div className={`rounded-lg border px-3 py-3 text-sm leading-relaxed ${soft}`}>
              {detail && <p className={`workbench-wrap-anywhere select-text ${muted}`}>{detail}</p>}
              {bullets.length > 0 && (
                <ul className={`space-y-1 ${detail ? 'mt-2' : ''} ${muted}`}>
                  {bullets.map((item, index) => (
                    <li key={`${item}-${index}`} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-current" />
                      <span className="workbench-wrap-anywhere">{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className={`flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          {onRememberChoiceChange ? (
            <label className={`inline-flex items-center gap-2 text-sm ${muted}`}>
              <input
                type="checkbox"
                checked={rememberChoice}
                disabled={loading}
                onChange={(event) => onRememberChoiceChange(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 disabled:opacity-60"
              />
              <span>{rememberLabel}</span>
            </label>
          ) : <span />}
          <div className="workbench-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={loading}
            className={`rounded-lg border px-4 py-2 text-sm transition-colors disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60 ${confirmTone}`}
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
          </div>
        </div>
      </div>
    </div>, document.body
  );
}

export default DangerConfirmModal;
