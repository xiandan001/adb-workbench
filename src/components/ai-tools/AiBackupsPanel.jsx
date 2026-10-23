import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Loader2, RefreshCw } from 'lucide-react';

export default function AiBackupsPanel({ onRequest, onPreview, canRestore, theme, resourceMode = false, refreshKey }) {
  const [backups, setBackups] = useState([]); const [loading, setLoading] = useState(false); const [busyId, setBusyId] = useState(''); const [error, setError] = useState('');
  const alive = useRef(true); const requestId = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++requestId.current; setLoading(true); setError('');
    try { const result = await onRequest(resourceMode ? 'resources_backups_list' : 'backups_list', {}); if (!Array.isArray(result?.backups)) throw new Error('备份列表格式无效'); if (alive.current && ticket === requestId.current) setBackups(result.backups); }
    catch (failure) { if (alive.current && ticket === requestId.current) setError(failure.message); }
    finally { if (alive.current && ticket === requestId.current) setLoading(false); }
  }, [onRequest, resourceMode]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load, refreshKey]);
  const restore = async backupId => {
    if (busyId) return; setBusyId(backupId); setError('');
    try { const preview = await onRequest(resourceMode ? 'resources_backup_preview_restore' : 'backup_preview_restore', { backupId }); if (alive.current) onPreview(preview); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusyId(''); }
  };
  return <section aria-label={resourceMode ? "AI 资源备份" : "AI 配置备份"} className={`rounded-xl border p-4 ${theme.card}`}><div className="flex items-center gap-2"><h3 className="flex-1 text-sm font-semibold">{resourceMode ? "MCP / 提示词备份与恢复" : "配置备份与恢复"}</h3><button type="button" aria-label={resourceMode ? "刷新 AI 资源备份" : "刷新 AI 配置备份"} disabled={loading} onClick={load} className={`rounded-lg p-2 disabled:opacity-40 ${theme.button.secondary}`}>{loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button></div><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>仅显示本模块创建的备份。恢复同样需要预览与确认；目标文件若已变化，将停止恢复。</p>
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
    <div className="mt-3 space-y-2">{backups.map(backup => <div key={backup.id} className="flex items-center gap-3 rounded-lg border border-slate-400/20 p-3"><History size={16} className="shrink-0 text-emerald-500" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{backup.toolId} · {new Date(backup.createdAt).toLocaleString()}</p>{(backup.files || []).map(file => <p key={file.path} title={file.path} className={`mt-1 truncate text-[11px] ${theme.textMuted}`}>{file.path}</p>)}</div><button type="button" aria-label={`预览恢复 ${backup.id}`} disabled={!canRestore || Boolean(busyId)} onClick={() => restore(backup.id)} className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{busyId === backup.id && <Loader2 size={13} className="animate-spin" />}预览恢复</button></div>)}{!loading && !backups.length && <p className={`rounded-lg border border-dashed border-slate-400/25 p-6 text-center text-xs ${theme.textMuted}`}>暂无备份；确认应用配置后会在这里列出恢复点。</p>}</div>
  </section>;
}
