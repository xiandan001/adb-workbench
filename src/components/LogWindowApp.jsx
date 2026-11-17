import { useEffect, useState } from 'react';
import LogAnalyzer from './LogAnalyzer.jsx';
import { readLogWindowThemeKey, resolveLogWindowTheme } from '../shared/logWindowTheme.js';
import useThemeScope from '../shared/useThemeScope.js';

export default function LogWindowApp() {
  const [key, setKey] = useState(readLogWindowThemeKey), [customThemes, setCustomThemes] = useState([]);
  useEffect(() => {
    let alive = true, generation = 0;
    const refresh = () => {
      setKey(readLogWindowThemeKey()); const ticket = ++generation;
      Promise.resolve(window.electronAPI?.loadCustomThemes?.()).then(value => {
        const themes = Array.isArray(value) ? value : value?.success === true && Array.isArray(value.data) ? value.data : null;
        if (alive && ticket === generation && themes) setCustomThemes(themes);
      }).catch(() => {});
    };
    const storage = event => { if (event.key === 'currentTheme') refresh(); };
    refresh(); window.addEventListener('storage', storage); window.addEventListener('focus', refresh);
    return () => { alive = false; generation++; window.removeEventListener('storage', storage); window.removeEventListener('focus', refresh); };
  }, []);
  const theme = resolveLogWindowTheme(key, customThemes);
  useThemeScope(theme);
  return <LogAnalyzer theme={theme} />;
}
