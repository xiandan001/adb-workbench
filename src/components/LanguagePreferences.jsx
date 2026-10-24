import { useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { setLanguage, tr, useLocale } from '../shared/i18n';

const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
];

export default function LanguagePreferences({ theme, isDark }) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async next => {
    if (busy || next === locale) return;
    setBusy(true); setError('');
    try { await setLanguage(next); }
    catch { setError(tr('语言设置保存失败，原语言未改变。请重试。')); }
    finally { setBusy(false); }
  };
  return <div className={`mb-4 border-b pb-4 ${isDark ? 'border-slate-600/60' : 'border-slate-200'} ${theme.text}`}>
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Languages size={16} className="text-emerald-500" />语言 / Language</h3>
        <p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('选择应用显示语言，立即生效并自动保存。不会中断当前连接或任务。')}</p>
      </div>
      <div className="flex w-56 max-w-full items-center gap-2">
        {busy && <Loader2 size={16} className="shrink-0 animate-spin text-emerald-500" />}
        <SelectMenu value={locale} options={languageOptions} onChange={change} disabled={busy} isDark={isDark} ariaLabel="Language / 语言" className="w-full" />
      </div>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-red-500">{tr(error)}</p>}
  </div>;
}
