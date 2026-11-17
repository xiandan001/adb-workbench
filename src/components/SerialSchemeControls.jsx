import { useId, useState } from 'react';
import { ChevronDown, Plug, Save, Trash2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { addSerialScheme, applySerialScheme, removeSerialScheme, updateSerialScheme } from '../shared/serialSchemes.js';
import { confirmAppMessage } from '../shared/appMessageDialog.js';
import SelectMenu from './SelectMenu';

export default function SerialSchemeControls({ preferences, workspace, config, selectedPath, terminalEnter, status, pending, onCommit, selected = '', expanded = false, onExpandedChange, onSelect, onApplyAndConnect, canConnect = false, theme, isDark }) {
  useLocale();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const messages = {
    applied: tr('已套用方案，未连接、未发送；当前 COM 不变'),
    removed: tr('连接方案已删除，当前参数不变'),
    saved: tr('连接方案已保存，仅保存在本机'),
    updated: tr('所选方案已更新，当前 COM 和连接保持不变')
  };
  const schemes = (preferences.schemes || []).filter(item => item.workspace === workspace);
  const selectedScheme = schemes.find(item => item.id === selected);
  const selectedConfig = selectedScheme?.config || config;
  const parity = { none: tr('无校验'), even: tr('偶校验'), odd: tr('奇校验'), mark: tr('标记校验'), space: tr('空格校验') };
  const flow = { none: tr('无流控'), rtscts: tr('硬件 RTS/CTS'), xonxoff: tr('软件 XON/XOFF') };
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
  return <div data-serial-schemes className="space-y-2 rounded-lg border border-slate-400/20 p-2.5">
    <button type="button" aria-expanded={expanded} aria-controls={`${id}-content`} onClick={() => onExpandedChange?.(!expanded)} className="flex w-full min-w-0 flex-wrap items-center gap-2 text-left text-xs"><ChevronDown size={14} className={`shrink-0 ${expanded ? '' : '-rotate-90'}`} /><span className="font-medium">{tr('连接方案')}</span><span className={`min-w-0 flex-1 break-words ${theme.textMuted}`}>{selectedScheme?.name || tr('未选择方案')}</span><span className={`shrink-0 ${theme.textMuted}`}>{tr('已保存 {0} 个', { 0: schemes.length })}</span></button>
    {expanded && <div id={`${id}-content`} className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">{tr('连接方案')}</label>
      <SelectMenu id={id} value={selected} options={schemes.map(item => ({ value: item.id, label: item.name }))} onChange={onSelect} isDark={isDark} compact placeholder={tr('选择当前工作区的方案')} emptyText={tr('保存当前参数，下次直接套用')} className="min-w-40 flex-1" />
      <button type="button" disabled={!selectedScheme || locked} onClick={() => run(() => applySerialScheme(preferences, selected, workspace, { status, pending }), 'applied')} className={button}>{tr('套用')}</button>
      <button type="button" disabled={!selectedScheme || locked || !canConnect || !onApplyAndConnect} onClick={() => onApplyAndConnect?.()} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.primary}`}><Plug size={14} />{tr('套用并连接')}</button>
    </div>
    {selectedScheme && <p className={`break-words text-xs ${theme.textMuted}`}>{tr('连接目标：{0} · {1}/{2}/{3} · {4} · {5}', { 0: selectedPath || tr('请选择串口'), 1: selectedConfig.baudRate, 2: selectedConfig.dataBits, 3: selectedConfig.stopBits, 4: parity[selectedConfig.parity], 5: flow[selectedConfig.flowControl] })}</p>}
    <details><summary className="cursor-pointer text-xs font-medium">{tr('管理连接方案')}<span className={'ml-2 font-normal ' + theme.textMuted}>{tr('已保存 {0} 个', { 0: schemes.length })}</span></summary>
    <div className="mt-2 space-y-2"><div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => { setName((selectedPath || tr('串口')) + ' · ' + config.baudRate); setSaving(true); setStatusMessage(''); setError(''); }} className={button}><Save size={13} />{tr('保存当前参数')}</button>
      <button type="button" disabled={!selected || pending} className={button} onClick={async () => {
        const scheme = schemes.find(item => item.id === selected);
        if (!scheme || !await confirmAppMessage({ type: 'warning', title: tr('更新所选方案'), message: tr('用当前参数替换「{0}」？', { 0: scheme.name }), detail: tr('保留方案名称和 ID；不会连接、发送或改变当前 COM。'), confirmLabel: tr('更新方案') })) return;
        run(() => updateSerialScheme(preferences, { id: scheme.id, workspace, config, terminalEnter }), 'updated');
      }}>{tr('更新所选方案')}</button>
      <button type="button" aria-label={tr('删除所选连接方案')} title={tr('仅删除方案，不断开连接、不删除记录')} disabled={!selected} onClick={() => {
        if (run(() => removeSerialScheme(preferences, selected, workspace), 'removed')) onSelect?.('');
      }} className={button}><Trash2 size={13} /></button>
    </div>
    {saving && <form className="flex items-center gap-2" onSubmit={event => {
      event.preventDefault();
      const schemeId = crypto.randomUUID();
      if (run(() => addSerialScheme(preferences, { id: schemeId, name, workspace, config, terminalEnter }), 'saved')) { onSelect?.(schemeId); setSaving(false); }
    }}>
      <input autoFocus aria-label={tr('连接方案名称')} value={name} maxLength={80} onChange={event => setName(event.target.value)} className={'min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs ' + theme.input} />
      <button type="submit" className={button}>{tr('保存')}</button>
      <button type="button" aria-label={tr('取消保存连接方案')} onClick={() => setSaving(false)} className={button}><X size={13} /></button>
    </form>}
    <p className={'text-[11px] leading-5 ' + theme.textMuted}>{locked ? tr('连接期间不能套用方案；可以保存当前参数。') : workspace === 'terminal' ? tr('终端方案仅套用连接参数和回车格式，不改 RS232 设置。') : tr('选择方案不会连接；“套用”只改参数，“套用并连接”才打开当前 COM。')}</p>
    </div></details>
    </div>}
    {statusMessage && <p role="status" className={'text-xs ' + theme.textMuted}>{messages[statusMessage]}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{tr(error)}</p>}
  </div>;
}
