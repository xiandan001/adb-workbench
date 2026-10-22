import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, RotateCcw, X } from 'lucide-react';
import { formatSshBytes, sshResult } from '../../shared/sshWorkspace';

const STATUS = { queued: '等待中', planning: '准备中', preparing: '准备中', running: '传输中', transferring: '传输中', completed: '已完成', done: '已完成', failed: '失败', error: '失败', cancelled: '已取消', cancelling: '取消中', conflict: '同名文件冲突，等待确认' };
export default function SshTransferQueue({ transfers, sessions, expanded, onExpanded, theme, showToast }) {
  const [busy, setBusy] = useState([]);
  const activeCount = transfers.filter(item => ['queued', 'planning', 'preparing', 'running', 'transferring', 'cancelling'].includes(item.status)).length;
  const act = async (transfer, retry) => {
    if (busy.includes(transfer.id)) return;
    setBusy(previous => [...previous, transfer.id]);
    try { sshResult(await window.electronAPI[retry ? 'sshRetryTransfer' : 'sshCancelTransfer']({ transferId: transfer.id })); }
    catch (error) { showToast?.(error.message); }
    finally { setBusy(previous => previous.filter(id => id !== transfer.id)); }
  };
  return <section aria-label="SSH 传输队列" className={`shrink-0 rounded-lg border ${theme.card}`}>
    <button type="button" aria-expanded={expanded} onClick={() => onExpanded(!expanded)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"><ChevronDown size={14} className={expanded ? '' : '-rotate-90'} /><span className="font-medium">传输队列</span><span className={theme.textMuted}>{activeCount ? `${activeCount} 项进行中` : `${transfers.length} 项记录`}</span><span className={`ml-auto ${theme.textMuted}`}>切换页面不中断</span></button>
    {expanded && <div className="max-h-32 overflow-auto border-t border-slate-400/20">
      {!transfers.length && <p className={`p-4 text-center text-xs ${theme.textMuted}`}>上传或下载文件后显示在这里</p>}
      {transfers.map(item => {
        const owner = sessions.find(session => session.id === item.sessionId);
        const progressing = ['queued', 'planning', 'preparing', 'running', 'transferring'].includes(item.status);
        const percentage = item.total > 0 ? Math.min(100, Math.max(0, item.bytes / item.total * 100)) : 0;
        return <div key={item.id} className="flex items-center gap-2 border-b border-slate-400/15 px-3 py-2 last:border-0" data-ssh-transfer-id={item.id}>
          {item.direction === 'upload' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}
          <div className="min-w-0 flex-1"><p className="truncate text-xs" title={`${item.source} → ${item.target}`}>{owner?.name || item.sessionId.slice(0, 8)} · {item.source} → {item.target}</p><p className={`mt-1 truncate text-[11px] ${item.error ? 'text-red-500' : theme.textMuted}`}>{STATUS[item.status] || item.status} · {formatSshBytes(item.bytes || 0)} / {formatSshBytes(item.total)}{item.speed ? ` · ${formatSshBytes(item.speed)}/s` : ''}{item.error ? ` · ${item.error}` : ''}</p>{progressing && <div className="mt-1 h-1 overflow-hidden rounded bg-slate-400/20"><div className="h-full rounded bg-emerald-500" style={{ width: `${percentage}%` }} /></div>}</div>
          {progressing && <button type="button" aria-label="取消传输" title="取消这项传输" disabled={busy.includes(item.id)} onClick={() => act(item, false)} className="rounded p-2 disabled:opacity-40"><X size={14} /></button>}
          {['failed', 'error', 'cancelled', 'conflict'].includes(item.status) && <button type="button" aria-label={item.status === 'conflict' ? '确认覆盖并重试' : '重试传输'} title="重新确认后重试" disabled={busy.includes(item.id)} onClick={() => act(item, true)} className="inline-flex items-center gap-1 rounded p-2 text-xs disabled:opacity-40"><RotateCcw size={14} />{item.status === 'conflict' ? '确认覆盖并重试' : ''}</button>}
        </div>;
      })}
    </div>}
  </section>;
}
