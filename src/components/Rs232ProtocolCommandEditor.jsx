import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { protocolCommandDraftChanged } from '../shared/rs232ProtocolDraft.js';

export default function Rs232ProtocolCommandEditor({ initial, theme, onSave, onCancel, onDirtyChange, onSavingChange }) {
  useLocale();
  const [draft, setDraft] = useState(initial), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const field = `w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const change = (key, value) => {
    if (lock.current) return;
    const next = { ...draft, [key]: value, ...(key === 'template' && value !== draft.template ? { reviewed: false } : {}) };
    setDraft(next); setError(''); onDirtyChange?.(protocolCommandDraftChanged(initial, next));
  };
  const save = async () => {
    if (lock.current) return; lock.current = true; setSaving(true); setError(''); onSavingChange?.(true);
    try { if (!draft.name.trim() || !draft.category.trim() || !draft.template.trim()) throw Error(tr('请填写命令名称、分类和帧模板。')); await onSave(draft); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; if (alive.current) setSaving(false); onSavingChange?.(false); }
  };
  return <section className="min-w-0 space-y-4" aria-label={tr('编辑协议命令')}>
    <div><h3 className="text-base font-semibold">{tr('编辑协议命令')}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('只保存本机命令配置，不会连接或发送。修改内置命令不会覆盖原始协议。')}</p></div>
    <label className="block space-y-1 text-xs"><span>{tr('命令名称')}</span><input autoFocus disabled={saving} value={draft.name} maxLength={80} onChange={event => change('name', event.target.value)} className={field} /></label>
    <label className="block space-y-1 text-xs"><span>{tr('命令分类')}</span><input disabled={saving} value={draft.category} maxLength={40} onChange={event => change('category', event.target.value)} className={field} /></label>
    <label className="block space-y-1 text-xs"><span>{tr('HEX 帧模板')}</span><textarea disabled={saving} value={draft.template} maxLength={8192} rows={4} spellCheck={false} onChange={event => change('template', event.target.value)} className={`${field} max-h-48 resize-y font-mono text-xs`} /></label>
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('固定字节使用两位 HEX，字节参数使用 {XX} 等占位符。只有明确写出的 LL 会按数据长度计算；不会修正写死的长度或追加校验。')}</p>
    <label className="block space-y-1 text-xs"><span>{tr('命令备注')}</span><textarea disabled={saving} value={draft.note} maxLength={2000} rows={2} onChange={event => change('note', event.target.value)} className={`${field} max-h-40 resize-y`} /></label>
    <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" disabled={saving} checked={draft.reviewed} onChange={event => change('reviewed', event.target.checked)} className="mt-1 accent-emerald-500" /><span>{tr('我已核对模板。此标记只代表人工确认，不代表设备已验证。')}</span></label>
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={onCancel} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr('取消编辑')}</button><button type="button" disabled={saving} onClick={save} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Save size={15} />{saving ? tr('正在保存…') : tr('保存命令')}</button></div>
  </section>;
}
