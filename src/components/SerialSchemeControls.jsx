import { useId, useState } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { addSerialScheme, applySerialScheme, removeSerialScheme } from '../shared/serialSchemes.js';
import SelectMenu from './SelectMenu';

export default function SerialSchemeControls({ preferences, workspace, config, selectedPath, terminalEnter, status, pending, onCommit, theme, isDark }) {
  useLocale();
  const id = useId();
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const messages = {
    applied: tr('已套用方案，未连接、未发送；当前 COM 不变'),
    removed: tr('连接方案已删除，当前参数不变'),
    saved: tr('连接方案已保存，仅保存在本机')
  };
  const schemes = (preferences.schemes || []).filter(item => item.workspace === workspace);
  const locked = pending || !['disconnected', 'error'].includes(status);
  const button = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-40 ' + theme.button.secondary;
  function run(operation, success) {
    setError(''); setStatusMessage('');
    try {
      const result = operation();
      if (onCommit(result.preferences || result, result.terminalEnter) !== false) {
        setStatusMessage(success);
        return true;
      }
      setError(tr('方案未能保存，当前参数保持不变'));
    } catch (failure) { setError(failure.message); }
    return false;
  }
  return <details className="rounded-lg border border-slate-400/20 p-2.5">
    <summary className="cursor-pointer text-xs font-medium">{tr('连接方案')}<span className={'ml-2 font-normal ' + theme.textMuted}>{tr('已保存 {0} 个', { 0: schemes.length })}</span></summary>
    <div className="mt-2 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">{tr('连接方案')}</label>
      <SelectMenu id={id} value={selected} options={schemes.map(item => ({ value: item.id, label: item.name }))} onChange={setSelected} isDark={isDark} compact placeholder={tr('选择当前工作区的方案')} emptyText={tr('保存当前参数，下次直接套用')} className="min-w-40 flex-1" />
      <button type="button" disabled={!selected || locked} onClick={() => run(() => applySerialScheme(preferences, selected, workspace, { status, pending }), 'applied')} className={button}>{tr('套用')}</button>
      <button type="button" onClick={() => { setName((selectedPath || tr('串口')) + ' · ' + config.baudRate); setSaving(true); setStatusMessage(''); setError(''); }} className={button}><Save size={13} />{tr('保存当前参数')}</button>
      <button type="button" aria-label={tr('删除所选连接方案')} title={tr('仅删除方案，不断开连接、不删除记录')} disabled={!selected} onClick={() => {
        if (run(() => removeSerialScheme(preferences, selected, workspace), 'removed')) setSelected('');
      }} className={button}><Trash2 size={13} /></button>
    </div>
    {saving && <form className="flex items-center gap-2" onSubmit={event => {
      event.preventDefault();
      const schemeId = crypto.randomUUID();
      if (run(() => addSerialScheme(preferences, { id: schemeId, name, workspace, config, terminalEnter }), 'saved')) { setSelected(schemeId); setSaving(false); }
    }}>
      <input autoFocus aria-label={tr('连接方案名称')} value={name} maxLength={80} onChange={event => setName(event.target.value)} className={'min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs ' + theme.input} />
      <button type="submit" className={button}>{tr('保存')}</button>
      <button type="button" aria-label={tr('取消保存连接方案')} onClick={() => setSaving(false)} className={button}><X size={13} /></button>
    </form>}
    <p className={'text-[11px] leading-5 ' + theme.textMuted}>{locked ? tr('连接期间不能套用方案；可以保存当前参数。') : workspace === 'terminal' ? tr('终端方案仅套用连接参数和回车格式，不改 RS232 设置。') : tr('方案包含连接参数、收发格式和换行符；套用后仍需点击连接。')}</p>
    {statusMessage && <p role="status" className={'text-xs ' + theme.textMuted}>{messages[statusMessage]}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{tr(error)}</p>}
    </div>
  </details>;
}
