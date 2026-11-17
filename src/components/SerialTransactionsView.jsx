import { useLayoutEffect, useRef, useState } from 'react';
import { getLocale, tr, useLocale } from '../shared/i18n.js';
import { serialTransactionName, serialTransactionStatus, serialTransactionValue, serialTransactionRecord } from '../shared/serialTransactions.js';

const HEIGHT = 224, ROW_HEIGHT = 76;
export default function SerialTransactionsView({ transactions, entries, following, theme, onRecord, onFollowing }) {
  const locale = useLocale(), region = useRef(null), [scrollTop, setScrollTop] = useState(0);
  const maximum = Math.max(0, transactions.length * ROW_HEIGHT - HEIGHT), top = following ? maximum : Math.min(scrollTop, maximum);
  const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - 2), rows = transactions.slice(start, start + Math.ceil(HEIGHT / ROW_HEIGHT) + 5);
  useLayoutEffect(() => { if (following && region.current) region.current.scrollTop = region.current.scrollHeight; }, [transactions, following]);
  const record = id => serialTransactionRecord(entries, id);
  return <div className="space-y-2">
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('最近 200 次已识别查询；按会话、指令码和接收窗口关联，不代表设备执行成功。')}</p>
    <div ref={region} role="region" aria-label={tr('RS232 命令响应')} tabIndex={0} style={{ height: HEIGHT }} className={`overflow-auto rounded-lg border ${theme.input}`}
      onScroll={event => { const node = event.currentTarget; setScrollTop(node.scrollTop); if (following && node.scrollHeight - node.scrollTop - node.clientHeight > ROW_HEIGHT) onFollowing(false); }}>
      {!transactions.length ? <p className={`flex h-full items-center justify-center p-4 text-center text-xs ${theme.textMuted}`}>{tr('暂未识别电源、音量或静音查询。其他报文仍保留在原始收发中。')}</p>
        : <div style={{ height: transactions.length * ROW_HEIGHT, position: 'relative' }}>{rows.map((item, index) => <article key={item.id} data-serial-transaction-id={item.id} style={{ height: ROW_HEIGHT, top: (start + index) * ROW_HEIGHT, position: 'absolute' }} className="left-0 w-full min-w-0 space-y-1 border-b border-slate-400/15 px-3 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium" title={serialTransactionName(item, locale)}>{serialTransactionName(item, locale)}</span><span className={`max-w-[58%] truncate ${item.status === 'matched' ? 'text-emerald-500' : ['timeout', 'ambiguous', 'write-failed'].includes(item.status) ? 'text-amber-500' : theme.textMuted}`} title={serialTransactionStatus(item)}>{serialTransactionStatus(item)}</span></div>
          <div className={`flex min-w-0 items-center gap-2 ${theme.textMuted}`}><span className="min-w-0 flex-1 truncate">{serialTransactionValue(item) || new Date(item.requestAt).toLocaleTimeString(getLocale())}{Number.isFinite(item.elapsedMs) ? ` · ${item.elapsedMs} ms` : ''}</span>
            {[['TX', item.txRecordId], ['RX', item.rxRecordId]].map(([direction, id]) => <button key={direction} type="button" disabled={!record(id)} onClick={() => onRecord(id)} className="shrink-0 rounded border border-current/20 px-2 py-0.5 disabled:opacity-30" aria-label={tr('查看事务 {0} 的 {1} 原文', { 0: item.id, 1: direction })}>{direction}</button>)}</div>
          {(item.txRecordId && !record(item.txRecordId) || item.rxRecordId && !record(item.rxRecordId)) && <p className="truncate text-[10px] text-amber-500">{tr('部分原始记录已移出当前缓存。')}</p>}
        </article>)}</div>}
    </div>
  </div>;
}
