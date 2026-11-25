import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { createProtocolCommandDraft, prepareProtocolCommandDraft, protocolCommandDraftChanged, protocolParameterEditorModel, updateProtocolParameterDraft } from '../shared/rs232ProtocolDraft.js';
import Rs232ProtocolParametersEditor from './Rs232ProtocolParametersEditor.jsx';
import SelectMenu from './SelectMenu.jsx';

export default function Rs232ProtocolCommandEditor({ initial, protocol, theme, isDark, categoryOptions = [], onSave, onCancel, onDirtyChange, onSavingChange }) {
  useLocale();
  const [original] = useState(() => createProtocolCommandDraft(initial));
  const [draft, setDraft] = useState(original), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false), [categoryName, setCategoryName] = useState(''), [draftCategories, setDraftCategories] = useState([]);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const field = `block w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const fieldGroup = 'grid min-w-0 gap-2';
  const labelClass = 'text-sm font-medium leading-5';
  const title = initial.name ? tr('编辑协议命令') : tr('新增协议命令');
  const categories = [...new Set([...categoryOptions.map(item => item.value), ...draftCategories, draft.category].filter(Boolean))].map(value => categoryOptions.find(item => item.value === value) || { value, label: value });
  const tcl = protocol === 'tcl' || /^AA(?:\s|$)/i.test(draft.template.trimStart()) || /^TCL\b/i.test(draft.category.trim());
  const parameterModel = useMemo(() => protocolParameterEditorModel(draft), [draft]);
  const update = next => {
    setDraft(next); setError(''); onDirtyChange?.(protocolCommandDraftChanged(original, next) || addingCategory && Boolean(categoryName));
  };
  const change = (key, value) => {
    if (lock.current) return;
    const next = { ...draft, [key]: value, ...(key === 'template' && value !== draft.template ? { reviewed: false } : {}) };
    update(next);
  };
  const changeParameter = (key, parameter) => {
    const base = parameterModel.defaults.find(item => item.key === key && item.type === 'byte');
    if (!lock.current && base) update(updateProtocolParameterDraft(draft, base, parameter));
  };
  const cancelCategory = () => { if (lock.current) return; setAddingCategory(false); setCategoryName(''); setError(''); onDirtyChange?.(protocolCommandDraftChanged(original, draft)); };
  const addCategory = () => {
    if (lock.current) return;
    if (!categoryName.trim() || categoryName.length > 40 || [...categoryName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { setError(tr('分类名称不能为空，最多 40 个字符，且不能包含控制字符。')); return; }
    const next = { ...draft, category: categoryName };
    setDraft(next); if (!categories.some(item => item.value === categoryName)) setDraftCategories(previous => [...previous, categoryName]);
    setAddingCategory(false); setCategoryName(''); setError(''); onDirtyChange?.(protocolCommandDraftChanged(original, next));
  };
  const save = async () => {
    if (lock.current || addingCategory) return; lock.current = true; setSaving(true); setError(''); onSavingChange?.(true);
    try { if (!draft.name.trim() || !draft.category.trim() || !draft.template.trim()) throw Error(tr('请填写命令名称、分类和帧模板。')); await onSave(prepareProtocolCommandDraft(draft)); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; if (alive.current) setSaving(false); onSavingChange?.(false); }
  };
  return <section className="min-w-0 space-y-5" aria-label={title}>
    <div><h3 className="text-base font-semibold">{title}</h3><p className={`mt-1.5 text-xs leading-5 ${theme.textMuted}`}>{tr('只保存本机命令配置，不会连接或发送。修改内置命令不会覆盖原始协议。')}</p></div>
    <label className={fieldGroup}><span className={labelClass}>{tr('命令名称')}</span><input autoFocus disabled={saving} value={draft.name} maxLength={80} onChange={event => change('name', event.target.value)} className={field} /></label>
    <div className={fieldGroup}><span className={labelClass}>{tr('命令分类')}</span><div className="flex flex-wrap items-center gap-2"><SelectMenu ariaLabel={tr('命令分类')} value={draft.category} options={categories} isDark={isDark} disabled={saving || addingCategory} onChange={value => change('category', value)} className="min-w-0 flex-1 basis-40" /><button type="button" disabled={saving || addingCategory} onClick={() => { if (!lock.current) { setAddingCategory(true); setError(''); } }} className={`inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}><Plus size={13} aria-hidden="true" />{tr('新增分类')}</button></div>
      {addingCategory && <div className="space-y-2 rounded-lg border border-slate-400/20 p-2 text-xs"><div className="flex flex-wrap gap-2"><input autoFocus aria-label={tr('新分类名称')} disabled={saving} value={categoryName} maxLength={40} onChange={event => { if (lock.current) return; const value = event.target.value; setCategoryName(value); setError(''); onDirtyChange?.(protocolCommandDraftChanged(original, draft) || Boolean(value)); }} onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); addCategory(); } }} className={`${field} flex-1 basis-40`} /><button type="button" disabled={saving} onClick={addCategory} className={`rounded-lg px-3 py-2 ${theme.button.secondary}`}>{tr('确认分类')}</button><button type="button" disabled={saving} aria-label={tr('取消新增分类')} onClick={cancelCategory} className={`rounded-lg p-2 ${theme.button.secondary}`}><X size={14} /></button></div><p className={`leading-5 ${theme.textMuted}`}>{tr('新分类会随这条命令一起保存；取消编辑不会新增分类。')}</p></div>}
    </div>
    <div className="space-y-2"><label className={fieldGroup}><span className={labelClass}>{tr('HEX 帧模板')}</span><textarea disabled={saving} value={draft.template} maxLength={8192} rows={3} spellCheck={false} onChange={event => change('template', event.target.value)} className={`${field} max-h-48 resize-y font-mono text-xs`} /></label>
      <p className={`text-xs leading-5 ${theme.textMuted}`}>{tcl
        ? tr('TCL 模板以 AA 开头。LL 自动计算短帧长度；长帧用 FE LH LL。CRC1 CRC2 自动生成校验。')
        : tr('固定字节使用两位 HEX，字节参数使用 {XX} 等占位符。只有明确写出的 LL 会按数据长度计算；不会修正写死的长度或追加校验。')}</p>
    </div>
    {parameterModel.valid ? <Rs232ProtocolParametersEditor parameters={parameterModel.parameters} theme={theme} disabled={saving} onChange={changeParameter} />
      : <p role="status" className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-500">{tr('帧模板有误，修正后可配置参数选项。')}</p>}
    <label className={fieldGroup}><span className={labelClass}>{tr('命令备注')}</span><textarea disabled={saving} value={draft.note} maxLength={2000} rows={2} onChange={event => change('note', event.target.value)} className={`${field} max-h-40 resize-y`} /></label>
    <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" disabled={saving} checked={draft.reviewed} onChange={event => change('reviewed', event.target.checked)} className="mt-1 accent-emerald-500" /><span>{tr('我已核对模板和参数。此标记只代表人工确认，不代表设备已验证。')}</span></label>
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={onCancel} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr('取消编辑')}</button><button type="button" disabled={saving || addingCategory} onClick={save} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Save size={15} />{saving ? tr('正在保存…') : tr('保存命令')}</button></div>
  </section>;
}
