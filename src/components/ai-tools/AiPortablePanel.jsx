import { tr, getLocale, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, History, Loader2, LockKeyhole, RefreshCw, Upload } from 'lucide-react';
import AiToolsDialog from './AiToolsDialog';

function passwordProblem(password, confirmation, mode) {
  const bytes = new TextEncoder().encode(password).length;
  if (bytes < 8 || bytes > 1024 || password.includes('\0')) return tr("密码需要 8–1024 字节，不能包含空字符。");
  if (mode === 'export' && password !== confirmation) return tr("两次输入的密码不一致。");
  return '';
}
function previewProblem(value, kind) {
  if (!value || typeof value.token !== 'string' || !value.token || value.token.length > 128 || !Number.isFinite(value.expiresAt)) return tr("备份预览格式无效，未执行导入。");
  if (value.expiresAt <= Date.now()) return tr("预览已过期，请取消并重新预览；未修改数据。");
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 20 || value.warnings.some(item => typeof item !== 'string' || item.length > 5000))) return tr("备份预览格式无效，未执行导入。");
  const count = (number, maximum) => Number.isSafeInteger(number) && number >= 0 && number <= maximum;
  if (kind === 'recovery') {
    if (!count(value.counts?.restore, 2) || !count(value.counts?.unchanged, 2) || value.counts.restore + value.counts.unchanged !== 2) return tr("恢复数量格式无效，未执行恢复。");
  } else {
    for (const [key, maximum] of [['providers', 200], ['mcpServers', 256], ['prompts', 256]]) {
      const row = value.counts?.[key];
      if (!count(row?.added, maximum) || !count(row?.skipped, maximum) || row.added + row.skipped > maximum) return tr("导入数量格式无效，未修改数据。");
    }
  }
  return '';
}

