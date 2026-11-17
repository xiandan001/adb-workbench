import { CheckCircle2, Clock3, Loader2, RotateCcw, TriangleAlert } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function LogAnalysisStatus({ state, busy = false, hasAnswer = false, hasReasoning = false, readOnly = false, isDark = false, onRetry, retryDisabled = false }) {
  useLocale();
  if (!state && hasAnswer) return null;
  const status = state?.status || (busy ? 'preparing' : 'historical-empty'), sent = (state?.sentRequests || 0) > 0;
  const labels = {
    preparing: tr('正在准备本次分析'), 'awaiting-confirmation': tr('等待发送确认'), sending: tr('已确认，等待 AI 回复'), responding: tr('正在接收分析内容'),
    stopping: tr('正在停止本次分析'), cancelled: tr('本次分析已取消'), stopped: tr('已停止分析'), failed: tr('本次分析未完成'),
    empty: tr('本次未返回分析结论'), completed: tr('本次分析已完成'), 'historical-empty': tr('该轮没有保存的分析回复'),
  };
  const details = {
    preparing: tr('日志范围已冻结；完整发送内容以确认预览为准。'),
    'awaiting-confirmation': sent ? tr('前面的请求已确认开始处理；本批内容仍需单独确认。') : tr('请检查完整发送预览；确认前不会联网发送。'),
    sending: tr('正在等待已确认请求的返回，不代表已完成分析。'), responding: '', stopping: tr('已收到的内容会保留。'),
    cancelled: sent ? tr('已确认的请求可能已发送，无法撤回已发送内容；已收到的内容保持不变。') : tr('没有发送给 AI，补充要求仍保留在输入框。'),
    stopped: hasAnswer || hasReasoning ? tr('已保留停止前收到的内容。') : tr('停止前未收到分析回复；补充要求仍保留。'),
    failed: state?.error || tr('请核对错误信息后重试；原有分析报告与日志证据保持不变。'),
    empty: hasReasoning ? tr('只收到思考内容，没有正式分析回复；补充要求仍保留。') : tr('没有收到可展示的回复；可再次分析当前筛选。'),
    completed: tr('AI 结论仍需结合原始证据核对。'), 'historical-empty': tr('历史记录没有保存结果或执行状态，不能确认该轮是否完成。'),
  };
  const working = ['preparing', 'sending', 'responding', 'stopping'].includes(status), retry = ['cancelled', 'stopped', 'failed', 'empty'].includes(status);
  const Icon = working ? Loader2 : status === 'failed' ? TriangleAlert : status === 'completed' ? CheckCircle2 : Clock3;
  return <div role={status === 'failed' ? 'alert' : 'status'} className={`mb-2 space-y-1 rounded-lg border px-3 py-2 text-xs ${status === 'failed' ? 'border-red-500/30 text-red-500' : isDark ? 'border-slate-600/70 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
    <p className="flex items-center gap-2 font-medium"><Icon size={13} aria-hidden="true" className={working ? 'animate-spin' : ''} />{labels[status] || labels.preparing}</p>
    {details[status] && <p className="break-words leading-5 opacity-80">{details[status]}</p>}
    {retry && !readOnly && onRetry && <button type="button" onClick={onRetry} disabled={retryDisabled} className="inline-flex items-center gap-1 rounded border border-current/30 px-2 py-1 disabled:opacity-40"><RotateCcw size={12} aria-hidden="true" />{tr('再次分析当前筛选')}</button>}
  </div>;
}
