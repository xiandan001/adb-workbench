import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Code2, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { getLocale, tr, useLocale } from '../shared/i18n.js';
import { trapAppMessageFocus, confirmAppMessage } from '../shared/appMessageDialog.js';
import { listProtocolCommands, getProtocolParameters, buildProtocolCommand, getProtocolDisplayName, getProtocolCategoryLabel } from '../shared/rs232Protocol.js';
import { defaultProtocolPreferences, readProtocolPreferences, saveProtocolPreferences, upsertProtocolCommand, removeProtocolCommand, restoreProtocolCommand } from '../shared/rs232ProtocolPreferences.js';
import SelectMenu from './SelectMenu.jsx';
import Rs232ProtocolCommandEditor from './Rs232ProtocolCommandEditor.jsx';
import useRs232ProtocolMemory from '../shared/useRs232ProtocolMemory.js';
import { clearRs232ScopeMemory, forgetProtocolParameters, rememberProtocolSelection, restoreProtocolSelection, restoreProtocolValues } from '../shared/rs232ProtocolMemory.js';

export default function Rs232ProtocolPanel({ theme, isDark, onClose, onUse, memoryScope = { workspace: 'rs232', schemeId: '' } }) {
  const locale = useLocale(), dialog = useRef(null), lock = useRef(false), alive = useRef(true), returnFocus = useRef(true);
  const dirtyRef = useRef(false), editorSavingRef = useRef(false), wasEditing = useRef(false);
  const focusNonce = useRef(0), pendingFocus = useRef(0);
  const [boot] = useState(() => { try { return { preferences: readProtocolPreferences(), error: '' }; } catch (failure) { return { preferences: defaultProtocolPreferences(), error: failure.message }; } });
  const [preferences, setPreferences] = useState(boot.preferences), [error, setError] = useState(''), [persistenceError, setPersistenceError] = useState(boot.error);
  const memory = useRs232ProtocolMemory();
  const [restored] = useState(() => restoreProtocolSelection(memory.value, memoryScope, listProtocolCommands(boot.preferences)));
  const [query, setQuery] = useState(''), [category, setCategory] = useState(restored.category), [selectedId, setSelectedId] = useState(restored.selectedId), [values, setValues] = useState(restored.values);
  const [editor, setEditor] = useState(null), [using, setUsing] = useState(false), [showRemoved, setShowRemoved] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false), [editorSaving, setEditorSaving] = useState(false), [confirming, setConfirming] = useState(false);
  const busy = using || editorSaving || confirming;
  const commands = useMemo(() => listProtocolCommands(preferences), [preferences]);
  const originals = useMemo(() => new Map(listProtocolCommands(defaultProtocolPreferences()).map(command => [command.id, command])), []);
  const selected = commands.find(command => command.id === selectedId) || null;
  const parameterState = useMemo(() => {
    void locale;
    try { return { items: selected && !selected.referenceOnly ? getProtocolParameters(selected) : [], error: '' }; }
    catch (failure) { return { items: [], error: failure.message }; }
  }, [selected, locale]);
  const parameters = parameterState.items;
  const preview = useMemo(() => {
    void locale;
    if (!selected) return { frame: null, error: '' };
    if (parameterState.error) return { frame: null, error: parameterState.error };
    try { return { frame: buildProtocolCommand(selected, values), error: '' }; } catch (failure) { return { frame: null, error: failure.message }; }
  }, [selected, values, parameterState.error, locale]);
  const categories = [...new Set(commands.map(command => command.category))];
  const categoryLabel = value => getProtocolCategoryLabel(value, locale);
  const filtered = commands.filter(command => (!category || command.category === category) &&
    [command.name, getProtocolDisplayName(command, locale), command.category, command.template].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const field = `min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const cancelPanelFocus = useCallback(() => { focusNonce.current++; pendingFocus.current = 0; }, []);
  const requestPanelFocus = useCallback(() => { pendingFocus.current = ++focusNonce.current; }, []);
  useEffect(() => { alive.current = true; const node = dialog.current, previous = document.activeElement; node.showModal(); return () => { alive.current = false; node.close(); if (returnFocus.current && previous?.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  useEffect(() => {
    const previous = wasEditing.current; wasEditing.current = Boolean(editor);
    if (previous && !editor) requestPanelFocus();
    if (editor || confirming || !pendingFocus.current) return;
    const nonce = pendingFocus.current, panel = dialog.current;
    const frame = requestAnimationFrame(() => {
      if (!alive.current || !panel.open || pendingFocus.current !== nonce || focusNonce.current !== nonce) return;
      if (!panel.contains((panel.ownerDocument || document).activeElement)) {
        const target = panel.querySelector('[data-protocol-command-title]') || panel.querySelector('input[aria-label]');
        if (target?.getClientRects().length) { target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }
      }
      pendingFocus.current = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [preferences, selectedId, editor, confirming, requestPanelFocus]);
  const dirty = useCallback(value => { dirtyRef.current = value; setEditorDirty(value); }, []);
  const saving = useCallback(value => { editorSavingRef.current = value; setEditorSaving(value); }, []);
  const clearEditor = () => { dirty(false); setEditor(null); };
  const mayLeaveEditor = async () => {
    if (lock.current || editorSavingRef.current || !alive.current) return false;
    if (!dirtyRef.current) return true;
    lock.current = true; setConfirming(true);
    try { return await confirmAppMessage({ type: 'warning', title: tr('放弃未保存的命令修改？'), message: tr('这些修改尚未保存。放弃后无法恢复，不会发送任何数据。'), confirmLabel: tr('放弃修改'), cancelLabel: tr('继续编辑') }); }
    finally { lock.current = false; if (alive.current) setConfirming(false); }
  };
  const close = async () => { if (await mayLeaveEditor() && alive.current) { cancelPanelFocus(); returnFocus.current = true; onClose(); } };
  const cancelEditor = async () => { if (await mayLeaveEditor() && alive.current) clearEditor(); };
  const commit = value => {
    try { const saved = saveProtocolPreferences(value); setPreferences(saved); setError(''); setPersistenceError(''); return saved; }
    catch (failure) { setPersistenceError(failure.message); throw failure; }
  };
  const remember = (command, nextValues = values, nextCategory = category) => memory.update(current => rememberProtocolSelection(current, memoryScope, { selectedId: command?.id || '', category: nextCategory, command, values: nextValues }));
  const changeValues = (key, value) => { const next = { ...values, [key]: value }; setValues(next); remember(selected, next); };
  const changeCategory = value => { setCategory(value); remember(selected, values, value); };
  const resetMemory = async () => {
    if (lock.current || editorSavingRef.current) return;
    lock.current = true; setConfirming(true);
    try {
      if (!await confirmAppMessage({ type: 'warning', title: tr('清除当前方案的操作记忆？'), message: tr('只清除当前工作区和连接方案的功能选择及参数记忆，不删除协议命令，也不会发送。'), confirmLabel: tr('清除记忆') }) || !alive.current) return;
      if (memory.update(current => clearRs232ScopeMemory(current, memoryScope))) { const next = restoreProtocolSelection({ version: 1, scopes: [] }, memoryScope, commands); setSelectedId(next.selectedId); setCategory(next.category); setValues(next.values); }
    } finally { lock.current = false; if (alive.current) setConfirming(false); }
  };
  const select = async command => { if (selectedId === command.id && !editor || !await mayLeaveEditor() || !alive.current) return; const next = restoreProtocolValues(memory.value, memoryScope, command); setSelectedId(command.id); setValues(next); remember(command, next); clearEditor(); setError(''); };
  const edit = async command => { if (!await mayLeaveEditor() || !alive.current) return; dirty(false); setEditor({ id: command.id, name: command.name, category: command.category, template: command.template, note: command.note || '', reviewed: command.reviewed === true }); };
  const add = async () => { if (!await mayLeaveEditor() || !alive.current) return; dirty(false); setEditor({ id: 'custom-' + crypto.randomUUID(), name: '', category: category || tr('自定义命令'), template: '', note: '', reviewed: false }); };
  const save = draft => { if (lock.current || !alive.current) throw Error(tr('请先完成当前操作。')); const saved = commit(upsertProtocolCommand(preferences, draft)); memory.update(current => rememberProtocolSelection(forgetProtocolParameters(current, memoryScope, draft.id), memoryScope, { selectedId: draft.id, category, command: draft, values: {} })); setSelectedId(draft.id); setValues({}); clearEditor(); return saved; };
  const remove = async () => {
    if (!selected || lock.current || editorSavingRef.current) return; lock.current = true; setConfirming(true);
    try { if (await confirmAppMessage({ type: 'warning', title: tr('删除协议命令'), message: tr('删除“{0}”？此操作不会发送数据或改变串口连接。', { 0: getProtocolDisplayName(selected, locale) }), detail: tr('内置命令可恢复原样，自定义命令删除后将移除本机配置。'), confirmLabel: tr('删除命令') }) && alive.current) { commit(removeProtocolCommand(preferences, selected.id)); memory.update(current => forgetProtocolParameters(current, memoryScope, selected.id)); setSelectedId(''); setValues({}); requestPanelFocus(); } }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; if (alive.current) setConfirming(false); }
  };
  const restore = async id => {
    if (lock.current || editorSavingRef.current) return; lock.current = true; setConfirming(true);
    try { if (await confirmAppMessage({ type: 'warning', title: tr('恢复内置命令'), message: tr('恢复这条内置命令的原始配置？本机修改将被替换，不会发送。'), confirmLabel: tr('恢复内置原样') }) && alive.current) { commit(restoreProtocolCommand(preferences, id)); memory.update(current => forgetProtocolParameters(current, memoryScope, id)); setSelectedId(id); setValues({}); setShowRemoved(false); requestPanelFocus(); } }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; if (alive.current) setConfirming(false); }
  };
  const use = async () => {
    if (!selected || !preview.frame || lock.current || editorSavingRef.current || !alive.current) return; cancelPanelFocus(); lock.current = true; setUsing(true); setError(''); returnFocus.current = false;
    try { if (await onUse(preview.frame, getProtocolDisplayName(selected, getLocale())) !== true && alive.current) { returnFocus.current = true; setError(tr('未能更新发送区，请检查配置保存提示；尚未发送。')); } }
    catch (failure) { if (alive.current) { returnFocus.current = true; setError(failure.message); } }
    finally { lock.current = false; if (alive.current) setUsing(false); }
  };
  return <dialog ref={dialog} aria-labelledby="rs232-protocol-title" onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); void close(); }}
    className={`m-auto max-h-[90vh] w-[min(70rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl open:flex backdrop:bg-black/60 ${theme.card} ${theme.text}`}>
    <header className="flex shrink-0 items-start gap-3 border-b border-slate-400/20 px-5 py-4"><span className="rounded-xl bg-emerald-500/10 p-2.5 text-emerald-500"><Code2 size={22} /></span><div className="min-w-0 flex-1"><h2 id="rs232-protocol-title" className="text-base font-semibold">{tr('RS232 协议面板')}</h2>{editorDirty && <p className="mt-1 text-xs text-amber-500">{tr('有未保存更改')}</p>}<p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('选择功能、填写参数、生成 HEX。填入发送区后仍需手动发送。')}</p></div><button type="button" disabled={busy} onClick={close} aria-label={tr('关闭协议面板')} className="rounded-lg p-2"><X size={18} /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <p className={`mb-3 text-[11px] leading-5 ${theme.textMuted}`}>{tr('按当前连接方案记住功能和安全数值参数；ASCII、自定义和待核对参数仅本次有效，不会自动发送。')}</p>
      {(persistenceError || error || memory.error) && <div role="alert" className="mb-3 break-words rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">{persistenceError || error || memory.error}</div>}
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.2fr)]">
        <section className="min-w-0 space-y-3" aria-label={tr('协议功能列表')}>
          <div className={`flex items-center gap-2 ${field}`}><Search size={15} className="shrink-0 opacity-60" /><input aria-label={tr('搜索协议功能')} disabled={busy} value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('搜索功能名称或指令码')} className="w-full min-w-0 bg-transparent text-xs outline-none" /></div>
          <div className="flex items-center gap-2"><SelectMenu ariaLabel={tr('协议分类')} disabled={busy} value={category} onChange={changeCategory} isDark={isDark} className="min-w-0 flex-1" options={[{ value: '', label: tr('全部分类') }, ...categories.map(value => ({ value, label: categoryLabel(value) }))]} /><button type="button" disabled={busy} onClick={add} className={button}><Plus size={14} />{tr('添加命令')}</button></div>
          <p className={`text-xs ${theme.textMuted}`}>{tr('匹配 {0} 条 · 点击查看参数与报文', { 0: filtered.length.toLocaleString(locale) })}</p>
          <div className="max-h-[min(28rem,50vh)] space-y-1 overflow-y-auto rounded-xl border border-slate-400/20 p-1">
            {filtered.length ? filtered.map(command => <button type="button" key={command.id} disabled={busy} onClick={() => select(command)} aria-pressed={selectedId === command.id} className={`block w-full min-w-0 rounded-lg border px-3 py-2.5 text-left disabled:opacity-40 ${selectedId === command.id ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-transparent hover:bg-slate-400/10'}`}>
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium"><span className="min-w-0 break-words">{getProtocolDisplayName(command, locale)}</span>{command.referenceOnly ? <span className="text-[10px] font-normal opacity-70">{tr('上报参考')}</span> : command.needsReview && !command.reviewed ? <span className="text-[10px] font-normal text-amber-500">{tr('待核对')}</span> : command.modified && command.reviewed ? <span className="text-[10px] font-normal opacity-70">{tr('人工已核对')}</span> : null}</span>
              {command.simulatedInput && <span className="mt-1 block text-[10px] text-amber-500">{tr('模拟外设输入')}</span>}
              <span className={`mt-1 block truncate text-[11px] ${theme.textMuted}`}>{categoryLabel(command.category)} · <span className="font-mono">{command.template}</span></span>
            </button>) : <p className={`px-3 py-6 text-center text-xs ${theme.textMuted}`}>{tr('没有匹配命令，试试更短的关键词。')}</p>}
          </div>
          {preferences.removed.length > 0 && <div><button type="button" disabled={busy} onClick={() => setShowRemoved(value => !value)} aria-expanded={showRemoved} className={`text-xs underline ${theme.textMuted}`}>{tr('已删除的内置命令（{0}）', { 0: preferences.removed.length })}</button>{showRemoved && <div className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-auto">{preferences.removed.map(id => <button key={id} type="button" disabled={busy} onClick={() => restore(id)} className={button}><RotateCcw size={12} />{getProtocolDisplayName(originals.get(id), locale) || id}</button>)}</div>}</div>}
        </section>
        <div className={`min-w-0 rounded-xl border border-slate-400/20 p-4 ${isDark ? 'bg-[#202124]/50' : 'bg-slate-50/60'}`}>
          {editor ? <Rs232ProtocolCommandEditor key={editor.id} initial={editor} theme={theme} isDark={isDark} categoryOptions={categories.map(value => ({ value, label: categoryLabel(value) }))} onSave={save} onCancel={cancelEditor} onDirtyChange={dirty} onSavingChange={saving} /> : selected ? <section className="min-w-0 space-y-4" aria-label={tr('协议命令详情')}>
            <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className={`text-xs ${theme.textMuted}`}>{categoryLabel(selected.category)}</p><h3 data-protocol-command-title tabIndex={-1} className="mt-1 break-words text-lg font-semibold">{getProtocolDisplayName(selected, locale)}</h3></div><div className="flex flex-wrap gap-1"><button type="button" disabled={busy} onClick={() => edit(selected)} className={button}><Pencil size={13} />{tr('编辑')}</button><button type="button" disabled={busy} onClick={remove} className={button}><Trash2 size={13} />{tr('删除')}</button>{selected.builtin && selected.modified && <button type="button" disabled={busy} onClick={() => restore(selected.id)} className={button}><RotateCcw size={13} />{tr('恢复内置原样')}</button>}</div></div>
            {selected.modified && selected.reviewed && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('人工确认仅代表模板已核对，未验证当前设备或固件。')}</p>}
            {selected.simulatedInput && <p className="rounded-lg border border-amber-500/30 px-3 py-2 text-xs text-amber-500">{tr('模拟外设输入')}</p>}
            {(selected.referenceOnly || selected.needsReview && !selected.reviewed) && <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-500"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{selected.referenceOnly ? tr('这是设备上报示例，仅供查看，不可作为主机控制命令填入。') : tr('此条控制码在源表中存在疑点，请先编辑并核对；不会猜测修正值。')}</p>}
            {parameters.length > 0 && <div className="grid min-w-0 gap-3 sm:grid-cols-2">{parameters.map(parameter => <label key={parameter.key} className="block min-w-0 space-y-1 text-xs"><span>{parameter.labels?.[locale] || parameter.label || parameter.key}</span>{parameter.options?.length ? <SelectMenu disabled={busy} ariaLabel={parameter.labels?.[locale] || parameter.label || parameter.key} value={values[parameter.key] === undefined ? '' : String(values[parameter.key])} onChange={value => changeValues(parameter.key, value)} isDark={isDark} className="w-full" options={[{ value: '', label: tr('请选择参数') }, ...parameter.options.map(option => ({ value: String(option.value), label: option.labels?.[locale] || option.label }))]} /> : <input disabled={busy} value={values[parameter.key] ?? ''} onChange={event => changeValues(parameter.key, event.target.value)} className={`${field} w-full`} inputMode={parameter.type === 'byte' ? 'numeric' : 'text'} maxLength={247} placeholder={parameter.type === 'byte' ? tr('十进制 {0}–{1}，或 0x 前缀 HEX', { 0: parameter.min, 1: parameter.max }) : tr('输入 ASCII 数据')} />}</label>)}</div>}
            <div className="rounded-xl border border-slate-400/20 p-3"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium">{tr('生成的发送数据')}</span>{preview.frame && <span className={theme.textMuted}>{tr('{0} 字节', { 0: preview.frame.bytes.byteLength })}</span>}</div><pre className={`mt-2 whitespace-pre-wrap break-all font-mono text-xs leading-6 ${preview.frame ? 'text-emerald-500' : theme.textMuted}`}>{preview.frame?.hex || tr('填写有效参数后显示完整 HEX。')}</pre>{preview.error && <p role="status" className="mt-2 break-words text-xs text-amber-500">{preview.error}</p>}</div>
            {selected.note && <details className={`text-xs leading-5 ${theme.textMuted}`}><summary className="cursor-pointer">{tr('源文档备注（中文）')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{selected.note}</p></details>}
            <details className={`text-xs leading-5 ${theme.textMuted}`}><summary className="cursor-pointer">{tr('原始报文与适用范围')}</summary><p className="mt-2">{tr('参考 115200 / 8N1，无 CRC。实际端口、使能状态及固件支持需核对；不会自动修改连接。')}</p><p className="mt-2 break-all font-mono">{selected.sourceControl || selected.template}</p>{selected.sourceResponse && <p className="mt-1 break-all font-mono">{selected.sourceResponse}</p>}</details>
          </section> : <p className={`py-12 text-center text-sm ${theme.textMuted}`}>{tr('从左侧选择一个功能，或添加自己的命令。')}</p>}
        </div>
      </div>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-400/20 px-5 py-3"><span className={`mr-auto text-xs ${theme.textMuted}`}>{tr('仅填入发送区，不会自动发送。')}</span><button type="button" disabled={busy} onClick={resetMemory} className={button}>{tr('清除操作记忆')}</button><button type="button" disabled={busy} onClick={close} className={button}>{tr('关闭')}</button>{!editor && <button type="button" disabled={!preview.frame || busy} onClick={use} className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><ArrowDownToLine size={15} />{using ? tr('正在填入…') : tr('填入发送区')}</button>}</footer>
  </dialog>;
}
