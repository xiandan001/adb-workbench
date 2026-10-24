/* Runs before the application module; only fixed lifecycle notifications, no data access. */
(() => {
  // This pre-bundle script localizes only its own fixed nodes, never application or user content.
  const messagesByLocale = {
    'en-US': {
      '卓控台': 'Veylo',
      '卓控台启动中': 'Starting Veylo',
      '连接设备 · 专注调试': 'Connect devices · Focus on debugging',
      '正在准备工作区': 'Preparing your workspace',
      '重新尝试': 'Try again',
      '仍在准备工作区': 'Still preparing your workspace',
      '启动比平时稍慢，可继续等待或重试。': 'Startup is taking longer than usual. You can wait or try again.',
      '工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。': 'The workspace could not finish loading. Try again, or restart the app if the problem persists.',
      '启动未完成': 'Startup incomplete',
    },
    'zh-TW': {
      '卓控台': '卓控臺',
      '卓控台启动中': '卓控臺啟動中',
      '连接设备 · 专注调试': '連接裝置 · 專注除錯',
      '正在准备工作区': '正在準備工作區',
      '重新尝试': '重試',
      '仍在准备工作区': '仍在準備工作區',
      '启动比平时稍慢，可继续等待或重试。': '啟動比平常稍慢，您可以繼續等待或重試。',
      '工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。': '工作區未能完成載入，請重試；若問題持續，請重新啟動應用程式。',
      '启动未完成': '啟動未完成',
    },
    'ja-JP': {
      '卓控台': 'Veylo',
      '卓控台启动中': 'Veylo を起動中',
      '连接设备 · 专注调试': 'デバイスを接続 · デバッグに集中',
      '正在准备工作区': 'ワークスペースを準備しています',
      '重新尝试': '再試行',
      '仍在准备工作区': '引き続きワークスペースを準備しています',
      '启动比平时稍慢，可继续等待或重试。': '起動に通常より時間がかかっています。そのまま待つか、再試行してください。',
      '工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。': 'ワークスペースを読み込めませんでした。再試行してください。問題が続く場合はアプリを再起動してください。',
      '启动未完成': '起動が完了していません',
    },
    'ko-KR': {
      '卓控台': 'Veylo',
      '卓控台启动中': 'Veylo 시작 중',
      '连接设备 · 专注调试': '기기 연결 · 디버깅에 집중',
      '正在准备工作区': '작업 공간을 준비하고 있습니다',
      '重新尝试': '다시 시도',
      '仍在准备工作区': '계속 작업 공간을 준비하고 있습니다',
      '启动比平时稍慢，可继续等待或重试。': '시작하는 데 평소보다 시간이 걸리고 있습니다. 기다리거나 다시 시도하세요.',
      '工作区未能完成加载，请重新尝试；如果问题持续，请重新启动应用。': '작업 공간을 불러오지 못했습니다. 다시 시도하세요. 문제가 계속되면 앱을 다시 시작하세요.',
      '启动未完成': '시작이 완료되지 않았습니다',
    },
  };
  const language = Object.hasOwn(messagesByLocale, window.electronAPI?.initialLanguage) ? window.electronAPI.initialLanguage : 'zh-CN';
  const messages = messagesByLocale[language];
  const tr = source => messages && Object.hasOwn(messages, source) ? messages[source] : source;
  document.documentElement.lang = language;
  document.title = tr('卓控台');
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
