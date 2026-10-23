import { useEffect } from 'react';

export default function StartupReady() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (window.__workbenchStartup) window.__workbenchStartup.complete();
      else {
        document.getElementById('app-startup')?.remove();
        const root = document.getElementById('root');
        root.removeAttribute('inert');
        root.setAttribute('aria-busy', 'false');
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
