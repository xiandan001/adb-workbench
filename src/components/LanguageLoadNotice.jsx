import { useSyncExternalStore } from 'react';
import { getLanguageSnapshot, subscribeLanguage, retryLanguage, tr, useLocale } from '../shared/i18n.js';

export function LanguageCatalogGate({ children }) {
  const state = useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot);
  if (!state.initializing) return children;
  return <main aria-busy="true" className="flex min-h-screen items-center justify-center bg-[#181818] p-6 text-slate-200"><p role="status">{tr('正在加载语言资源… / Loading language…')}</p></main>;
}

export default function LanguageLoadNotice() {
  useLocale();
  const state = useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot);
  if (!state.error) return null;
  return <div role="alert" className="flex w-full shrink-0 basis-full flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
    <span className="min-w-0 flex-1">{tr('语言资源暂未加载，当前界面仍可使用；不会改写已保存的语言选择。')}</span>
    <button type="button" onClick={() => { void retryLanguage(); }} className="shrink-0 rounded border border-current/30 px-2 py-1">{tr('重试加载')}</button>
  </div>;
}
