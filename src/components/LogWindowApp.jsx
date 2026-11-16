import { useEffect, useState } from 'react';
import LogAnalyzer from './LogAnalyzer.jsx';
import { readLogWindowThemeKey, resolveLogWindowTheme } from '../shared/logWindowTheme.js';

export default function LogWindowApp() {
  const [key, setKey] = useState(readLogWindowThemeKey), [customThemes, setCustomThemes] = useState([]);
  useEffect(() => {
    let alive = true, generation = 0;
    const refresh = () => {
      setKey(readLogWindowThemeKey()); const ticket = ++generation;
      Promise.resolve(window.electronAPI?.loadCustomThemes?.()).then(value => {
        if (alive && ticket === generation && Array.isArray(value)) setCustomThemes(value);
      }).catch(() => {});
    };
    const storage = event => { if (event.key === 'currentTheme') refresh(); };
    refresh(); window.addEventListener('storage', storage); window.addEventListener('focus', refresh);
    return () => { alive = false; generation++; window.removeEventListener('storage', storage); window.removeEventListener('focus', refresh); };
  }, []);
  return <LogAnalyzer theme={resolveLogWindowTheme(key, customThemes)} />;
}
