import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { tr, useLocale, formatDateTime, formatNumber } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import { createApplicationLogUi } from '../shared/applicationLogUi';

function captureStatus(state, loading) {
  if (!state) return loading ? tr('正在读取应用日志状态…') : tr('状态未知');
  if (state.recording) return tr('正在记录应用日志');
  const reasons = {
    'time-limit': tr('已达到 15 分钟上限，记录已停止。'),
    'size-limit': tr('已达到 20 MiB 上限，记录已停止。'),
    interrupted: tr('上次记录因应用退出而中断，已有日志可导出。'),
    'io-error': tr('日志写入失败，记录已停止。')
  };
  return reasons[state.reason] || (state.available ? tr('记录已停止，可导出日志。') : tr('尚未开始记录'));
}

export default function ApplicationLogSection({ theme }) {
  useLocale();
  const api = window.electronAPI;
  const [view, setView] = useState({ capture: null, busy: '', loading: true, error: '', readError: '', notice: '' });
  const model = useMemo(() => createApplicationLogUi({ api, onChange: setView }), [api]);
  useEffect(() => { model.activate(); return () => model.deactivate(); }, [model]);
  const state = view.capture, busy = Boolean(view.busy), disabled = busy || view.loading || !state;
  const error = view.error || view.readError || state?.error || '';
  const warning = state && ['time-limit', 'size-limit', 'interrupted', 'io-error'].includes(state.reason);
  const button = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40';
  const muted = isDarkTheme(theme) ? 'text-[#9AA0A6]' : 'text-slate-500';
  return <section aria-label={tr('应用日志')} className={`mt-3 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-start gap-3"><FileText size={19} className="mt-0.5 shrink-0 text-emerald-500" /><div className="min-w-0 flex-1">
      <h3 className={`text-sm font-semibold ${theme.text}`}>{tr('应用日志')}</h3>
      <p className={`mt-1 text-xs leading-5 ${muted}`}>{tr('记录卓控台的运行状态和错误，仅保存到本机，不会自动上传。')}</p>
      <p className={`text-xs leading-5 ${muted}`}>{tr('不采集设备日志、画面、终端命令、AI 内容、密钥或网址。')}</p>
    </div></div>
    <div className="mt-3 space-y-1">
      <p role="status" className={`text-sm ${warning ? 'text-amber-500' : state?.recording ? 'text-emerald-500' : theme.text}`}>{captureStatus(state, view.loading)}</p>
      {state && (state.recording || state.available) && <p className={`text-xs ${muted}`}>{tr('{0} 条记录 · {1} KiB', { 0: formatNumber(state.records), 1: formatNumber(state.bytes / 1024, { maximumFractionDigits: 1 }) })}{state.startedAt !== null && <span>{tr(' · 开始于 {0}', { 0: formatDateTime(state.startedAt) })}</span>}</p>}
      {state?.dropped > 0 && <p className="text-xs text-amber-500">{tr('有 {0} 条事件因限流或写入限制未保存，日志并非完整记录。', { 0: formatNumber(state.dropped) })}</p>}
      <p className={`text-xs leading-5 ${muted}`}>{tr('最多记录 15 分钟或 20 MiB；切换页面不会停止记录。')}</p>
      {state?.available && !state.recording && <p className={`text-xs leading-5 ${muted}`}>{tr('开始新记录会替换上次本地日志，请先导出需要保留的内容。')}</p>}
    </div>
    {error && <p role="alert" className="mt-2 break-words text-xs leading-5 text-red-500">{tr(error)}{view.readError && <span>{tr(' 状态尚未更新，可重试读取。')}</span>}</p>}
    {view.notice && <p role="status" className={`mt-2 text-xs leading-5 ${view.notice === 'exported' ? 'text-emerald-500' : muted}`}>{view.notice === 'exported' ? tr('应用日志已导出，未上传到任何服务。') : tr('已取消导出；记录已停止，可再次导出。')}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {state?.recording ? <button type="button" disabled={disabled} onClick={() => { void model.stopAndExport(); }} className={`${button} ${theme.button.primary}`}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}{view.busy === 'stop-export' ? tr('正在停止并导出…') : tr('停止并导出')}
      </button> : <button type="button" disabled={disabled} onClick={() => { void model.start(); }} className={`${button} ${state?.available ? theme.button.secondary : theme.button.primary}`}>
        {view.busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{view.busy === 'start' ? tr('正在开始记录…') : tr('开始记录')}
      </button>}
      {state?.available && !state.recording && <button type="button" disabled={disabled} onClick={() => { void model.export(); }} className={`${button} ${theme.button.primary}`}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{busy ? tr('正在导出…') : tr('导出日志')}
      </button>}
      {view.readError && <button type="button" disabled={busy || view.loading} onClick={() => { void model.refresh(); }} className={`${button} ${theme.button.secondary}`}><RefreshCw size={14} />{tr('重试读取')}</button>}
    </div>
  </section>;
}
