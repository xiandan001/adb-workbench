import { useLayoutEffect } from 'react';
import { applyUiMotionPreferences, defaultUiMotionPreferences, readUiMotionPreferences, UI_MOTION_CHANGED, UI_MOTION_PREFS_KEY } from '../shared/uiMotionPreferences';

export default function UiMotionPreferences() {
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      let preferences = defaultUiMotionPreferences();
      try { preferences = readUiMotionPreferences(); } catch { /* Settings keeps the corrupt value and offers an explicit repair. */ }
      applyUiMotionPreferences(preferences, document.documentElement, media.matches);
    };
    const storageChanged = event => { if (event.key === UI_MOTION_PREFS_KEY || event.key === null) update(); };
    update();
    window.addEventListener(UI_MOTION_CHANGED, update);
    window.addEventListener('storage', storageChanged);
    media.addEventListener('change', update);
    return () => {
      window.removeEventListener(UI_MOTION_CHANGED, update);
      window.removeEventListener('storage', storageChanged);
      media.removeEventListener('change', update);
    };
  }, []);
  return null;
}
