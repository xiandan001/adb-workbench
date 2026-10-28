import { useState } from 'react';
import { ArrowLeftRight, Copy, Download, FolderOpen, History, Save, Trash2 } from 'lucide-react';
import { formatDateTime, tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import { workspaceReportKey } from './AiWorkspaceState';

export function AiWorkspaceReportActions({ view, state, theme }) {
  useLocale();
  const [name, setName] = useState(view.report.name || view.report.preview?.question?.slice(0, 80) || tr('分析报告'));
  const disabled = Boolean(state.reportBusy || Object.values(state.cases).some(value => value.busy));
  const button = `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  return <div className={`space-y-3 rounded-xl border p-4 ${theme.card}`}>
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('只读报告：不恢复旧发送授权。请主动保存需要保留的分析；未保存会话会过期。')}</p>
    {!view.reportRef.historyId && !view.reportRef.casebookId && <div className="flex flex-wrap gap-2"><input aria-label={tr('报告名称')} maxLength={80} value={name} disabled={disabled} onChange={event => setName(event.target.value)} className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs ${theme.input}`} /><button type="button" onClick={() => state.saveReport(name.trim())} disabled={disabled || !name.trim()} className={button}><Save size={14} />{tr('保存本地历史')}</button></div>}
    {view.report.review && <p className="text-xs leading-5">{tr('案例人工记录：{0} · 适用 {1} {2}', { 0: { verified: tr('已人工验证'), rejected: tr('已确认误判'), unverified: tr('待验证') }[view.report.review.status], 1: view.report.review.packageName, 2: view.report.review.version })}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => state.exportReport(true)} disabled={disabled} className={button}><Copy size={14} />{tr('复制报告')}</button>
      <button type="button" onClick={() => state.exportReport(false)} disabled={disabled} className={button}><Download size={14} />{tr('导出 Markdown')}</button>
      <button type="button" onClick={() => state.useContext('followup')} disabled={disabled || Boolean(state.cases.analysis.busy)} className={button}>{tr('继续追问')}</button>
      <button type="button" onClick={() => state.useContext('task')} disabled={disabled || Boolean(state.cases.task.busy)} className={button}>{tr('生成回归草案')}</button>
    </div>
  </div>;
}

export default function AiWorkspaceHistory({ state, theme }) {
  useLocale();
  const [selected, setSelected] = useState('');
  const { current, history, reportError } = state;
  const disabled = Boolean(state.reportBusy || Object.values(state.cases).some(value => value.busy));
  const item = history.find(value => value.id === selected);
  const button = `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  return <section className={`space-y-3 rounded-xl border p-4 ${theme.card}`}>
    <h3 className="flex items-center gap-2 text-sm font-semibold"><History size={16} />{tr('已完成分析与本地历史')}</h3>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('每个工作区保留最近 6 次分析；修改输入不会清除已完成结论。本地历史仅在主动保存时写入。')}</p>
    {current.turns.length > 0 && <div className="max-h-40 space-y-1.5 overflow-auto">{current.turns.map(turn => <button key={turn.id} type="button" onClick={() => state.selectTurn(turn.id)} disabled={disabled} className={`block w-full rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-40 ${current.reportView?.reportRef.turnId === turn.id ? 'border-emerald-500/40 bg-emerald-500/5' : theme.input}`}><span className="block truncate">{turn.preview?.question}</span><span className={`mt-1 block text-[11px] ${theme.textMuted}`}>{formatDateTime(turn.createdAt)}</span></button>)}</div>}
    {current.preview && current.reportView && <button type="button" disabled={disabled} onClick={state.showPreview} className={button}>{tr('返回当前发送预览')}</button>}
    <SelectMenu ariaLabel={tr('选择本地历史')} value={selected} onChange={setSelected} disabled={disabled} isDark={isDarkTheme(theme)} className="w-full" options={[
      { value: '', label: history.length ? tr('选择已保存报告') : tr('尚无已保存报告') },
      ...history.map(report => ({ value: report.id, label: `${report.name} · ${formatDateTime(report.createdAt)}` })),
    ]} />
    <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || !item} onClick={() => state.loadHistory(selected)} className={button}><FolderOpen size={14} />{tr('只读打开')}</button><button type="button" disabled={disabled || !item} onClick={() => state.deleteHistory(selected)} className={button}><Trash2 size={14} />{tr('删除历史')}</button></div>
    {state.reportBusy && <p role="status" className={`text-xs ${theme.textMuted}`}>{tr('正在处理本地报告…')}</p>}
    {reportError && <p role="alert" className="break-words text-xs leading-5 text-red-500">{tr(reportError)}</p>}
  </section>;
}

export function AiWorkspaceComparison({ state, theme }) {
  useLocale();
  const { current } = state;
  if (!current.preview && !current.reportView) return null;
  const currentKey = workspaceReportKey(current.reportView?.reportRef);
  const options = [
    ...Object.values(state.cases).flatMap(value => value.turns.map(turn => ({ value: workspaceReportKey({ caseId: value.caseId, turnId: turn.id }), label: turn.preview?.question?.slice(0, 70) || formatDateTime(turn.createdAt) }))),
    ...state.history.map(report => ({ value: workspaceReportKey({ historyId: report.id }), label: report.name })),
    ...state.casebook.map(report => ({ value: workspaceReportKey({ casebookId: report.id }), label: report.name })),
  ].filter(option => option.value !== currentKey);
  const valid = options.some(option => option.value === current.baseline);
  return <section className={`space-y-3 rounded-xl border p-4 ${theme.card}`}>
    <h3 className="flex items-center gap-2 text-sm font-semibold"><ArrowLeftRight size={16} />{tr('前后对比')}</h3>
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('选择“之前”的基线，与右侧当前证据或报告比较。先生成对比预览，再明确发送。')}</p>
    <SelectMenu ariaLabel={tr('选择对比基线')} value={valid ? current.baseline : ''} onChange={state.setBaseline} disabled={Boolean(current.busy || state.reportBusy)} isDark={isDarkTheme(theme)} className="w-full" options={[{ value: '', label: tr('选择对比基线') }, ...options]} />
    <button type="button" onClick={state.compare} disabled={!valid || Boolean(current.busy || state.reportBusy)} className={`rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{tr('生成对比预览（不调用 AI）')}</button>
  </section>;
}