function PortablePasswordDialog({ mode, busy, error, theme, onClose, onSubmit }) {
  useLocale();
  const id = useId(); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [problem, setProblem] = useState('');
  const exporting = mode === 'export';
  const submit = event => {
    event.preventDefault(); if (busy) return;
    const message = passwordProblem(password, confirmation, mode); setProblem(message); if (message) return;
    const secret = password; setPassword(''); setConfirmation(''); void onSubmit(secret);
  };
  return <AiToolsDialog title={exporting ? tr("导出 AI 加密备份") : tr("导入 AI 加密备份")} theme={theme} busy={busy} onClose={onClose}>
    <form onSubmit={submit} autoComplete="off">
      <p className={`mb-4 text-xs leading-5 ${theme.textMuted}`}>{exporting ? tr("设置备份密码后选择保存位置。备份包括供应商凭据，丢失密码将无法恢复，请妥善保管。") : tr("输入备份密码后选择文件。先解密并预览新增 / 跳过数量，确认后才导入。")}</p>
      <label htmlFor={`${id}-password`} className="text-xs">{exporting ? tr("备份密码") : tr("解密密码")}</label>
      <input id={`${id}-password`} type="password" autoComplete="off" spellCheck={false} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`} />
      {exporting && <div className="mt-3"><label htmlFor={`${id}-confirm`} className="text-xs">{tr("确认备份密码")}</label><input id={`${id}-confirm`} type="password" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`} /></div>}
      <p className={`mt-2 text-[11px] leading-5 ${theme.textMuted}`}>{tr("密码只用于本次操作，不保存到本软件；文件使用 scrypt + AES-256-GCM 加密。")}</p>
      {(problem || error) && <p role="alert" className="mt-3 break-words text-xs text-red-500">{problem || error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>{tr("取消")}</button><button type="submit" disabled={busy || !password} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{exporting ? tr("选择位置并加密导出") : tr("选择备份并预览")}</button></div>
    </form>
  </AiToolsDialog>;
}

export default function AiPortablePanel({ active = true, onRequest, can, onImported, showToast, theme, recoveryOnly = false }) {
  useLocale();
  const [dialog, setDialog] = useState(null); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [recoveries, setRecoveries] = useState([]); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false); const epoch = useRef(0); const loadTicket = useRef(0);
  const canList = can('portable_recoveries_list');
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const load = useCallback(async () => {
    if (!canList) return;
    const ticket = ++loadTicket.current; const generation = epoch.current; setLoading(true);
    try {
      const result = await onRequest('portable_recoveries_list', {});
      if (!Array.isArray(result?.recoveries) || result.recoveries.length > 20 || result.recoveries.some(row => typeof row?.id !== 'string' || !Number.isFinite(row.createdAt) || !['prepared', 'recovery-required'].includes(row.status))) throw new Error(tr("中断恢复列表格式无效。"));
      if (alive.current && generation === epoch.current && ticket === loadTicket.current) setRecoveries(result.recoveries);
    } catch (failure) { if (alive.current && generation === epoch.current && ticket === loadTicket.current) setError(failure.message); }
    finally { if (alive.current && generation === epoch.current && ticket === loadTicket.current) setLoading(false); }
  }, [onRequest, canList]);
  useEffect(() => {
    alive.current = true;
    if (active) void load();
    return () => { alive.current = false; epoch.current += 1; loadTicket.current += 1; };
  }, [active, load]);
  const openPassword = mode => { if (pending.current) return; setError(''); setNotice(''); setDialog({ kind: mode }); };
  const passwordAction = async secret => {
    if (!active || recoveryOnly || !dialog || pending.current) return;
    const exporting = dialog.kind === 'export';
    if (!can(exporting ? 'portable_export' : 'portable_preview')) return;
    pending.current = true; setBusy(true); setError(''); const generation = epoch.current;
    try {
      const result = await onRequest(exporting ? 'portable_export' : 'portable_preview', { password: secret });
      if (!alive.current || generation !== epoch.current) return;
      if (result?.cancelled) { setDialog(null); setNotice(tr("已取消文件选择，未导出或导入数据。")); return; }
      if (exporting) {
        if (typeof result?.path !== 'string' || !Number.isSafeInteger(result.bytes) || result.bytes <= 0) throw new Error(tr("导出结果格式无效，请检查所选目录，未确认备份成功。"));
        setDialog(null); setNotice(tr("AI 加密备份已导出。请保存密码；本软件不会自动上传此文件。")); showToast?.(tr("AI 加密备份已导出"));
      }
      else { const problem = previewProblem(result, 'import'); if (problem) throw new Error(problem); setDialog({ kind: 'preview', preview: result }); }
    } catch (failure) { if (alive.current && generation === epoch.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const previewRecovery = async backupId => {
    if (!active || pending.current || !can('portable_recovery_preview')) return;
    pending.current = true; setBusy(true); setError(''); setNotice(''); const generation = epoch.current;
    try {
      const result = await onRequest('portable_recovery_preview', { backupId });
      if (!alive.current || generation !== epoch.current) return;
      const problem = previewProblem(result, 'recovery'); if (problem) throw new Error(problem); setDialog({ kind: 'recovery', preview: result });
    } catch (failure) { if (alive.current && generation === epoch.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const apply = async () => {
    if (!active || !dialog?.preview || pending.current) return;
    const recovering = dialog.kind === 'recovery'; const command = recovering ? 'portable_recovery_apply' : 'portable_apply';
    if (!can(command) || recoveryOnly && !recovering) return;
    const problem = previewProblem(dialog.preview, recovering ? 'recovery' : 'import'); if (problem) { setError(problem); return; }
    pending.current = true; setBusy(true); setError(''); const generation = epoch.current;
    try {
      const result = await onRequest(command, { token: dialog.preview.token });
      if (!alive.current || generation !== epoch.current) return;
      const message = recovering ? tr("中断批次已恢复，本机 AI 数据已刷新。") : tr("AI 资源已导入；已有同 ID 记录保留，尚未应用到任何 CLI 配置。");
      setDialog(null); setNotice(result?.warning ? `${message} ${result.warning}` : message); showToast?.(recovering ? tr("AI 中断导入已恢复") : tr("AI 资源已导入"));
      try { await onImported?.(); } catch (failure) { if (alive.current && generation === epoch.current) setError(tr("数据操作已完成，但刷新失败：{0}", { 0: failure.message })); }
      if (alive.current && generation === epoch.current) await load();
    } catch (failure) { if (alive.current && generation === epoch.current) { setDialog(null); setError(tr("{0} 请重新预览后再操作。", { 0: failure.message })); void load(); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const preview = dialog?.preview; const recovering = dialog?.kind === 'recovery';
  return <section aria-label={tr("AI 加密迁移")} className="space-y-3">
    {!recoveryOnly && <div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex items-start gap-3"><LockKeyhole size={21} className="mt-0.5 shrink-0 text-emerald-500" /><div><h3 className="text-sm font-semibold">{tr("AI 资源加密备份与迁移")}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr("仅备份供应商、MCP 和提示词，包含其中保存的凭据。不包含本机路径、工具应用状态、CLI 备份、登录信息或会员数据。")}</p><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr("可以手动保存到自己的同步文件夹；本软件不会自动上传，也不会导入后自动改写其他工具配置。")}</p></div></div>
      <p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>{tr("完整迁移（含 Skills、项目、路由和会话）请使用偏好设置 → 数据迁移。")}</p>
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!active || busy || !can('portable_export')} onClick={() => openPassword('export')} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Download size={14} />{tr("导出加密备份")}</button><button type="button" disabled={!active || busy || !can('portable_preview')} onClick={() => openPassword('import')} className={button}><Upload size={14} />{tr("导入加密备份")}</button></div>
      {notice && <p role="status" className={`mt-3 break-words text-xs leading-5 ${theme.textMuted}`}>{tr(notice)}</p>}{error && !dialog && <p role="alert" className="mt-3 break-words text-xs text-red-500">{tr(error)}</p>}
    </div>}
    {recoveryOnly && notice && <p role="status" className={`text-xs ${theme.textMuted}`}>{tr(notice)}</p>}
    {recoveryOnly && error && !dialog && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
    {canList && <div className={`rounded-xl border p-4 ${theme.card}`}><div className="flex items-center gap-2"><History size={16} className="text-amber-500" /><h3 className="flex-1 text-sm font-semibold">{tr("中断导入恢复")}</h3><button type="button" aria-label={tr("刷新 AI 中断恢复列表")} disabled={!active || loading || busy} onClick={() => { setError(''); void load(); }} className={button}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button></div><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("只处理没有完整结束的本机导入批次。先预览，再恢复；检测到后续修改会停止，不覆盖新数据。")}</p>
      <div className="mt-3 space-y-2">{recoveries.map(row => <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 p-3"><div className="min-w-0 flex-1"><p className="text-xs">{new Date(row.createdAt).toLocaleString(getLocale())} · {row.status === 'prepared' ? tr("上次导入未完整结束") : tr("需要检查恢复")}</p><p className={`mt-1 break-all font-mono text-[10px] ${theme.textMuted}`}>{row.id}</p></div><button type="button" aria-label={tr("预览恢复 AI 导入 {0}", { 0: row.id })} disabled={!active || busy || !can('portable_recovery_preview')} onClick={() => previewRecovery(row.id)} className={button}>{tr("预览恢复")}</button></div>)}{!loading && !recoveries.length && <p className={`text-xs ${theme.textMuted}`}>{tr("没有需要恢复的中断导入。")}</p>}</div>
    </div>}
    {active && !recoveryOnly && ['export', 'import'].includes(dialog?.kind) && <PortablePasswordDialog key={dialog.kind} mode={dialog.kind} busy={busy} error={tr(error)} theme={theme} onClose={() => { setDialog(null); setError(''); }} onSubmit={passwordAction} />}
    {active && preview && (!recoveryOnly || recovering) && <AiToolsDialog title={recovering ? tr("预览 AI 中断恢复") : tr("预览 AI 资源导入")} theme={theme} busy={busy} onClose={() => { setDialog(null); setError(''); }}>
      {recovering ? <p className="text-sm leading-6">{tr("将恢复 {0} 个 AI 数据库；另 {1} 个与导入前一致。", { 0: preview.counts.restore, 1: preview.counts.unchanged })}</p> : <table className="w-full text-left text-xs"><thead className={theme.textMuted}><tr><th className="py-2 font-normal">{tr("资源")}</th><th className="py-2 font-normal">{tr("新增")}</th><th className="py-2 font-normal">{tr("同 ID 跳过")}</th></tr></thead><tbody>{[['providers', tr("供应商")], ['mcpServers', 'MCP'], ['prompts', tr("提示词")]].map(([key, label]) => <tr key={key} className="border-t border-slate-400/15"><th className="py-2 font-medium">{label}</th><td>{preview.counts[key].added}</td><td>{preview.counts[key].skipped}</td></tr>)}</tbody></table>}
      <p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>{recovering ? tr("仅恢复该批次对应的本机 AI 库，不修改 CLI 配置或其他用户文件。") : tr("现有同 ID 记录保持不变；导入的凭据使用本机系统加密重新保存，原值不会显示。")}</p>{(preview.warnings || []).filter(value => typeof value === 'string').map((warning, index) => <p key={index} className="mt-2 text-xs leading-5 text-amber-500">{tr(warning)}</p>)}{error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{tr(error)}</p>}
      <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => { setDialog(null); setError(''); }} className={button}>{tr("取消")}</button><button type="button" disabled={busy || !can(recovering ? 'portable_recovery_apply' : 'portable_apply')} onClick={apply} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{recovering ? tr("确认恢复 AI 数据") : tr("确认合并导入")}</button></div>
    </AiToolsDialog>}
  </section>;
}
