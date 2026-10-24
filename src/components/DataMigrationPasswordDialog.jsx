import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, LockKeyhole, X } from 'lucide-react';
import { migrationPasswordProblem } from './dataMigrationUi';

export default function DataMigrationPasswordDialog({ mode, fileName, busy, error, isDark, onClose, onSubmit }) {
  useLocale();
  const id = useId(); const dialogRef = useRef(null); const exporting = mode === 'export';
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [includeAiSessions, setIncludeAiSessions] = useState(true); const [problem, setProblem] = useState('');
  const input = `mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-[#5F6368] bg-[#3E4145] text-[#E8EAED]' : 'border-slate-300 bg-white text-slate-800'}`;
  useEffect(() => { const dialog = dialogRef.current; dialog.showModal(); return () => dialog.close(); }, []);
  const submit = event => {
    event.preventDefault(); if (busy) return;
    const message = migrationPasswordProblem(password, confirmation, exporting); setProblem(message); if (message) return;
    const secret = password; setPassword(''); setConfirmation(''); void onSubmit({ password: secret, includeAiSessions });
  };
  return <dialog ref={dialogRef} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className={`m-auto max-h-[90vh] w-[min(32rem,94vw)] overflow-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${isDark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}><form onSubmit={submit} autoComplete="off" className="space-y-3">
    <div className="flex items-center gap-2"><LockKeyhole size={18} className="text-emerald-500" /><h2 id={`${id}-title`} className="flex-1 text-base font-semibold">{exporting ? tr("导出加密迁移备份") : tr("输入迁移备份密码")}</h2><button type="button" aria-label={tr("关闭迁移密码窗口")} disabled={busy} onClick={onClose} className="rounded p-1 disabled:opacity-40"><X size={17} /></button></div>
    <p className="text-xs leading-5 opacity-75">{exporting ? tr("此备份包含已保存的 AI 供应商凭据及历史数据。请设置独立密码；密码不会保存，丢失后无法恢复。") : tr("使用导出时设置的密码。解密成功后还会展示数据摘要，确认之前不会写入本机数据。")}</p>
    {!exporting && fileName && <p className="break-all text-xs opacity-75">{tr("所选文件：{0}", { 0: fileName })}</p>}
    <label className="block text-xs">{exporting ? tr("备份密码") : tr("解密密码")}<input autoFocus type="password" autoComplete="new-password" value={password} onChange={event => { setProblem(''); setPassword(event.target.value); }} disabled={busy} className={input} /></label>
    {exporting && <><label className="block text-xs">{tr("确认备份密码")}<input type="password" autoComplete="new-password" value={confirmation} onChange={event => { setProblem(''); setConfirmation(event.target.value); }} disabled={busy} className={input} /></label><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={includeAiSessions} disabled={busy} onChange={event => setIncludeAiSessions(event.target.checked)} className="mt-1 accent-emerald-600" /><span>{tr("包含 AI 会话历史（默认包含）")}<span className="block opacity-70">{tr("显式导出时读取已支持的四类 CLI 会话目录和本软件会话归档；内容较大或敏感时可取消。")}</span></span></label></>}
    <p className="text-[11px] opacity-65">{tr("密码长度为 8–1024 UTF-8 字节。备份只保存在所选位置，不会自动上传。")}</p>
    {(problem || error) && <p role="alert" className="text-xs text-red-500">{problem || error}</p>}
    <div className="flex justify-end gap-2 pt-1"><button type="button" disabled={busy} onClick={onClose} className="rounded-lg border border-slate-400/35 px-3 py-2 text-sm disabled:opacity-40">{tr("取消")}</button><button type="submit" disabled={busy || !password} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40">{busy && <Loader2 size={14} className="animate-spin" />}{busy ? exporting ? tr("正在加密导出…") : tr("正在解密校验…") : exporting ? tr("选择位置并加密导出") : tr("解密并预览")}</button></div>
  </form></dialog>;
}
