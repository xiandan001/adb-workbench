const { tr } = require('./localization.cjs');
const { attachWindowRenderContinuity } = require('./window-render-continuity.cjs');

const controllers = new WeakMap();
function attachLogWindowLifecycle(window, { load, isCurrent, getSourceIdentity, record, ask, focusReviewHost = () => {}, readyTimeoutMs = 30000 }) {
  let disposed = false, failed = false, loading = false, attempt = 0, timer = null, pending = null;
  const removers = [], continuity = attachWindowRenderContinuity(window);
  const current = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed() && isCurrent();
  const log = (event, stage, extra = {}) => {
    try { record({ source: 'app', component: 'log-window', event, stage, ...extra }); } catch { /* Diagnostics cannot break recovery. */ }
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const reveal = () => { if (!current()) return; if (window.isMinimized?.()) window.restore(); if (!window.isVisible?.()) window.show(); window.focus(); };
  async function review() {
    if (!failed || !current()) return !failed;
    try { focusReviewHost(); } catch { /* An unavailable host cannot authorize discarding content. */ }
    if (pending) return pending;
    const reviewedAttempt = attempt, source = getSourceIdentity();
    pending = Promise.resolve().then(() => ask({ type: 'warning', title: tr('日志助手未能显示'),
      message: tr('日志窗口未能正常显示，可以重新加载。不会自动开始采集或调用 AI。'),
      detail: tr('重试会保留已加载的日志。放弃并关闭会停止本次采集，并丢弃此窗口未保存的内容；已保存的文件不受影响。'),
      buttons: [tr('重试加载'), tr('保留窗口'), tr('放弃未保存日志并关闭')], defaultId: 0, cancelId: 1 }))
      .then(answer => {
        if (!current() || !failed || attempt !== reviewedAttempt || source !== getSourceIdentity()) return false;
        if (answer?.response === 0) { beginLoad(); return false; }
        if (answer?.response === 2) { window.destroy(); return true; }
        return false;
      }).catch(() => false).finally(() => { pending = null; });
    return pending;
  }
  function failure(event = 'load-failed', extra = {}) {
    if (!current() || failed) return;
    failed = true; loading = false; clearTimer(); log(event, 'renderer-failed', { level: 'error', errorCode: 'UNKNOWN', ...extra }); void review();
  }
  function beginAttempt() {
    if (!current()) return;
    failed = false; loading = true; clearTimer(); const ticket = ++attempt;
    log('startup', 'loading'); timer = setTimeout(() => { if (ticket === attempt) failure('load-failed', { errorCode: 'TIMEOUT' }); }, readyTimeoutMs);
    timer.unref?.();
    return ticket;
  }
  function beginLoad() {
    const ticket = beginAttempt(); if (ticket === undefined) return;
    try { Promise.resolve(load()).catch(() => { if (ticket === attempt) failure(); }); } catch { failure(); }
  }
  const listen = (target, name, callback) => { target.on(name, callback); removers.push(() => target.removeListener(name, callback)); };
  const controller = { load: beginLoad,
    open() { reveal(); if (window.webContents.isCrashed?.()) failure('renderer-gone'); if (failed) void review(); },
    ready() { if (current()) { failed = false; loading = false; clearTimer(); log('ready', 'renderer-ready'); } },
    failed: () => failed, failure: () => failure('renderer-error'), review,
    dispose() { disposed = true; clearTimer(); continuity.dispose(); for (const remove of removers.splice(0)) remove(); controllers.delete(window); } };
  listen(window.webContents, 'did-finish-load', () => { if (current()) log('ready', 'document-loaded'); });
  listen(window.webContents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace && !loading) beginAttempt(); });
  listen(window.webContents, 'did-fail-load', (_event, code, _text, _url, mainFrame) => { if (mainFrame !== false && code !== -3) failure('load-failed', { errorNumber: Math.abs(code || 0) }); });
  listen(window.webContents, 'render-process-gone', (_event, details) => failure('renderer-gone', { errorNumber: Math.abs(details?.exitCode || 0) }));
  listen(window, 'close', event => { if (failed && current()) { event.preventDefault(); void review(); } });
  listen(window, 'closed', () => controller.dispose()); controllers.set(window, controller); return controller;
}
module.exports = { attachLogWindowLifecycle, getLogWindowLifecycle: window => controllers.get(window) };
