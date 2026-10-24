import { tr, useLocale, getLocale } from '../shared/i18n';
import { migrationAiRows } from './dataMigrationUi';

export default function DataMigrationSummary({ summary }) {
  useLocale();
  if (!summary) return null;
  const createdAt = new Date(summary.createdAt); const bytes = Number(summary.archiveBytes || summary.bytes || summary.totalBytes || 0);
  const rows = migrationAiRows(summary); const merging = rows.some(row => row.added !== null || row.skipped !== null);
  const show = value => value === null ? '—' : value.toLocaleString(getLocale());
  return <div className="space-y-3"><dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
    <div><dt className="opacity-65">{tr("来源版本")}</dt><dd className="mt-1 font-medium">{summary.appVersion || tr("未知")}</dd></div>
    <div><dt className="opacity-65">{tr("导出时间")}</dt><dd className="mt-1">{Number.isNaN(createdAt.getTime()) ? tr("未知") : createdAt.toLocaleString(getLocale())}</dd></div>
    <div><dt className="opacity-65">{tr("数据大小")}</dt><dd className="mt-1">{bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`}</dd></div>
    <div><dt className="opacity-65">{tr("数据文件")}</dt><dd className="mt-1">{tr("{0} 个", { 0: Number(summary.fileCount || 0).toLocaleString(getLocale()) })}</dd></div>
    <div><dt className="opacity-65">{tr("日志会话")}</dt><dd className="mt-1">{tr("{0} 个", { 0: Number(summary.sessionCount || 0).toLocaleString(getLocale()) })}</dd></div>
    <div><dt className="opacity-65">{tr("偏好项")}</dt><dd className="mt-1">{tr("{0} 项", { 0: Number(summary.preferenceCount || 0).toLocaleString(getLocale()) })}</dd></div>
  </dl><p className="text-xs font-medium">{summary.encrypted === true ? tr("密码加密备份") : tr("旧版未加密备份 · 不包含 AI 工具数据")}</p>
    {rows.length > 0 && <div className="overflow-x-auto"><table aria-label={tr("迁移 AI 数据摘要")} className="w-full text-left text-xs"><thead className="opacity-65"><tr><th className="py-2 font-normal">{tr("AI 数据类别")}</th><th className="py-2 text-right font-normal">{tr("来源数量")}</th>{merging && <><th className="py-2 text-right font-normal">{tr("新增")}</th><th className="py-2 text-right font-normal">{tr("保留 / 跳过")}</th></>}</tr></thead><tbody>{rows.map(row => <tr key={row.key} className="border-t border-slate-400/20"><th className="py-2 font-normal">{row.label}</th>{row.omitted ? <td colSpan={merging ? 3 : 1} className="py-2 text-right opacity-75">{tr("未包含（导出时未选）")}</td> : <><td className="py-2 text-right">{show(row.count)}</td>{merging && <><td className="py-2 text-right">{show(row.added)}</td><td className="py-2 text-right">{show(row.skipped)}</td></>}</>}</tr>)}</tbody></table></div>}
    {summary.encrypted === true && !rows.length && <p className="text-xs opacity-70">{tr("此备份未包含 AI 工具数据。")}</p>}
    {Array.isArray(summary.warnings) && summary.warnings.filter(warning => typeof warning === 'string').map((warning, index) => <p key={index} className="text-xs leading-5 opacity-80">{warning}</p>)}
  </div>;
}
