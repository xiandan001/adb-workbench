import { tr, useLocale } from '../shared/i18n';
import { useState } from 'react';
import { BookmarkPlus, Trash2 } from 'lucide-react';
import { deleteLogPreset, readLogPresets, saveLogPreset } from '../shared/logWorkspace';
import SelectMenu from './SelectMenu';

export default function LogFilterPresets({ filter, buffers, onApply, isDark }) {
  useLocale();
  const [presets, setPresets] = useState(() => {
    try { return readLogPresets(localStorage); } catch { return []; }
  });
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const field = `min-w-0 rounded-lg border px-2 py-1.5 text-xs ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-700'}`;

  function save() {
    try {
      const id = crypto.randomUUID();
      const next = saveLogPreset(localStorage, presets, { name, filter, buffers }, id);
      setPresets(next);
      setSelectedId(id);
      setName('');
      setMessage(tr("已保存当前过滤条件和日志缓冲区"));
    } catch (error) { setMessage(error.message); }
  }

  function remove() {
    try {
      setPresets(deleteLogPreset(localStorage, presets, selectedId));
      setSelectedId('');
      setMessage(tr("已删除预设，当前过滤条件不变"));
    } catch (error) { setMessage(tr("删除失败：{0}", { 0: error.message })); }
  }

  return (
    <div className={`mb-4 space-y-2 border-b pb-3 ${isDark ? 'border-[#3E4145] text-[#E8EAED]' : 'border-slate-200 text-slate-700'}`}>
      <label className="block text-xs font-medium" htmlFor="log-filter-preset">{tr("常用过滤")}</label>
      <div className="flex gap-1">
        <SelectMenu
          id="log-filter-preset" value={selectedId} onChange={setSelectedId} isDark={isDark}
          compact accent="cyan" className="flex-1" placeholder={tr("选择已保存的预设")}
          emptyText={tr("暂无过滤预设，请先在下方输入名称并保存。")}
          options={presets.length ? [{ value: '', label: tr("不选择预设") }, ...presets.map(item => ({ value: item.id, label: item.name }))] : []}
        />
        <button type="button" disabled={!selectedId} className={`${field} disabled:opacity-40`} onClick={() => {
          const preset = presets.find(item => item.id === selectedId);
          if (preset) { onApply(preset); setMessage(tr("已套用“{0}”", { 0: preset.name })); }
        }}>{tr("套用")}</button>
        <button type="button" aria-label={tr("删除选中的过滤预设")} title={tr("删除选中的过滤预设")} disabled={!selectedId} onClick={remove} className={`${field} disabled:opacity-40`}><Trash2 size={13} /></button>
      </div>
      <div className="flex gap-1">
        <input value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder={tr("新预设名称")} aria-label={tr("新过滤预设名称")} className={`${field} flex-1`} />
        <button type="button" onClick={save} className={`${field} flex items-center gap-1`}><BookmarkPlus size={13} />{tr("保存")}</button>
      </div>
      {message && <p role="status" className={`text-xs ${isDark ? 'text-[#BDC1C6]' : 'text-slate-600'}`}>{message}</p>}
    </div>
  );
}
