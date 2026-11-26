import { useLayoutEffect, useRef, useState } from 'react';
import { getLocale, tr, useLocale } from '../shared/i18n.js';
import { serialTransactionName, serialTransactionStatus, serialTransactionValue, serialTransactionRecord, serialTransactionEvidence } from '../shared/serialTransactions.js';

const HEIGHT = 308, ROW_HEIGHT = 90;
const success = new Set(['matched', 'completed', 'result']);
const warning = new Set(['timeout', 'ambiguous', 'write-failed', 'rejected', 'transport-error']);
export default function SerialTransactionsView({ transactions, entries, following, theme, onRecord, onFollowing }) {
  const locale = useLocale(), region = useRef(null), [scrollTop, setScrollTop] = useState(0);
  const maximum = Math.max(0, transactions.length * ROW_HEIGHT - HEIGHT), top = following ? maximum : Math.min(scrollTop, maximum);
  const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - 2), rows = transactions.slice(start, start + Math.ceil(HEIGHT / ROW_HEIGHT) + 5);
  useLayoutEffect(() => { if (following && region.current) region.current.scrollTop = region.current.scrollHeight; }, [transactions, following]);
  const record = id => serialTransactionRecord(entries, id);
  return <div className="space-y-2">
    <div ref={region} role="region" aria-label={tr('RS232 命令响应')} tabIndex={0} style={{ height: HEIGHT }} className={`overflow-auto rounded-lg border ${theme.input}`}
      onScroll={event => { const node = event.currentTarget; setScrollTop(node.scrollTop); if (following && node.scrollHeight - node.scrollTop - node.clientHeight > ROW_HEIGHT) onFollowing(false); }}>
      {!transactions.length ? <p className={`flex h-full items-center justify-center p-4 text-center text-xs ${theme.textMuted}`}>{tr('尚无已识别命令。未识别报文保留在原始收发中。')}</p>
        : <div style={{ height: transactions.length * ROW_HEIGHT, position: 'relative' }}>{rows.map((item, index) => {
          const evidence = serialTransactionEvidence(item);
          const evicted = evidence.some(([, id]) => id && !record(id));
          const value = serialTransactionValue(item), status = serialTransactionStatus(item);
          return <article key={item.id} data-serial-transaction-id={item.id} data-serial-transaction-status={item.status} style={{ height: ROW_HEIGHT, top: (start + index) * ROW_HEIGHT, position: 'absolute' }} className="left-0 w-full min-w-0 space-y-1 border-b border-slate-400/15 px-3 py-2 text-xs">
            <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium" title={serialTransactionName(item, locale)}>{serialTransactionName(item, locale)}</span>{item.protocol === 'tcl' && <span className={`rounded border border-current/15 px-1.5 text-[10px] ${theme.textMuted}`}>TCL</span>}</div>
            <div className="flex min-w-0 items-center gap-2"><span className={`min-w-0 flex-1 truncate ${success.has(item.status) ? 'text-emerald-500' : warning.has(item.status) ? 'text-amber-500' : theme.textMuted}`} title={status}>{status}</span><span className={`shrink-0 text-[10px] ${theme.textMuted}`}>{Number.isFinite(item.elapsedMs) ? `${item.elapsedMs} ms` : new Date(item.requestAt).toLocaleTimeString(getLocale())}</span></div>
            <div className={`flex min-w-0 items-center gap-1 ${theme.textMuted}`}><span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={value || undefined}>{value || (evicted ? tr('部分原始记录已移出当前缓存。') : '')}</span>
              {evidence.map(([label, id]) => <button key={label} type="button" disabled={!record(id)} onClick={() => onRecord(id)} className="shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-[11px] disabled:opacity-30" title={id && !record(id) ? tr('部分原始记录已移出当前缓存。') : undefined} aria-label={tr('查看事务 {0} 的 {1} 原文', { 0: item.id, 1: label })}>{label}</button>)}</div>
          </article>;
        })}</div>}
    </div>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('显示最近 200 条已识别事务。写入端口不代表设备执行成功；状态以收到的协议回执为准。')}</p>
    {transactions.some(item => item.protocol === 'tcl' && ['ambiguous', 'timeout'].includes(item.status)) && <p className="text-[11px] leading-5 text-amber-500">{tr('TCL 通用回执不含指令编号；超时或冲突后请重新连接，系统不会自动重发。')}</p>}
  </div>;
}
