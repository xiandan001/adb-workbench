import { Maximize2, Minimize2, Play, Square } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogFocusToolbar({ active, onToggle, sourceLabel, deviceLabel, running, busy, canStart, onStart, onStop, text, onText, theme }) {
  useLocale();
  const button = `inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  if (!active) return <button type="button" onClick={onToggle} className={button}><Maximize2 size={14} />{tr('专注日志')}</button>;
  return <header aria-label={tr('日志专注工具栏')} className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 ${theme.card}`}>
    <div className="min-w-0 flex-1 basis-40 text-xs"><p className="truncate font-medium" title={sourceLabel}>{sourceLabel}</p><p className={`truncate ${theme.textMuted}`} title={deviceLabel}>{tr('采集目标：{0}', { 0: deviceLabel || tr('未选择设备') })}</p></div>
    <input aria-label={tr('包含文本')} value={text} onChange={event => onText(event.target.value)} maxLength={1000} placeholder={tr('过滤日志文本，或点击包名 / Tag 快速筛选')} className={`min-w-0 flex-1 basis-48 rounded-lg border px-3 py-2 text-xs ${theme.input}`} />
    <button type="button" disabled={busy || !running && !canStart} onClick={running ? onStop : onStart} className={`${button} ${running ? 'text-red-500' : 'text-emerald-500'}`}>{running ? <Square size={13} /> : <Play size={14} />}{running ? tr('停止抓取') : tr('开始抓取')}</button>
    <button type="button" onClick={onToggle} className={button}><Minimize2 size={14} />{tr('退出专注')}</button>
  </header>;
}
