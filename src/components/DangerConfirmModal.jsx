import { isDarkTheme } from '../shared/theme';
import { AlertTriangle, Loader2, X } from 'lucide-react';

function DangerConfirmModal({
  open,
  theme,
  title = '确认操作',
  message,
  detail,
  bullets = [],
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'danger',
  loading = false,
  rememberChoice = false,
  rememberLabel = '下次不再提示',
  onRememberChoiceChange,
  onCancel,
  onConfirm
}) {
  if (!open) return null;
  const isDark = isDarkTheme(theme);
  const panel = isDark ? 'bg-[#202124] border-[#3E4145] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const soft = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const iconTone = tone === 'warning' ? 'text-amber-400 bg-amber-500/10' : 'text-red-400 bg-red-500/10';
  const confirmTone = tone === 'warning' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-red-500 hover:bg-red-600';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={loading ? undefined : onCancel}>
      <div className={`w-full max-w-md rounded-xl border shadow-2xl ${panel}`} onClick={(event) => event.stopPropagation()}>
        <div className={`flex items-start gap-3 border-b px-5 py-4 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconTone}`}>
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{title}</h3>
            {message && <p className={`mt-1 text-sm leading-relaxed ${muted}`}>{message}</p>}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className={`rounded-lg p-2 transition-colors disabled:opacity-50 ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {(detail || bullets.length > 0) && (
          <div className="px-5 py-4">
            <div className={`rounded-lg border px-3 py-3 text-sm leading-relaxed ${soft}`}>
              {detail && <p className={muted}>{detail}</p>}
              {bullets.length > 0 && (
                <ul className={`space-y-1 ${detail ? 'mt-2' : ''} ${muted}`}>
                  {bullets.map((item, index) => (
                    <li key={`${item}-${index}`} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-current" />
                      <span>{item}</span>
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
          <div className="flex items-center justify-end gap-2">
          <button
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
    </div>
  );
}

export default DangerConfirmModal;
