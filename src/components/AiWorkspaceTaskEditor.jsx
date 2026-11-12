import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import { TASK_EDIT_TYPES as TYPES, TASK_EDIT_FIELDS as FIELDS, newEditableStep, moveEditableStep } from './AiWorkspaceTaskEditing';

export default function AiWorkspaceTaskEditor({ value, onChange, targets = [], platform = 'android', disabled, theme }) {
  useLocale();
  const isDark = isDarkTheme(theme);
  const input = `w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs disabled:opacity-50 ${theme.input}`;
  const button = `rounded p-1.5 disabled:opacity-30 ${theme.button.secondary}`;
  const labels = { delay: tr('等待'), screenshot: tr('截图'), perfSnapshot: tr('性能采样'), tap: tr('点击'), longPress: tr('长按'), swipe: tr('滑动'), input: tr('输入'),
    keyevent: tr('按键'), waitText: tr('等待文本'), assertText: tr('文本断言'), x: 'X', y: 'Y', endX: tr('终点 X'), endY: tr('终点 Y'),
    durationMs: tr('时长（ms）'), timeoutMs: tr('超时（ms）'), text: tr('文本'), keyCode: tr('按键') };
  const changeStep = (index, change) => onChange({ ...value, steps: value.steps.map((step, position) => position === index ? { ...step, ...change } : step) });
  const typeChange = (index, type) => onChange({ ...value, steps: value.steps.map((step, position) => position === index ? { ...newEditableStep(type, platform), label: step.label } : step) });
  return <div className="space-y-3">
    <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('可直接编辑草案，不会重新调用 AI。保存时会再次校验，运行仍需单独确认。')}</p>
    <label className="block space-y-1.5"><span className="text-xs">{tr('任务名称')}</span><input aria-label={tr('任务名称')} value={value.name} maxLength={80} disabled={disabled} onChange={event => onChange({ ...value, name: event.target.value })} className={input} /></label>
    <label className="block space-y-1.5"><span className="text-xs">{tr('说明')}</span><textarea aria-label={tr('说明')} value={value.description} maxLength={500} rows={3} disabled={disabled} onChange={event => onChange({ ...value, description: event.target.value })} className={`${input} resize-y`} /></label>
    <ol className="space-y-2">{value.steps.map((step, index) => <li key={index} className={`space-y-3 rounded-lg border p-3 ${theme.input}`}>
      <div className="flex items-center gap-2"><span className="text-xs text-emerald-500">{index + 1}</span>
        <SelectMenu ariaLabel={tr('步骤类型')} value={step.type} disabled={disabled} onChange={type => typeChange(index, type)} isDark={isDark} className="min-w-0 flex-1" options={TYPES.filter(type => platform !== 'harmony' || type !== 'longPress').map(type => ({ value: type, label: labels[type] }))} />
        <button type="button" aria-label={tr('上移步骤')} disabled={disabled || index === 0} onClick={() => onChange({ ...value, steps: moveEditableStep(value.steps, index, -1) })} className={button}><ArrowUp size={13} /></button>
        <button type="button" aria-label={tr('下移步骤')} disabled={disabled || index === value.steps.length - 1} onClick={() => onChange({ ...value, steps: moveEditableStep(value.steps, index, 1) })} className={button}><ArrowDown size={13} /></button>
        <button type="button" aria-label={tr('删除步骤')} disabled={disabled || value.steps.length === 1} onClick={() => onChange({ ...value, steps: value.steps.filter((_, position) => position !== index) })} className={button}><Trash2 size={13} /></button>
      </div>
      <label className="block space-y-1"><span className="text-xs">{tr('步骤名称')}</span><input value={step.label} maxLength={80} disabled={disabled} onChange={event => changeStep(index, { label: event.target.value })} className={input} /></label>
      {step.targetId && <div className="space-y-1"><span className="text-xs">{tr('已选控件')}</span><SelectMenu ariaLabel={tr('已选控件')} value={step.targetId} disabled={disabled} onChange={targetId => changeStep(index, { targetId })} isDark={isDark} options={targets.map(target => ({ value: target.id, label: `${target.id} · ${target.label}` }))} /></div>}
      <div className="grid gap-2 sm:grid-cols-2">{FIELDS[step.type].filter(key => !step.targetId || ['durationMs', 'timeoutMs'].includes(key)).map(key => <label key={key} className="min-w-0 space-y-1"><span className="text-xs">{labels[key]}</span>
        {key === 'keyCode' ? <SelectMenu ariaLabel={labels[key]} value={step.keyCode} disabled={disabled} onChange={keyCode => changeStep(index, { keyCode })} isDark={isDark}
          options={(platform === 'harmony' ? [['Home', 'HOME'], ['Back', 'BACK']] : [['3', 'HOME'], ['4', 'BACK'], ['19', 'DPAD_UP'], ['20', 'DPAD_DOWN'], ['21', 'DPAD_LEFT'], ['22', 'DPAD_RIGHT'], ['23', 'DPAD_CENTER'], ['61', 'TAB'], ['66', 'ENTER'], ['67', 'DEL'], ['111', 'ESCAPE'], ['122', 'MOVE_HOME'], ['123', 'MOVE_END'], ['187', 'APP_SWITCH']]).map(([value, label]) => ({ value, label }))} />
          : <input value={step[key]} type={key === 'text' ? 'text' : 'number'} maxLength={key === 'text' ? 500 : undefined} disabled={disabled} onChange={event => changeStep(index, { [key]: key === 'text' || event.target.value === '' ? event.target.value : Number(event.target.value) })} className={input} />}
      </label>)}</div>
    </li>)}</ol>
    <button type="button" disabled={disabled || value.steps.length >= 20} onClick={() => onChange({ ...value, steps: [...value.steps, { ...newEditableStep(), label: labels.delay }] })} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`}><Plus size={13} />{tr('添加步骤')}</button>
  </div>;
}
