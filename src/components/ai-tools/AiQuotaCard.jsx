import { tr, getLocale, useLocale } from '../../shared/i18n.js';
import { useRef } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { quotaValue, quotaView, quotaMetricText } from './aiToolsModel';
import useQuotaPolling from './useQuotaPolling';


function time(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale()) : '—'; }
export default function AiQuotaCard({ provider, result, error, busy, canQuery, onQuery, theme, active = true, revision, autoRefresh, onAutoRefresh }) {
  useLocale();
  const STATUS = { fresh: tr("已更新"), stale: tr("上次数据 · 已陈旧"), unavailable: tr("不可用"), error: tr("查询失败") };
  const elementRef = useRef(null);
  const poll = useQuotaPolling({ elementRef, provider, result, error, busy, canQuery, onQuery, active, revision, autoRefresh, onAutoRefresh });
  const quota = quotaView(result, provider.id); const status = error ? 'error' : quota.status;
  const source = typeof quota.source === 'string' ? quota.source : quota.source?.origin ? `${quota.source.origin}${quota.source.path || ''}` : '';
  return <article ref={elementRef} aria-label={tr("AI 额度 {0}", { 0: provider.name })} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{provider.name}</h3><p className={`mt-1 text-xs ${status === 'stale' || status === 'error' ? 'text-amber-500' : theme.textMuted}`}>{STATUS[status]}{quota.kind ? ` · ${quota.kind === 'plan' ? tr("服务商套餐额度") : tr("服务商账户余额")}` : ''}</p></div><button type="button" aria-label={tr("刷新 {0} 额度", { 0: provider.name })} title={poll.cooling ? tr("服务商限流，请在 {0} 后重试", { 0: time(poll.retryAt) }) : tr("刷新额度；不会强制绕过服务商缓存或限流")} disabled={!poll.canRefresh} onClick={() => { void poll.refresh(); }} className={`rounded-lg p-2 disabled:opacity-40 ${theme.button.secondary}`}>{busy || poll.pending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button></div>
    {!poll.configured ? <p className={`mt-3 text-xs ${theme.textMuted}`}>{provider.quota?.adapter ? tr("先保存额度查询凭据，尚未发起请求。") : tr("未配置额度查询，尚未发起请求。")}</p> : <>
      {!error && quota.metrics.length > 0 ? <div className="mt-3 space-y-3">{quota.metrics.map((metric, index) => <div key={`${metric.label}-${index}`}><div className="flex items-center gap-2"><span className={`min-w-0 flex-1 truncate text-xs ${theme.textMuted}`}>{quotaMetricText(provider, metric.label)}</span><span className="text-sm font-semibold">{metric.remaining !== undefined ? tr("剩余 {0}", { 0: quotaValue(metric.remaining) }) : metric.used !== undefined ? tr("已用 {0}", { 0: quotaValue(metric.used) }) : '—'} <span className="text-xs font-normal">{quotaMetricText(provider, metric.unit) || ''}</span></span></div>{metric.total !== undefined && <p className={`mt-1 text-right text-[11px] ${theme.textMuted}`}>{tr("总量 {0}{1}", { 0: quotaValue(metric.total), 1: metric.used !== undefined && metric.remaining !== undefined ? tr(" · 已用 {0}", { 0: quotaValue(metric.used) }) : '' })}</p>}{metric.resetAt && <p className={`mt-1 text-[11px] ${theme.textMuted}`}>{tr("重置时间：{0}", { 0: time(metric.resetAt) })}</p>}</div>)}</div> : <p className={`mt-3 break-words text-xs leading-5 ${theme.textMuted}`}>{tr(error || quota.reason) || tr("没有可展示的额度，未知不代表零或无限。")}</p>}
      {status === 'stale' && quota.reason && <p className="mt-2 break-words text-xs text-amber-500">{tr(quota.reason)}</p>}
      <div className={`mt-3 border-t border-slate-400/15 pt-2 text-[10px] ${theme.textMuted}`}><div className="flex flex-wrap items-center justify-between gap-2"><p>{tr("观测时间：{0} · 非本机调用量估算", { 0: time(quota.observedAt) })}</p><label title={tr("页面、窗口或卡片不可见时暂停")} className="inline-flex cursor-pointer items-center gap-1"><input type="checkbox" aria-label={tr("自动刷新 {0} 额度", { 0: provider.name })} checked={poll.automatic} onChange={event => poll.setAutomatic(event.target.checked)} className="accent-emerald-600" />{tr("每 60 秒自动刷新")}</label></div>{source && <p className="mt-1 truncate" title={source}>{tr("来源：{0}", { 0: source })}</p>}{poll.cooling && <p className="mt-1">{tr("可重试时间：{0}", { 0: time(poll.retryAt) })}</p>}</div>
    </>}
  </article>;
}
