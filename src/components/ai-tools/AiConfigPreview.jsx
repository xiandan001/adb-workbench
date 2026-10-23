import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';
import { previewValue } from './aiToolsModel';

export default function AiConfigPreview({ preview, restoring = false, theme, onApply, onClose }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const apply = async () => {
    if (busy) return; setError('');
    if (!preview.token || !Number.isFinite(preview.expiresAt) || preview.expiresAt <= Date.now()) { setError('预览已过期，请关闭后重新生成；未修改任何文件'); return; }
    setBusy(true);
    try { await onApply(preview.token); onClose(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <AiToolsDialog title={restoring ? '预览配置恢复' : '预览配置变更'} wide theme={theme} busy={busy} onClose={onClose}>
    <p className={`mb-3 text-xs leading-5 ${theme.textMuted}`}>请核对目标路径和变更。只应用预览中的受管理字段，密钥已隐藏；文件若被其它程序修改，操作将被拒绝。</p>
    <div className="space-y-3">{(preview.files || []).map(file => <section key={file.path} className="overflow-hidden rounded-lg border border-slate-400/20"><h4 className={`break-all border-b border-slate-400/15 px-3 py-2 text-xs ${theme.textMuted}`}>{file.path}{!file.exists ? '（将新建）' : ''}</h4><div className="overflow-x-auto"><table className="w-full table-fixed text-left text-xs"><thead className={theme.textMuted}><tr><th className="w-1/4 px-3 py-2">字段</th><th className="px-3 py-2">修改前</th><th className="px-3 py-2">修改后</th></tr></thead><tbody>{(file.changes || []).map((change, index) => <tr key={`${change.field}-${index}`} className="border-t border-slate-400/10"><th className="break-all px-3 py-2 align-top font-normal">{change.field}</th><td className="whitespace-pre-wrap break-all px-3 py-2 align-top font-mono">{previewValue(change, 'before')}</td><td className="whitespace-pre-wrap break-all px-3 py-2 align-top font-mono">{previewValue(change, 'after')}</td></tr>)}</tbody></table></div></section>)}</div>
    {(preview.warnings || []).map((warning, index) => <p key={index} className="mt-2 break-words text-xs text-amber-500">{typeof warning === 'string' ? warning : warning.message || '请核对本次变更'}</p>)}
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
    <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>取消</button><button type="button" disabled={busy || !preview.token} onClick={apply} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{restoring ? '确认恢复配置' : '确认应用配置'}</button></div>
  </AiToolsDialog>;
}
