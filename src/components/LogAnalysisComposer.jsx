import { useId, useRef } from 'react';
import { Send, StopCircle } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { LOG_ANALYSIS_PROMPT_LIMIT, submitLogAnalysisKey } from '../shared/logAnalysisState.js';

export default function LogAnalysisComposer({ value, onPromptChange, thinking, onThinkingChange, busy = false, state, hasAnswer = false, disabled = false, readOnly = false, onSubmit, onStop, theme, isDark = false }) {
  useLocale(); const inputId = useId(), hintId = useId(), composing = useRef(false);
  const blocked = disabled || readOnly;
  return <div className={`flex shrink-0 flex-wrap items-end gap-2 border-t px-4 py-2 ${isDark ? 'border-slate-600 bg-[#2D2F33]' : 'border-slate-200 bg-slate-50'}`}>
    <div role="group" aria-label={tr('回复方式')} className="flex shrink-0 rounded-lg border border-slate-400/30 p-0.5">
      {[[false, tr('快速')], [true, tr('思考')]].map(([selected, label]) => <button key={String(selected)} type="button" aria-pressed={thinking === selected} disabled={busy || readOnly} onClick={() => onThinkingChange(selected)} className={`rounded-md px-2 py-1.5 text-xs disabled:opacity-40 ${thinking === selected ? 'bg-emerald-500/15 text-emerald-500' : isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</button>)}
    </div>
    <label htmlFor={inputId} className="sr-only">{tr('补充要求（可选）')}</label>
    <textarea id={inputId} aria-describedby={hintId} rows={1} maxLength={LOG_ANALYSIS_PROMPT_LIMIT} value={value} disabled={readOnly}
      onChange={event => onPromptChange(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (submitLogAnalysisKey(event, { busy, disabled: blocked, composing: composing.current })) onSubmit(); }}
      placeholder={tr('补充要求（可选），Enter 发送，Shift+Enter 换行')}
      title={tr('补充要求仅保留在当前窗口；最多 4,000 字。Enter 发送，Shift+Enter 换行。')}
      className={`min-h-9 max-h-[min(6rem,max(2.5rem,calc(100cqh_-_10rem)))] min-w-0 flex-[1_1_12rem] resize-y rounded-lg border px-3 py-2 text-xs leading-5 outline-none [field-sizing:content] focus:ring-2 focus:ring-emerald-500 ${theme.input}`} />
    <p id={hintId} className="sr-only">{tr('Enter 发送，Shift+Enter 换行。切换回复方式不会发送请求。')}</p>
    {busy ? <button type="button" onClick={onStop} disabled={state?.status === 'stopping'} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs text-white disabled:opacity-50"><StopCircle size={14} />{(state?.sentRequests || 0) === 0 && state?.status === 'awaiting-confirmation' ? tr('取消本次') : tr('停止')}</button>
      : <button type="button" onClick={onSubmit} disabled={blocked} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Send size={14} />{hasAnswer ? value.trim() ? tr('发送追问') : tr('继续分析') : tr('分析当前筛选')}</button>}
  </div>;
}
