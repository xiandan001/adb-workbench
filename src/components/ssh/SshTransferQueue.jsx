import { tr, useLocale } from '../../shared/i18n.js';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, FolderOpen, RotateCcw, Trash2, X } from 'lucide-react';
import { formatSshBytes, sshResult } from '../../shared/sshWorkspace';


export default function SshTransferQueue({ transfers, sessions, expanded, onExpanded, onRevealLocation, onRefresh, theme, showToast }) {
  useLocale();
  const STATUS = { queued: tr("等待中"), planning: tr("准备中"), preparing: tr("准备中"), running: tr("传输中"), transferring: tr("传输中"), completed: tr("已完成"), done: tr("已完成"), failed: tr("失败"), error: tr("失败"), cancelled: tr("已取消"), cancelling: tr("取消中"), conflict: tr("同名文件冲突，等待确认") };
  const [busy, setBusy] = useState([]);
  const pending = useRef(new Set()); const alive = useRef(true); const locationRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const activeCount = transfers.filter(item => ['queued', 'planning', 'preparing', 'running', 'transferring', 'cancelling'].includes(item.status)).length;
  const act = async (transfer, operation) => {
    const key = transfer?.id || '*';
    if (pending.current.has(key) || pending.current.has('*') || key === '*' && pending.current.size) return;
    if (operation === 'clear' && !transfer.canClear) return;
    pending.current.add(key); setBusy([...pending.current]);
    const requestedLocation = operation === 'open' ? ++locationRequest.current : 0;
    try {
      const method = { retry: 'sshRetryTransfer', cancel: 'sshCancelTransfer', clear: 'sshClearTransfer', clearAll: 'sshClearTransfers', open: 'sshOpenTransferLocation' }[operation];
      const result = sshResult(await window.electronAPI[method](transfer ? { transferId: transfer.id } : undefined));
      if (!alive.current || result.cancelled) return;
      if (operation === 'clear' || operation === 'clearAll') {
        showToast?.(tr("已清除 {0} 项记录，文件未删除", { 0: result.removedIds.length })); void onRefresh?.();
      } else if (operation === 'open' && result.kind === 'remote' && requestedLocation === locationRequest.current) {
        await onRevealLocation?.(result, () => alive.current && requestedLocation === locationRequest.current);
      }
    }
    catch (error) { showToast?.(error.message); }
    finally { pending.current.delete(key); if (alive.current) setBusy([...pending.current]); }
  };
  return <section aria-label={tr("SSH 传输队列")} className={`shrink-0 rounded-lg border ${theme.card}`}>
    <div className="flex items-center gap-1 pr-2"><button type="button" aria-label={expanded ? tr("收起 SSH 传输队列") : tr("展开 SSH 传输队列")} aria-expanded={expanded} onClick={() => onExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs"><ChevronDown size={14} className={expanded ? '' : '-rotate-90'} /><span className="font-medium">{tr("传输队列")}</span><span className={theme.textMuted}>{activeCount ? tr("{0} 项进行中", { 0: activeCount }) : tr("{0} 项记录", { 0: transfers.length })}</span><span className={`ml-auto ${theme.textMuted}`}>{tr("切换页面不中断")}</span></button><button type="button" aria-label={tr("清除已结束 SSH 传输记录")} title={tr("仅清除已结束记录，不删除文件")} disabled={busy.length > 0 || !transfers.some(item => item.canClear)} onClick={() => act(null, 'clearAll')} className={`inline-flex shrink-0 items-center gap-1 rounded p-1.5 text-xs disabled:opacity-35 ${theme.button.secondary}`}><Trash2 size={14} />{tr("一键清除")}</button></div>
    {expanded && <div className="max-h-32 overflow-auto border-t border-slate-400/20">
      {!transfers.length && <p className={`p-4 text-center text-xs ${theme.textMuted}`}>{tr("上传或下载文件后显示在这里")}</p>}
      {transfers.map(item => {
        const owner = sessions.find(session => session.id === item.sessionId);
        const progressing = ['queued', 'planning', 'preparing', 'running', 'transferring'].includes(item.status);
        const working = busy.includes(item.id) || busy.includes('*');
        const remoteUnavailable = item.direction === 'upload' && owner?.status !== 'connected';
        const percentage = item.total > 0 ? Math.min(100, Math.max(0, item.bytes / item.total * 100)) : 0;
        return <div key={item.id} className="flex items-center gap-2 border-b border-slate-400/15 px-3 py-2 last:border-0" data-ssh-transfer-id={item.id}>
          {item.direction === 'upload' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}
          <div className="min-w-0 flex-1"><p className="truncate text-xs" title={`${item.source} → ${item.target}`}>{owner?.name || item.sessionId.slice(0, 8)} · {item.source} → {item.target}</p><p className={`mt-1 truncate text-[11px] ${item.error ? 'text-red-500' : theme.textMuted}`}>{STATUS[item.status] || item.status} · {formatSshBytes(item.bytes || 0)} / {formatSshBytes(item.total)}{item.speed ? ` · ${formatSshBytes(item.speed)}/s` : ''}{item.error ? ` · ${item.error}` : ''}</p>{progressing && <div className="mt-1 h-1 overflow-hidden rounded bg-slate-400/20"><div className="h-full rounded bg-emerald-500" style={{ width: `${percentage}%` }} /></div>}</div>
          {progressing && <button type="button" aria-label={tr("取消传输")} title={tr("取消这项传输")} disabled={working} onClick={() => act(item, 'cancel')} className="rounded p-2 disabled:opacity-40"><X size={14} /></button>}
          {['failed', 'error', 'cancelled', 'conflict'].includes(item.status) && <button type="button" aria-label={item.status === 'conflict' ? tr("确认覆盖并重试") : tr("重试传输")} title={tr("重新确认后重试")} disabled={working} onClick={() => act(item, 'retry')} className="inline-flex items-center gap-1 rounded p-2 text-xs disabled:opacity-40"><RotateCcw size={14} />{item.status === 'conflict' ? tr("确认覆盖并重试") : ''}</button>}
          {item.status === 'completed' && <button type="button" aria-label={tr("打开传输位置")} title={remoteUnavailable ? tr("此 SSH 会话已断开，无法定位远端目录") : item.direction === 'upload' ? tr("在此主机的文件树中打开上传目录") : tr("打开本地下载目录")} disabled={working || remoteUnavailable} onClick={() => act(item, 'open')} className="rounded p-2 disabled:opacity-40"><FolderOpen size={14} /></button>}
          {item.canClear && <button type="button" aria-label={tr("清除此传输记录")} title={tr("仅清除此记录，不删除文件")} disabled={working} onClick={() => act(item, 'clear')} className="rounded p-2 disabled:opacity-40"><X size={14} /></button>}
        </div>;
      })}
    </div>}
  </section>;
}
