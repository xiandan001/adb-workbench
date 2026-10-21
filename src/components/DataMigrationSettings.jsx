import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Download, Loader2, Upload, X } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { collectMigrationPreferences } from '../shared/dataMigrationStorage';

function MigrationSummary({ summary }) {
  if (!summary) return null;
  const createdAt = new Date(summary.createdAt);
  const bytes = Number(summary.bytes || summary.totalBytes || 0);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
      <div><dt className="opacity-65">来源版本</dt><dd className="mt-1 font-medium">{summary.appVersion || '未知'}</dd></div>
      <div><dt className="opacity-65">导出时间</dt><dd className="mt-1">{Number.isNaN(createdAt.getTime()) ? '未知' : createdAt.toLocaleString('zh-CN')}</dd></div>
      <div><dt className="opacity-65">数据大小</dt><dd className="mt-1">{bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`}</dd></div>
      <div><dt className="opacity-65">数据文件</dt><dd className="mt-1">{Number(summary.fileCount || 0).toLocaleString()} 个</dd></div>
      <div><dt className="opacity-65">日志会话</dt><dd className="mt-1">{Number(summary.sessionCount || 0).toLocaleString()} 个</dd></div>
      <div><dt className="opacity-65">偏好项</dt><dd className="mt-1">{Number(summary.preferenceCount || 0).toLocaleString()} 项</dd></div>
    </dl>
  );
}

export default function DataMigrationSettings({ theme, showToast }) {
  const isDark = isDarkTheme(theme);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [recoveryPath, setRecoveryPath] = useState('');
  const [exported, setExported] = useState(null);
  const [preview, setPreview] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const operationRef = useRef(false);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const api = window.electronAPI;
  const available = Boolean(api?.migrationExport && api?.migrationPreview && api?.migrationImport);
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800';
  const button = `inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;

  useEffect(() => {
    let disposed = false;
    if (api?.migrationBootstrap) {
      api.migrationBootstrap().then(result => {
        if (!disposed && result?.ok && ['completed', 'rolled-back', 'failed'].includes(result.status)) {
          setOutcome(result);
        }
      }).catch(() => {});
    }
    return () => { disposed = true; };
  }, [api]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (preview && !dialog?.open) {
      dialog?.showModal();
      cancelRef.current?.focus();
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
    setBusy('');
  }

  function checkResult(result, fallback) {
    if (!result?.ok) {
      setRecoveryPath(result?.recoveryPath || '');
      throw new Error(result?.error || fallback);
    }
    return result;
  }

  async function exportData() {
    if (!beginOperation('export')) return;
    try {
      const result = await api.migrationExport({ preferences: collectMigrationPreferences(window.localStorage) });
      if (result?.cancelled) return;
      checkResult(result, '数据导出失败，请重试');
      setExported(result);
      showToast?.('数据已导出，可将备份文件复制到另一台电脑后导入');
    } catch (failure) { setError(failure.message || '数据导出失败'); }
    finally { endOperation(); }
  }

  async function selectImport() {
    if (!beginOperation('preview')) return;
    try {
      const result = await api.migrationPreview();
      if (result?.cancelled) return;
      checkResult(result, '无法读取备份，请选择本软件导出的备份文件');
      setAcknowledged(false);
      setPreview(result);
    } catch (failure) { setError(failure.message || '无法读取备份文件'); }
    finally { endOperation(); }
  }

  async function importData() {
    if (!acknowledged || !preview?.token || !beginOperation('import')) return;
    let restarting = false;
    try {
      const result = await api.migrationImport({ token: preview.token, confirmed: true, preferences: collectMigrationPreferences(window.localStorage) });
      checkResult(result, '导入未完成，当前数据未替换');
      if (!result.restarting) throw new Error('未能安排重启，请重新选择备份后再试');
      restarting = true;
      setBusy('restarting');
    } catch (failure) {
      setAcknowledged(false);
      setError(failure.message || '数据导入失败');
    } finally {
      if (!restarting) endOperation();
    }
  }

  function closePreview() {
    if (operationRef.current) return;
    setPreview(null); setAcknowledged(false); setError(''); setRecoveryPath('');
  }

  const failureNotice = error && <div role="alert" className="mt-3 text-xs text-red-500"><p>{error}</p>{recoveryPath && <p className="mt-1 break-all">恢复备份：{recoveryPath}</p>}</div>;

  return (
    <div className={isDark ? 'text-[#E8EAED]' : 'text-slate-800'}>
      <div className="flex items-start gap-3">
        <DatabaseBackup size={20} className={`mt-0.5 shrink-0 ${muted}`} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">数据迁移</h3>
          <p className={`mt-1 text-xs leading-relaxed ${muted}`}>换电脑时，先在旧电脑导出备份，再到新电脑导入。所有操作均在本地完成，不自动上传。</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy) || !available} onClick={exportData} className={button}>
          {busy === 'export' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {busy === 'export' ? '正在导出…' : '导出数据'}
        </button>
        <button type="button" disabled={Boolean(busy) || !available} onClick={selectImport} className={button}>
          {busy === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {busy === 'preview' ? '正在校验…' : '导入数据'}
        </button>
      </div>
      <p className={`mt-3 text-xs leading-relaxed ${muted}`}>包含设备名称、连接与终端历史、偏好与主题、任务脚本和记录、日志会话、诊断规则、应用收藏及过滤预设。</p>
      <p className={`mt-1 text-xs leading-relaxed ${muted}`}>不含激活信息、API 凭据、缓存、APK、截图、录屏和报告文件；保留新电脑的保存目录。脚本引用的外部文件需在新电脑重新选择。</p>
      <p className={`mt-2 flex items-start gap-1.5 text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>日志及终端历史可能包含敏感信息。备份文件未加密，请妥善保管，仅向可信设备迁移。</span></p>
      {!available && <p className={`mt-2 text-xs ${muted}`}>数据迁移需在桌面客户端中使用。</p>}
      {exported && <div role="status" className={`mt-3 rounded-lg border p-3 ${isDark ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-emerald-200 bg-emerald-50'}`}>
        <p className="flex items-center gap-1.5 text-sm font-medium"><CheckCircle2 size={15} />备份已导出</p>
        <p className="mt-1 select-text break-all text-xs">{exported.path}</p>
        <div className="mt-3"><MigrationSummary summary={exported.summary} /></div>
      </div>}
      {outcome && <div role="status" className={`mt-3 rounded-lg border p-3 text-xs ${outcome.status === 'completed' ? 'border-emerald-500/30' : 'border-amber-500/40'}`}>
        <p>{outcome.status === 'completed' ? '上次数据迁移已完成。' : outcome.status === 'rolled-back' ? '上次导入未完成，已恢复导入前的数据。' : '上次数据迁移未完成，请保留恢复备份并检查错误信息。'}</p>
        {outcome.error && <p className="mt-1">{outcome.error}</p>}
        {outcome.recoveryPath && <p className="mt-1 break-all">导入前恢复备份：{outcome.recoveryPath}</p>}
      </div>}
      {!preview && failureNotice}
      <dialog ref={dialogRef} aria-labelledby="migration-import-title" aria-describedby="migration-import-description"
        onCancel={event => { if (operationRef.current) event.preventDefault(); else closePreview(); }} onClose={closePreview}
        className={`m-auto max-h-[90vh] w-[min(36rem,94vw)] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="migration-import-title" className="text-lg font-semibold">确认导入数据</h2>
          <button type="button" aria-label="关闭导入确认" disabled={Boolean(busy)} onClick={closePreview} className="rounded p-1 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button>
        </div>
        <p id="migration-import-description" className={`mb-4 text-sm ${muted}`}>备份已校验，确认后将自动备份当前数据，并重启应用使导入生效。</p>
        <div className={`rounded-lg border p-3 ${isDark ? 'border-[#5F6368]' : 'border-slate-200'}`}><MigrationSummary summary={preview?.summary} /></div>
        <div className={`mt-4 rounded-lg p-3 text-xs leading-relaxed ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-800'}`}>
          <p className="font-semibold">请先停止任务并保存日志；重启会结束当前连接。</p>
          <p className="mt-1">备份包含的配置和列表会整体替换本机对应分类，例如脚本库、连接历史和应用收藏；这些分类的原有记录会被覆盖，未包含的分类保留。</p>
          <p className="mt-1">日志会话仅替换相同 ID 的会话，其余会话保留。本机激活信息及保存目录保留，外部文件不会自动迁移。</p>
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm leading-relaxed">
          <input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-emerald-600" />
          <span>我已保存当前工作，同意覆盖上述数据分类并重启。</span>
        </label>
        {failureNotice}
        {busy && <p role="status" className="mt-3 flex items-center gap-2 text-xs"><Loader2 size={14} className="animate-spin" />{busy === 'restarting' ? '导入已准备完成，正在重启…' : '正在准备导入，请勿关闭应用…'}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" disabled={Boolean(busy)} onClick={closePreview} className={button}>取消</button>
          <button type="button" disabled={!acknowledged || Boolean(busy)} onClick={importData} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">导入并重启</button>
        </div>
      </dialog>
    </div>
  );
}
