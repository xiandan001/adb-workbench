import { useRef } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { quotaValue, quotaView } from './aiToolsModel';
import useQuotaPolling from './useQuotaPolling';

const STATUS = { fresh: '已更新', stale: '上次数据 · 已陈旧', unavailable: '不可用', error: '查询失败' };
function time(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : '—'; }
export default function AiQuotaCard({ provider, result, error, busy, canQuery, onQuery, theme, active = true, revision, autoRefresh, onAutoRefresh }) {
  const elementRef = useRef(null);
  const poll = useQuotaPolling({ elementRef, provider, result, error, busy, canQuery, onQuery, active, revision, autoRefresh, onAutoRefresh });
  const quota = quotaView(result, provider.id); const status = error ? 'error' : quota.status;
  const source = typeof quota.source === 'string' ? quota.source : quota.source?.origin ? `${quota.source.origin}${quota.source.path || ''}` : '';
  return <article ref={elementRef} aria-label={`AI 额度 ${provider.name}`} className={`min-w-0 rounded-xl border p-4 ${theme.card}`}>
    <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{provider.name}</h3><p className={`mt-1 text-xs ${status === 'stale' || status === 'error' ? 'text-amber-500' : theme.textMuted}`}>{STATUS[status]}{quota.kind ? ` · ${quota.kind === 'plan' ? '服务商套餐额度' : '服务商账户余额'}` : ''}</p></div><button type="button" aria-label={`刷新 ${provider.name} 额度`} title={poll.cooling ? `服务商限流，请在 ${time(poll.retryAt)} 后重试` : '刷新额度；不会强制绕过服务商缓存或限流'} disabled={!poll.canRefresh} onClick={() => { void poll.refresh(); }} className={`rounded-lg p-2 disabled:opacity-40 ${theme.button.secondary}`}>{busy || poll.pending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button></div>
    {!poll.configured ? <p className={`mt-3 text-xs ${theme.textMuted}`}>{provider.quota?.adapter ? '先保存额度查询凭据，尚未发起请求。' : '未配置额度查询，尚未发起请求。'}</p> : <>
      {!error && quota.metrics.length > 0 ? <div className="mt-3 space-y-3">{quota.metrics.map((metric, index) => <div key={`${metric.label}-${index}`}><div className="flex items-center gap-2"><span className={`min-w-0 flex-1 truncate text-xs ${theme.textMuted}`}>{metric.label}</span><span className="text-sm font-semibold">{metric.remaining !== undefined ? `剩余 ${quotaValue(metric.remaining)}` : metric.used !== undefined ? `已用 ${quotaValue(metric.used)}` : '—'} <span className="text-xs font-normal">{metric.unit || ''}</span></span></div>{metric.total !== undefined && <p className={`mt-1 text-right text-[11px] ${theme.textMuted}`}>总量 {quotaValue(metric.total)}{metric.used !== undefined && metric.remaining !== undefined ? ` · 已用 ${quotaValue(metric.used)}` : ''}</p>}{metric.resetAt && <p className={`mt-1 text-[11px] ${theme.textMuted}`}>重置时间：{time(metric.resetAt)}</p>}</div>)}</div> : <p className={`mt-3 break-words text-xs leading-5 ${theme.textMuted}`}>{error || quota.reason || '没有可展示的额度，未知不代表零或无限。'}</p>}
      {status === 'stale' && quota.reason && <p className="mt-2 break-words text-xs text-amber-500">{quota.reason}</p>}
      <div className={`mt-3 border-t border-slate-400/15 pt-2 text-[10px] ${theme.textMuted}`}><div className="flex flex-wrap items-center justify-between gap-2"><p>观测时间：{time(quota.observedAt)} · 非本机调用量估算</p><label title="页面、窗口或卡片不可见时暂停" className="inline-flex cursor-pointer items-center gap-1"><input type="checkbox" aria-label={`自动刷新 ${provider.name} 额度`} checked={poll.automatic} onChange={event => poll.setAutomatic(event.target.checked)} className="accent-emerald-600" />每 60 秒自动刷新</label></div>{source && <p className="mt-1 truncate" title={source}>来源：{source}</p>}{poll.cooling && <p className="mt-1">可重试时间：{time(poll.retryAt)}</p>}</div>
    </>}
  </article>;
}
