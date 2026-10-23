/* Apply visual preferences before styles paint; never write storage during startup. */
(() => {
  let reducedMotion = false;
  let startupAnimation = true;
  try {
    const raw = window.localStorage.getItem('adb-workbench.ui-motion.v1');
    const value = typeof raw === 'string' && raw.length <= 256 ? JSON.parse(raw) : null;
    if (value && Object.keys(value).sort().join(',') === 'reducedMotion,startupAnimation,version' && value.version === 1
      && typeof value.reducedMotion === 'boolean' && typeof value.startupAnimation === 'boolean') {
      reducedMotion = value.reducedMotion;
      startupAnimation = value.startupAnimation;
    }
  } catch { /* Preserve defaults on inaccessible or corrupt storage; the settings UI reports it. */ }
  const effectiveReducedMotion = reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.dataset.reducedMotion = String(effectiveReducedMotion);
  document.documentElement.dataset.startupAnimation = String(startupAnimation);
  const api = window.electronAPI;
  const nativeDesktop = ['startupPresentationPreferences', 'startupPresentationReady', 'startupPresentationFailed'].every(name => typeof api?.[name] === 'function');
  document.documentElement.dataset.nativeDesktop = String(nativeDesktop);
  if (nativeDesktop) {
    try { api.startupPresentationPreferences({ startupAnimation, reducedMotion: effectiveReducedMotion }); }
    catch { /* The native watchdog reveals the safe main surface if IPC is unavailable. */ }
  }
})();
