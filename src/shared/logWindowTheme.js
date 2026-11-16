import themes from '../data/themes.js';

export function readLogWindowThemeKey(storage = globalThis.localStorage) {
  try { const key = storage.getItem('currentTheme'); return typeof key === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(key) ? key : 'tech'; }
  catch { return 'tech'; }
}
export function resolveLogWindowTheme(key, customThemes = []) {
  return customThemes.find(theme => theme?.key === key && typeof theme.card === 'string') || (Object.hasOwn(themes, key) ? themes[key] : null) || themes.tech;
}
