import { isDarkTheme } from './theme.js';

export function activityPresentation(theme, requestedDark) {
  const dark = typeof requestedDark === 'boolean' ? requestedDark : theme ? isDarkTheme(theme) : true;
  return {
    dark,
    panel: theme?.card || (dark ? 'border-slate-600 bg-[#202124]' : 'border-slate-200 bg-white'),
    text: theme?.text || (dark ? 'text-slate-100' : 'text-slate-800'),
    muted: dark ? 'text-slate-400' : 'text-slate-500',
    heading: dark ? 'text-slate-300' : 'text-slate-600',
    hover: dark ? 'hover:bg-white/10' : 'hover:bg-slate-100',
    border: dark ? 'border-white/10' : 'border-slate-200',
  };
}
