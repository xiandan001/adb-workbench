export function resolveThemeKey(key, customThemes = []) {
  return key === 'tech' && !customThemes.some(theme => theme?.key === key) ? 'graphite' : key;
}

export function isDarkTheme(theme) {
  if (typeof theme?.isDark === 'boolean') return theme.isDark;
  if (theme?.mode === 'dark' || theme?.primary === 'tech') return true;
  return /(?:bg|from|via|to)-(?:(?:slate|gray|zinc|neutral|stone|green|blue|cyan|emerald|pink|purple|rose)-(?:[789]00|950)|black\b|\[#(?:202124|2d2f33|3e4145|0d0e10|161b22)\])/i.test(theme?.card || '');
}
