import { useEffect, useId, useRef, useState } from 'react';
import { Check, Languages, Loader2 } from 'lucide-react';
import { setLanguage, tr, useLocale } from '../shared/i18n';
import { trapAppMessageFocus } from '../shared/appMessageDialog';

const options = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
];

export default function InitialLanguageDialog({ theme, isDark }) {
  const locale = useLocale();
  const id = useId(); const dialogRef = useRef(null); const selectedRef = useRef(null);
  const alive = useRef(false); const saving = useRef(false);
  const [selected, setSelected] = useState(locale);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => {
    alive.current = true;
    const dialog = dialogRef.current; const previous = document.activeElement;
    dialog.showModal(); selectedRef.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false; dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const confirm = async event => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); setFailed(false);
    try { await setLanguage(selected); }
    catch { if (alive.current) setFailed(true); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <dialog ref={dialogRef} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => event.preventDefault()} onKeyDown={trapAppMessageFocus}
    className={`m-auto max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-2xl border p-6 shadow-2xl backdrop:bg-black/60 ${isDark ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}>
    <div className="mb-4 flex items-center gap-3"><span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-500"><Languages size={25} /></span><div className="min-w-0">
      <p className={`text-xs ${theme.textMuted}`}>{tr('欢迎使用 {0}', { 0: tr('卓控台', {}, selected) }, selected)}</p>
      <h2 id={`${id}-title`} className="mt-1 text-lg font-semibold">{tr('选择应用语言', {}, selected)}</h2>
    </div></div>
    <p id={`${id}-description`} className={`mb-5 text-sm leading-6 ${theme.textMuted}`}>{tr('请选择显示语言，之后可以在偏好设置中修改。', {}, selected)}</p>
    <form onSubmit={confirm}>
      <fieldset disabled={busy} className="space-y-2 disabled:opacity-60">
        <legend className="sr-only">{tr('应用语言', {}, selected)}</legend>
        {options.map(option => <label key={option.value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-emerald-500 ${selected === option.value ? 'border-emerald-500 bg-emerald-500/10' : isDark ? 'border-[#5F6368] hover:bg-[#2D2F33]' : 'border-slate-200 hover:bg-slate-50'}`}>
          <input ref={selected === option.value ? selectedRef : null} type="radio" name={`${id}-language`} value={option.value}
            checked={selected === option.value} tabIndex={selected === option.value ? 0 : -1}
            onChange={() => { setSelected(option.value); setFailed(false); }} className="sr-only" />
          <span className="flex-1">{option.label}</span>
          {selected === option.value && <Check size={17} aria-hidden="true" className="text-emerald-500" />}
        </label>)}
      </fieldset>
      {failed && <p role="alert" className="mt-4 text-sm leading-6 text-red-500">{tr('语言设置保存失败，原语言未改变。请重试。', {}, selected)}</p>}
      <div className="mt-5 flex justify-end"><button type="submit" disabled={busy}
        className={`inline-flex max-w-full items-center justify-center gap-2 whitespace-normal rounded-xl px-5 py-2.5 text-sm font-medium disabled:opacity-50 ${theme.button.primary}`}>
        {busy && <Loader2 size={16} className="shrink-0 animate-spin" />}
        {busy ? tr('正在保存语言…', {}, selected) : tr('确认并继续', {}, selected)}
      </button></div>
    </form>
  </dialog>;
}
