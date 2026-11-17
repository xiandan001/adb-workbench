import { useState } from 'react';
import { BookCheck, Search } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import { casebookPrefill } from '../shared/aiCasebookPrefill.js';

function ReviewForm({ view, disabled, onSave, theme }) {
  useLocale();
  const [prefill] = useState(() => casebookPrefill(view.report));
  const [review, setReview] = useState(prefill.review);
  const [name, setName] = useState(prefill.name);
  const [tags, setTags] = useState(prefill.review.tags.join(', '));
  const invalidTags = review.tags.length > 8 || review.tags.some(tag => tag.length > 32);
  const input = `w-full rounded-lg border px-3 py-2 text-xs disabled:opacity-50 ${theme.input}`;
  const fields = [{ key: 'solution', label: tr('实际处理方法'), max: 4000 }, { key: 'verification', label: tr('人工验证依据'), max: 2000 }];
  const advanced = [{ key: 'packageName', label: tr('适用包名'), max: 200 }, { key: 'version', label: tr('适用版本'), max: 80 }, { key: 'rootCause', label: tr('实际根因'), max: 2000 }];
  return <details className={`rounded-lg border p-3 ${theme.input}`}>
    <summary className="cursor-pointer text-xs font-medium">{view.reportRef.casebookId ? tr('更新案例验证记录') : tr('将当前报告保存为案例')}</summary>
    <div className="mt-3 space-y-3">
      <label className="block space-y-1"><span className="text-xs">{tr('案例名称')}</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} disabled={disabled || Boolean(view.reportRef.casebookId)} className={input} /></label>
      <div className={`space-y-1 break-words rounded-lg border border-current/10 p-3 text-xs leading-5 ${theme.textMuted}`}>
        <p>{tr('报告设备：{0}', { 0: prefill.provenance.deviceId || tr('未采集') })}</p>
        <p>{tr('适用范围：{0} · {1}', { 0: review.packageName || tr('未填写'), 1: review.version || tr('未采集') })}</p>
        <p>{prefill.provenance.versionSource === 'conflict' ? tr('采集版本存在冲突，未自动填写；请在高级信息中核对。') : prefill.provenance.packageSource === 'collected'
          ? tr('适用信息来自本报告的只读采集快照，不代表实际根因或修复已验证。') : tr('未自动推测缺失的适用信息，可在高级信息中补充。')}</p>
      </div>
      <SelectMenu ariaLabel={tr('人工验证状态')} value={review.status} onChange={status => setReview(value => ({ ...value, status }))} disabled={disabled} isDark={isDarkTheme(theme)} options={[{ value: 'unverified', label: tr('待验证') }, { value: 'verified', label: tr('已人工验证') }, { value: 'rejected', label: tr('已确认误判') }]} className="w-full" />
      {fields.map(field => <label key={field.key} className="block space-y-1"><span className="text-xs">{field.label}</span><textarea value={review[field.key]} onChange={event => setReview(value => ({ ...value, [field.key]: event.target.value }))} rows={field.max > 200 ? 2 : 1} maxLength={field.max} disabled={disabled} className={`${input} resize-y`} /></label>)}
      <details className="rounded-lg border border-current/15 p-3"><summary className="cursor-pointer text-xs font-medium">{tr('高级适用信息（可选）')}</summary><div className="mt-3 space-y-3">
        {advanced.map(field => <label key={field.key} className="block space-y-1"><span className="text-xs">{field.label}</span><textarea value={review[field.key]} onChange={event => setReview(value => ({ ...value, [field.key]: event.target.value }))} rows={field.max > 200 ? 2 : 1} maxLength={field.max} disabled={disabled} className={`${input} resize-y`} /></label>)}
        <label className="block space-y-1"><span className="text-xs">{tr('标签（逗号分隔，最多 8 个）')}</span><input value={tags} onChange={event => { setTags(event.target.value); setReview(value => ({ ...value, tags: event.target.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) })); }} maxLength={260} disabled={disabled} className={input} /></label>
      </div></details>
      {invalidTags && <p className="text-xs text-amber-600">{tr('案例验证信息无效或过长。')}</p>}
      <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('验证状态只由你确认。保存包含独立的脱敏证据快照；不会上传，也不会自动采纳 AI 推测。')}</p>
      <button type="button" disabled={disabled || invalidTags || !name.trim() || (review.status !== 'unverified' && !review.verification.trim())} onClick={() => onSave(name.trim(), review)} className={`rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}>{tr('保存案例记录')}</button>
    </div>
  </details>;
}

export default function AiWorkspaceCasebook({ state, theme }) {
  useLocale();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const disabled = Boolean(state.reportBusy || Object.values(state.cases).some(value => value.busy));
  const view = state.current.reportView;
  const statusLabels = { verified: tr('已人工验证'), rejected: tr('已确认误判'), unverified: tr('待验证') };
  const button = `rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  return <section className={`space-y-3 rounded-xl border p-4 ${theme.card}`}>
    <h3 className="flex items-center gap-2 text-sm font-semibold"><BookCheck size={16} />{tr('本地验证案例库')}</h3>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('最多 50 个案例 / 64 MiB；仅本地检索，不会自动删除旧案例或调用 AI。')}</p>
    <div className="flex gap-2"><input aria-label={tr('案例关键词')} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} disabled={disabled} className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs ${theme.input}`} /><button type="button" disabled={disabled} onClick={() => state.searchCasebook({ query, status })} aria-label={tr('搜索案例')} className={button}><Search size={14} /></button></div>
    <SelectMenu ariaLabel={tr('按验证状态筛选')} value={status} onChange={setStatus} disabled={disabled} isDark={isDarkTheme(theme)} options={[{ value: '', label: tr('全部验证状态') }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} className="w-full" />
    {view && <button type="button" onClick={state.similarCases} disabled={disabled} className={button}>{tr('查找当前报告的相似案例')}</button>}
    <div className="max-h-64 space-y-2 overflow-auto">{state.casebook.map(item => <article key={item.id} className={`space-y-2 rounded-lg border p-3 ${theme.input}`}>
      <p className="break-words text-xs font-medium">{item.name}</p><p className={`break-words text-[11px] ${theme.textMuted}`}>{statusLabels[item.status]} · {item.packageName} {item.version}</p>
      {item.matchTerms?.length > 0 && <p className={`break-words text-[11px] ${theme.textMuted}`}>{tr('本地文字匹配：{0}（不是根因置信度）', { 0: item.matchTerms.join(', ') })}</p>}
      <div className="flex gap-2"><button type="button" disabled={disabled} onClick={() => state.loadCase(item.id)} className={button}>{tr('只读打开')}</button><button type="button" disabled={disabled} onClick={() => state.deleteCase(item.id)} className={button}>{tr('删除案例')}</button></div>
    </article>)}</div>
    {!state.casebook.length && <p className={`text-xs ${theme.textMuted}`}>{tr('没有匹配的本地案例。')}</p>}
    {view && <ReviewForm key={`${view.report.id}:${view.report.revision || 0}`} view={view} disabled={disabled} onSave={state.saveCase} theme={theme} />}
  </section>;
}
