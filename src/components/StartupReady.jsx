import { useEffect } from 'react';

export default function StartupReady() {
  useEffect(() => {
    let paintedFrame; let active = true;
    const frame = requestAnimationFrame(() => {
      if (!active) return;
      paintedFrame = requestAnimationFrame(() => {
        if (!active) return;
        if (window.__workbenchStartup) window.__workbenchStartup.complete();
        else {
          document.getElementById('app-startup')?.remove();
          const root = document.getElementById('root');
          root.removeAttribute('inert');
          root.setAttribute('aria-busy', 'false');
        }
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); if (paintedFrame !== undefined) cancelAnimationFrame(paintedFrame); };
  }, []);
  return null;
}
