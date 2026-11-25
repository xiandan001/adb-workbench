import { useEffect, useId, useRef } from 'react';
import { List, Plus, Trash2 } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';

const MAX_OPTIONS = 64;
const LABEL_LENGTH = 80;

function ByteParameter({ parameter, theme, disabled, onChange }) {
  const { key, label, options } = parameter;
  const id = useId(), rows = useRef(null), addButton = useRef(null), pendingFocus = useRef(null);
  const field = `w-full min-w-0 rounded-lg border px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 ${theme.input}`;
  const tokenColor = isDarkTheme(theme) ? 'text-emerald-300' : 'text-emerald-800';
  const optionGrid = 'grid grid-cols-[minmax(0,1fr)_minmax(3.25rem,22%)_2rem] items-center gap-2';
  const setOptions = next => onChange(key, { ...parameter, options: next });
  const updateOption = (index, patch) => setOptions(options.map((option, at) => at === index ? { ...option, ...patch } : option));
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const target = index === -1 ? addButton.current : rows.current?.querySelector(`[data-rs232-option-row="${index}"] [data-rs232-option-label]`);
    target?.focus();
  }, [options.length]);
  const add = () => {
    if (disabled || options.length >= MAX_OPTIONS) return;
    pendingFocus.current = options.length;
    setOptions([...options, { label: '', hex: '' }]);
  };
  const remove = index => {
    if (disabled) return;
    pendingFocus.current = Math.min(index, options.length - 2);
    setOptions(options.filter((_, at) => at !== index));
  };
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-slate-400/20" data-rs232-parameter-key={key} aria-labelledby={`${id}-token`}>
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-slate-400/15 bg-slate-400/5 px-3 py-2.5">
        <code id={`${id}-token`} className={`max-w-full break-all rounded-md bg-emerald-500/10 px-2 py-1 font-mono text-xs font-semibold ${tokenColor}`}>{`{${key}}`}</code>
        <span className={`text-xs ${theme.textMuted}`}>{tr('单字节参数')}</span>
      </header>
      <div className="grid min-w-0 gap-3 p-3">
        <label className="grid min-w-0 gap-2">
          <span className="text-xs font-medium" id={`${id}-label`}>{tr('参数名称')}</span>
          <input data-rs232-parameter-label aria-labelledby={`${id}-token ${id}-label`} disabled={disabled}
            value={label} maxLength={LABEL_LENGTH} onChange={event => onChange(key, { ...parameter, label: event.target.value })} className={field} />
        </label>
        {options.length ? (
          <div className="grid min-w-0 gap-2" ref={rows}>
            <div className={`${optionGrid} px-0.5 text-xs font-medium ${theme.textMuted}`}>
              <span id={`${id}-option-label`}>{tr('选项名称')}</span>
              <span id={`${id}-option-value`}>{tr('HEX 值')}</span>
            </div>
            {options.map((option, index) => (
              <div key={index} className={optionGrid} data-rs232-option-row={index}>
                <span className="sr-only" id={`${id}-item-${index}`}>{tr('第 {0} 个选项', { 0: index + 1 })}</span>
                <input data-rs232-option-label aria-labelledby={`${id}-token ${id}-item-${index} ${id}-option-label`} disabled={disabled}
                  value={option.label} maxLength={LABEL_LENGTH} onChange={event => updateOption(index, { label: event.target.value })} className={field} />
                <input data-rs232-option-hex aria-labelledby={`${id}-token ${id}-item-${index} ${id}-option-value`} disabled={disabled}
                  autoComplete="off" spellCheck={false} value={option.hex} maxLength={2} aria-invalid={Boolean(option.hex && !/^[\dA-F]{2}$/i.test(option.hex))}
                  onChange={event => updateOption(index, { hex: event.target.value.toUpperCase() })}
                  className={`${field} px-1 text-center font-mono uppercase aria-[invalid=true]:border-red-500/70`} />
                <button type="button" data-rs232-option-remove aria-label={tr('删除第 {0} 个选项', { 0: index + 1 })} disabled={disabled}
                  onClick={() => remove(index)} className="grid size-8 place-items-center rounded-lg text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline-2 focus-visible:outline-red-500 disabled:opacity-40">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('没有下拉选项时，将直接输入字节值。')}</p>}
        <button type="button" data-rs232-option-add ref={addButton} disabled={disabled || options.length >= MAX_OPTIONS} onClick={add}
          title={options.length >= MAX_OPTIONS ? tr('最多可添加 {0} 个选项。', { 0: MAX_OPTIONS }) : undefined}
          className={`inline-flex w-fit items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-40 ${theme.button.secondary}`}>
          <Plus size={14} aria-hidden="true" />{tr('添加选项')}
        </button>
      </div>
    </section>
  );
}

export default function Rs232ProtocolParametersEditor({ parameters, theme, disabled, onChange }) {
  useLocale();
  const title = useId();
  return (
    <section data-rs232-parameters-editor aria-labelledby={title} className="grid min-w-0 gap-3 rounded-xl border border-slate-400/20 p-3">
      <div className="flex items-start gap-2.5">
        <List size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-500" />
        <div className="min-w-0">
          <h4 id={title} className="text-sm font-semibold">{tr('参数选项')}</h4>
          <p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('为模板里的单字节参数添加下拉选项。选项的 HEX 值会写入对应位置。')}</p>
        </div>
      </div>
      {parameters.length ? parameters.map(parameter => parameter.type === 'byte'
        ? <ByteParameter key={parameter.key} parameter={parameter} theme={theme} disabled={disabled} onChange={onChange} />
        : <div key={parameter.key} data-rs232-parameter-key={parameter.key} className="min-w-0 rounded-lg border border-dashed border-slate-400/20 p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <code className="max-w-full break-all rounded bg-slate-400/10 px-1.5 py-1">{`{${parameter.key}}`}</code>
            <span className="min-w-0 break-words font-medium">{parameter.label}</span>
          </div>
          <p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr('ASCII 和多字节 HEX 参数保留原输入方式。')}</p>
        </div>)
        : <p className={`rounded-lg border border-dashed border-slate-400/20 p-3 text-xs leading-5 ${theme.textMuted}`}>
          {tr('模板未包含参数占位符。添加 {0} 后可配置参数。', { 0: '{XX}' })}
        </p>}
    </section>
  );
}
