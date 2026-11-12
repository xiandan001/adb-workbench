import { ArrowDownToLine, X } from 'lucide-react';
import { formatDateTime, tr, useLocale } from '../shared/i18n';

export default function AiWorkspaceHandoff({ handoff, targets = [], basket, onRemove, onClearBasket, onClear, disabled, theme }) {
  useLocale();
  if (basket) return <section aria-label={tr('本地证据篮')} className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
    <div className="flex flex-wrap items-center gap-2"><ArrowDownToLine size={14} /><h4 className="flex-1 text-xs font-medium">{tr('本地证据篮')} · {basket.length}/8</h4>{basket.length > 0 && <button type="button" onClick={onClearBasket} disabled={disabled} className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{tr('清空材料')}</button>}</div>
    {basket.map(item => <article key={item.id} className="space-y-1 border-t border-cyan-500/15 pt-2">
      <div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-words text-xs">{item.title}</p><button type="button" onClick={() => onRemove(item.id)} disabled={disabled} aria-label={tr('移除材料')} className="rounded p-1 disabled:opacity-40"><X size={13} /></button></div>
      <p className={`break-all text-[11px] leading-5 ${theme.textMuted}`}>{item.origin} · {item.deviceId || tr('未知目标')} · {formatDateTime(item.createdAt)} · {item.lineCount} {tr('行')}</p>
      <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{item.provenance?.trust === 'renderer-view' ? tr('来自用户选中的界面内容，不视为后台已验证的设备状态。') : tr('来自所选来源的冻结快照；采集时间不代表不同设备时钟同步。')}{item.truncated && tr('仅代表上述局部内容，不是全部日志。')}</p>
    </article>)}
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('仅本机保存脱敏冻结材料，最多 8 项 / 1 MiB；重启不会重新采集或发送。')}</p>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('带入不等于发送授权。请核对目标后手动采集预览或生成草案。')}</p>
  </section>;
  if (!handoff && !targets.length) return null;
  const origin = handoff?.provenance?.trust || handoff?.provenance;
  return <section className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
    <div className="flex items-center gap-2"><ArrowDownToLine size={14} /><h4 className="flex-1 text-xs font-medium">{tr('已带入的上下文')}</h4>{onClear && <button type="button" onClick={onClear} disabled={disabled} aria-label={tr('移除已带入上下文')} className="rounded p-1 disabled:opacity-40"><X size={14} /></button>}</div>
    {handoff && <><p className="break-words text-xs">{handoff.title}</p><p className={`break-words text-[11px] ${theme.textMuted}`}>{handoff.deviceId} · {formatDateTime(handoff.createdAt)}</p><p className={`text-[11px] leading-5 ${theme.textMuted}`}>{origin === 'renderer-view' ? tr('来自用户选中的界面内容，不视为后台已验证的设备状态。') : tr('来自所选来源的冻结快照；采集时间不代表不同设备时钟同步。')}</p></>}
    {targets.length > 0 && <div className="space-y-1">{targets.map((target, index) => <p key={target.token || target.id} className="break-words text-xs">{target.id || `T${index + 1}`} · {target.label}</p>)}<p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('这些控件已由你只读选择；生成草案不会点击控件，运行时必须唯一匹配。')}</p></div>}
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('带入不等于发送授权。请核对目标后手动采集预览或生成草案。')}</p>
  </section>;
}
