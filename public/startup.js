/* Runs before the application module; only fixed lifecycle notifications, no data access. */
(() => {
  const stage = document.getElementById('app-startup');
  const root = document.getElementById('root');
  const status = document.getElementById('startup-status');
  const detail = document.getElementById('startup-detail');
  const retry = document.getElementById('startup-retry');
  if (!stage || !root || !status || !detail || !retry) return;
  const nativeDesktop = document.documentElement.dataset.nativeDesktop === 'true';
  let failureNotified = false;
  const notify = kind => {
    if (!nativeDesktop) return;
    if (kind === 'Failed') { if (failureNotified) return; failureNotified = true; }
    try { window.electronAPI?.[`startupPresentation${kind}`]?.(); }
    catch { /* Keep the readable fallback usable even if the native bridge exits. */ }
  };
  const animationEnabled = () => document.documentElement.dataset.startupAnimation !== 'false';
  if (!animationEnabled()) stage.hidden = true;
  let state = 'loading';
  const slowTimer = setTimeout(() => {
    if (state !== 'loading') return;
    state = 'slow'; stage.dataset.state = state;
    stage.hidden = false;
    status.textContent = '仍在准备工作区';
    detail.textContent = '启动比平时稍慢，可继续等待或重试。';
    retry.hidden = false;
    notify('Failed');
  }, 6000);
  const unexpectedError = event => {
    if (event?.target && event.target !== window && event.target.tagName !== 'SCRIPT') return;
    fail('工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。');
  };
  const detach = () => {
    clearTimeout(slowTimer);
    window.removeEventListener('error', unexpectedError, true);
  };
  function fail(message) {
    if (state === 'done' || state === 'leaving' || state === 'error') return;
    state = 'error'; detach(); stage.dataset.state = state; stage.setAttribute('role', 'alert');
    stage.hidden = false;
    status.textContent = '启动未完成';
    detail.textContent = message;
    retry.hidden = false; retry.focus();
    notify('Failed');
  }
  function complete() {
    if (state === 'done' || state === 'leaving' || state === 'error') return;
    state = 'leaving'; detach(); stage.dataset.state = state;
    stage.setAttribute('aria-hidden', 'true'); stage.setAttribute('inert', '');
    root.removeAttribute('inert'); root.setAttribute('aria-busy', 'false');
    performance.mark('workbench-startup-ready');
    const remove = () => { state = 'done'; stage.remove(); performance.mark('workbench-startup-finished'); };
    if (nativeDesktop) { remove(); notify('Ready'); }
    else if (!animationEnabled() || document.documentElement.dataset.reducedMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) remove();
    else setTimeout(remove, 180);
  }
  retry.addEventListener('click', () => { if (state === 'slow' || state === 'error') window.location.reload(); });
  window.addEventListener('error', unexpectedError, true);
  window.__workbenchStartup = Object.freeze({ complete, fail });
  performance.mark('workbench-startup-visible');
})();
