/* Runs before the application module; only fixed lifecycle notifications, no data access. */
(() => {
  // This pre-bundle script localizes only its own fixed nodes, never application or user content.
  const language = window.electronAPI?.initialLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  const messages = {
    '卓控台启动中': 'Starting Workbench',
    '连接设备 · 专注调试': 'Connect devices · Focus on debugging',
    '正在准备工作区': 'Preparing your workspace',
    '重新尝试': 'Try again',
    '仍在准备工作区': 'Still preparing your workspace',
    '启动比平时稍慢，可继续等待或重试。': 'Startup is taking longer than usual. You can wait or try again.',
    '工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。': 'The workspace could not finish loading. Try again, or restart the app if the problem persists.',
    '启动未完成': 'Startup incomplete',
  };
  const tr = source => language === 'en-US' && Object.hasOwn(messages, source) ? messages[source] : source;
  const stage = document.getElementById('app-startup');
  const root = document.getElementById('root');
  const status = document.getElementById('startup-status');
  const detail = document.getElementById('startup-detail');
  const retry = document.getElementById('startup-retry');
  if (!stage || !root || !status || !detail || !retry) return;
  for (const node of [stage, ...(stage.querySelectorAll?.('[data-i18n],[data-i18n-label]') || [])]) {
    const textKey = node.getAttribute?.('data-i18n'); const labelKey = node.getAttribute?.('data-i18n-label');
    if (textKey) node.textContent = tr(textKey);
    if (labelKey) node.setAttribute('aria-label', tr(labelKey));
  }
  stage.setAttribute('aria-label', tr('卓控台启动中'));
  status.textContent = tr('正在准备工作区'); retry.textContent = tr('重新尝试');
  const tagline = stage.querySelector?.('.startup-brand p');
  if (tagline) tagline.textContent = tr('连接设备 · 专注调试');
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
    status.textContent = tr('仍在准备工作区');
    detail.textContent = tr('启动比平时稍慢，可继续等待或重试。');
    retry.hidden = false;
    notify('Failed');
  }, 6000);
  const unexpectedError = event => {
    if (event?.target && event.target !== window && event.target.tagName !== 'SCRIPT') return;
    fail(tr('工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。'));
  };
  const detach = () => {
    clearTimeout(slowTimer);
    window.removeEventListener('error', unexpectedError, true);
  };
  function fail(message) {
    if (state === 'done' || state === 'leaving' || state === 'error') return;
    state = 'error'; detach(); stage.dataset.state = state; stage.setAttribute('role', 'alert');
    stage.hidden = false;
    status.textContent = tr('启动未完成');
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
