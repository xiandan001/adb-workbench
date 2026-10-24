import { tr, useLocale } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Download, Loader2, Upload, X } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { collectMigrationPreferences } from '../shared/dataMigrationStorage';
import MigrationSummary from './DataMigrationSummary';
import DataMigrationPasswordDialog from './DataMigrationPasswordDialog';
import { readMigrationPreview } from './dataMigrationUi';

export default function DataMigrationSettings({ theme, showToast }) {
  useLocale();
  const isDark = isDarkTheme(theme);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [recoveryPath, setRecoveryPath] = useState('');
  const [exported, setExported] = useState(null);
  const [preview, setPreview] = useState(null);
  const [passwordPrompt, setPasswordPrompt] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const operationRef = useRef(false);
  const alive = useRef(true);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const api = window.electronAPI;
  const available = Boolean(api?.migrationExport && api?.migrationPreview && api?.migrationImport);
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800';
  const button = `inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    if (api?.migrationBootstrap) {
      api.migrationBootstrap().then(result => {
        if (!disposed && result?.ok && ['completed', 'rolled-back', 'failed'].includes(result.status)) {
          setOutcome(result);
        }
      }).catch(() => {});
    }
    return () => { disposed = true; alive.current = false; };
  }, [api]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (preview && !dialog?.open) {
      dialog?.showModal();
      closeRef.current?.focus({ preventScroll: true });
      if (dialog) dialog.scrollTop = 0;
    }
    if (!preview && dialog?.open) dialog.close();
  }, [preview]);

  function beginOperation(stage) {
    if (operationRef.current) return false;
    operationRef.current = true;
    setBusy(stage); setError(''); setRecoveryPath('');
    return true;
  }

  function endOperation() {
    operationRef.current = false;
    if (alive.current) setBusy('');
  }

  function checkResult(result, fallback) {
    if (!result?.ok) {
      if (alive.current) setRecoveryPath(result?.recoveryPath || '');
      throw new Error(result?.error || fallback);
    }
    return result;
  }

  async function exportData({ password, includeAiSessions }) {
    if (!beginOperation('export')) return;
    try {
      const result = await api.migrationExport({ preferences: collectMigrationPreferences(window.localStorage), password, includeAiSessions });
      if (!alive.current) return;
      if (result?.cancelled) { setPasswordPrompt(null); return; }
      checkResult(result, tr("数据导出失败，请重试"));
      setPasswordPrompt(null);
      setExported(result);
      showToast?.(tr("加密备份已导出，请分别保管备份文件和密码"));
    } catch (failure) { if (alive.current) setError(failure.message || tr("数据导出失败")); }
    finally { endOperation(); }
  }

  function acceptPreview(result) {
    const next = readMigrationPreview(result);
    setAcknowledged(false); setPreview(null);
    if (next.kind === 'password') setPasswordPrompt({ mode: 'import', selectionToken: next.selectionToken, fileName: next.fileName });
    else { setPasswordPrompt(null); setPreview(next.value); }
  }

  async function selectImport() {
    if (!beginOperation('preview')) return;
    setPreview(null); setPasswordPrompt(null); setAcknowledged(false);
    try {
      const result = await api.migrationPreview({});
      if (!alive.current) return;
      if (result?.cancelled) return;
      checkResult(result, tr("无法读取备份，请选择本软件导出的备份文件"));
      acceptPreview(result);
    } catch (failure) { if (alive.current) setError(failure.message || tr("无法读取备份文件")); }
    finally { endOperation(); }
  }

  async function decryptImport({ password }) {
    if (!passwordPrompt?.selectionToken || !beginOperation('decrypt')) return;
    try {
      const result = await api.migrationPreview({ selectionToken: passwordPrompt.selectionToken, password });
      if (!alive.current) return;
      checkResult(result, tr("无法解密备份，请检查密码后重试"));
      acceptPreview(result);
    } catch (failure) { if (alive.current) { setPreview(null); setAcknowledged(false); setError(failure.message || tr("备份解密失败")); } }
    finally { endOperation(); }
  }

  async function importData() {
    if (!acknowledged || !preview?.token || !beginOperation('import')) return;
    let restarting = false;
    try {
      const result = await api.migrationImport({ token: preview.token, confirmed: true, preferences: collectMigrationPreferences(window.localStorage) });
      if (!alive.current) return;
      checkResult(result, tr("导入未完成，当前数据未替换"));
      if (!result.restarting) throw new Error(tr("未能安排重启，请重新选择备份后再试"));
      restarting = true;
      setBusy('restarting');
    } catch (failure) {
      if (alive.current) { setAcknowledged(false); setError(failure.message || tr("数据导入失败")); }
    } finally {
      if (!restarting) endOperation();
    }
  }

  function closePreview() {
    if (operationRef.current) return;
    setPreview(null); setAcknowledged(false); setError(''); setRecoveryPath('');
  }

  const failureNotice = error && <div role="alert" className="mt-3 text-xs text-red-500"><p>{tr(error)}</p>{recoveryPath && <p className="mt-1 break-all">{tr("恢复备份：{0}", { 0: recoveryPath })}</p>}</div>;

  return (
    <section aria-label={tr("统一数据迁移")} className={isDark ? 'text-[#E8EAED]' : 'text-slate-800'}>
      <div className="flex items-start gap-3">
        <DatabaseBackup size={20} className={`mt-0.5 shrink-0 ${muted}`} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{tr("数据迁移")}</h3>
          <p className={`mt-1 text-xs leading-relaxed ${muted}`}>{tr("换电脑时，先在旧电脑导出备份，再到新电脑导入。所有操作均在本地完成，不自动上传。")}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy) || !available} onClick={() => { setError(''); setRecoveryPath(''); setPasswordPrompt({ mode: 'export' }); }} className={button}>
          {busy === 'export' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {busy === 'export' ? tr("正在导出…") : tr("导出数据")}
        </button>
        <button type="button" disabled={Boolean(busy) || !available} onClick={selectImport} className={button}>
          {busy === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {busy === 'preview' ? tr("正在校验…") : tr("导入数据")}
        </button>
      </div>
      <p className={`mt-3 text-xs leading-relaxed ${muted}`}>{tr("包含设备名称、连接与终端历史、偏好与主题、任务脚本和记录、日志会话、诊断规则、应用收藏及过滤预设。")}</p>
      <p className={`mt-1 text-xs leading-relaxed ${muted}`}>{tr("同时包含 AI 供应商与已保存凭据、MCP、提示词、Skills 技能库、项目入口及路由定义；AI 会话历史默认包含，导出时可取消。")}</p>
      <p className={`mt-1 text-xs leading-relaxed ${muted}`}>{tr("不含会员激活、OAuth 登录、工具应用状态、CLI 配置恢复备份、缓存或外部项目、APK、截图和录屏文件；保留新电脑的保存目录。")}</p>
      <p className={`mt-2 flex items-start gap-1.5 text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{tr("新备份使用密码加密，可能包含密钥及敏感历史，请分别保管备份与密码。仍可导入旧版未加密备份，但旧备份不含 AI 数据。")}</span></p>
      {!available && <p className={`mt-2 text-xs ${muted}`}>{tr("数据迁移需在桌面客户端中使用。")}</p>}
      {exported && <div role="status" className={`mt-3 rounded-lg border p-3 ${isDark ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-emerald-200 bg-emerald-50'}`}>
        <p className="flex items-center gap-1.5 text-sm font-medium"><CheckCircle2 size={15} />{tr("备份已导出")}</p>
        <p className="mt-1 select-text break-all text-xs">{exported.path}</p>
        <div className="mt-3"><MigrationSummary summary={exported.summary} /></div>
      </div>}
      {outcome && <div role="status" className={`mt-3 rounded-lg border p-3 text-xs ${outcome.status === 'completed' ? 'border-emerald-500/30' : 'border-amber-500/40'}`}>
        <p>{outcome.status === 'completed' ? tr("上次数据迁移已完成。") : outcome.status === 'rolled-back' ? tr("上次导入未完成，已恢复导入前的数据。") : tr("上次数据迁移未完成，请保留恢复备份并检查错误信息。")}</p>
        {outcome.error && <p className="mt-1">{tr(outcome.error)}</p>}
        {outcome.recoveryPath && <p className="mt-1 break-all">{tr("导入前恢复备份：{0}", { 0: outcome.recoveryPath })}</p>}
      </div>}
      {!preview && !passwordPrompt && failureNotice}
      {passwordPrompt && <DataMigrationPasswordDialog key={`${passwordPrompt.mode}:${passwordPrompt.selectionToken || ''}`} mode={passwordPrompt.mode} fileName={passwordPrompt.fileName} busy={Boolean(busy)} error={error} isDark={isDark} onClose={() => { if (!operationRef.current) { setPasswordPrompt(null); setError(''); setRecoveryPath(''); } }} onSubmit={passwordPrompt.mode === 'export' ? exportData : decryptImport} />}
      <dialog ref={dialogRef} aria-labelledby="migration-import-title" aria-describedby="migration-import-description"
        onCancel={event => { if (operationRef.current) event.preventDefault(); else closePreview(); }} onClose={closePreview}
        className={`m-auto max-h-[90vh] w-[min(36rem,94vw)] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="migration-import-title" className="text-lg font-semibold">{tr("确认导入数据")}</h2>
          <button ref={closeRef} type="button" aria-label={tr("关闭导入确认")} disabled={Boolean(busy)} onClick={closePreview} className="rounded p-1 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button>
        </div>
        <p id="migration-import-description" className={`mb-4 text-sm ${muted}`}>{tr("备份已校验，确认后将自动备份当前数据，并重启应用使导入生效。")}</p>
        <div className={`rounded-lg border p-3 ${isDark ? 'border-[#5F6368]' : 'border-slate-200'}`}><MigrationSummary summary={preview?.summary} /></div>
        <div className={`mt-4 rounded-lg p-3 text-xs leading-relaxed ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-800'}`}>
          <p className="font-semibold">{tr("请先停止任务并保存日志；重启会结束当前连接。")}</p>
          <p className="mt-1">{tr("备份包含的配置和列表会整体替换本机对应分类，例如脚本库、连接历史和应用收藏；这些分类的原有记录会被覆盖，未包含的分类保留。")}</p>
          <p className="mt-1">{tr("日志会话仅替换相同 ID 的会话，其余会话保留。本机激活信息及保存目录保留，外部文件不会自动迁移。")}</p>
          {preview?.summary?.encrypted === true && preview.summary.ai && <><p className="mt-2 font-semibold">{tr("AI 数据采用合并：同 ID 保留本机记录，不覆盖。")}</p><p className="mt-1">{tr("Skills 仅进入库、不安装；路由不启动；项目来源路径仅供参考，必须重新选择本机目录；AI 会话仅作为只读归档，不写回 CLI 会话目录。")}</p></>}
          {preview?.summary?.encrypted !== true && <p className="mt-2 font-semibold">{tr("此为旧版未加密备份，不包含 AI 工具数据。请仅导入可信来源文件。")}</p>}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm leading-relaxed">
          <input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-emerald-600" />
          <span>{tr("我已保存当前工作，同意按上述替换与合并规则导入并重启。")}</span>
        </label>
        {failureNotice}
        {busy && <p role="status" className="mt-3 flex items-center gap-2 text-xs"><Loader2 size={14} className="animate-spin" />{busy === 'restarting' ? tr("导入已准备完成，正在重启…") : tr("正在准备导入，请勿关闭应用…")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={closePreview} className={button}>{tr("取消")}</button>
          <button type="button" disabled={!acknowledged || Boolean(busy)} onClick={importData} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{tr("导入并重启")}</button>
        </div>
      </dialog>
    </section>
  );
}
