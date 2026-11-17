import themes from '../data/themes.js';
import { resolveThemeKey } from './theme.js';

export function readLogWindowThemeKey(storage = globalThis.localStorage) {
  try { const key = storage.getItem('currentTheme'); return typeof key === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(key) ? key : 'graphite'; }
  catch { return 'graphite'; }
}
export function resolveLogWindowTheme(key, customThemes = []) {
  const effectiveKey = resolveThemeKey(key, customThemes);
  return customThemes.find(theme => theme?.key === key && typeof theme.card === 'string') || (Object.hasOwn(themes, effectiveKey) ? themes[effectiveKey] : null) || themes.graphite;
}
