import { tr, useLocale, formatNumber } from '../shared/i18n.js';

export default function AiMaterialBudget({ draft, collected, busy, onAdjust, onRetry, theme }) {
  useLocale(); const exact = collected?.local, plan = collected?.plan, over = draft?.status === 'over-limit';
  const mib = bytes => formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 3 });
  return <section aria-label={tr('完整材料预算')} className={`min-w-0 space-y-2 rounded-xl border px-4 py-3 text-xs ${over ? 'border-amber-500/30 bg-amber-500/5' : theme.card}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{tr('完整材料预算')}</h3>
      <div className="flex flex-wrap gap-2">{draft && ['invalid', 'unavailable'].includes(draft.status) && <button type="button" disabled={busy} onClick={onRetry} className="rounded border border-current/20 px-2 py-1 disabled:opacity-40">{tr('重试预算核算')}</button>}
      <button type="button" disabled={busy} onClick={onAdjust} className="rounded border border-current/20 px-2 py-1 disabled:opacity-40">{tr('调整材料与选段')}</button></div></div>
    {exact ? <p role="status">{tr('本次完整本地证据 {0} / {1} MiB，已包含来源信息。', { 0: mib(exact.localBytes), 1: mib(exact.limitBytes) })}</p>
      : draft && ['ready', 'over-limit'].includes(draft.status) ? <>
        <p role="status">{tr('已知原始材料至少 {0} / {1} MiB；完整证据将在采集后核算。', { 0: mib(draft.minimumBytes), 1: mib(draft.limitBytes) })}</p>
        {draft.unknownSources > 0 && <p className={theme.textMuted}>{tr('{0} 项来源尚未采集，大小未知；预算检查不会读取设备。', { 0: draft.unknownSources })}</p>}
      </> : <p role="status" className={theme.textMuted}>{draft ? tr('预算暂时无法核算，采集时仍会执行完整上限检查。') : tr('正在本机核算已知材料，尚未读取设备或发送 AI。')}</p>}
    {over && !exact && <p role="alert" className="text-amber-600 dark:text-amber-400">{tr('已知材料连同最少来源信息已超过 20 MiB，请显式减少材料；原文没有替换或截断。')}{' '}{tr('至少需减少 {0} 字节；采集后仍会核算其他来源信息。', { 0: formatNumber(draft.minimumBytes - draft.limitBytes) })}</p>}
    {plan && <p role="status">{tr('当前计划约 {0} 个请求，初始分 {1} 批；这不是费用保证。', { 0: plan.requestCount, 1: plan.initialBatchCount })}{plan.needsSummary && ` ${tr('分块汇总可能需要额外请求及确认。')}`}</p>}
    <p className={`leading-5 ${theme.textMuted}`}>{tr('本地总上限 20 MiB 包含来源信息。每批仍需完整发送确认；不会静默裁剪或自动发送。')}</p>
  </section>;
}
