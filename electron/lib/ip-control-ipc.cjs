const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
let analysisSource;
function readAnalysisSnapshot(sessionId) { return analysisSource?.()?.snapshotForAnalysis(sessionId) ?? null; }
function isAnalysisSessionCurrent(sessionId) { return !!sessionId && analysisSource?.()?.currentSessionId() === sessionId; }

// The socket and its byte history belong to the current main-window document,
// not to a React route, a log window, or an iframe.
function registerIpControl(ipc, { getOwner, appRoot, isDev, createService, history }) {
  const page = pathToFileURL(resolve(appRoot, 'dist/index.html')).href;
  let active, disposed = false, historyRevision = 0, historyError = '';
  async function changeHistory(operation) {
    try {
      const result = await operation();
      historyError = result.ok ? '' : result.code;
      return result;
    } catch {
      historyError = 'HISTORY_UNAVAILABLE';
      return { ok: false, code: historyError };
    } finally { historyRevision++; }
  }
  function release() {
    const old = active;
    active = undefined;
    if (!old) return;
    old.contents.off('did-start-navigation', old.navigate);
    old.contents.off('render-process-gone', release);
    old.contents.off('destroyed', release);
    old.service.dispose();
  }
  function trusted(frame) {
    try {
      const url = new URL(frame.url);
      url.hash = '';
      return url.href === page || (isDev && url.href === 'http://localhost:5173/');
    } catch { return false; }
  }
  const denied = () => ({ ok: false, code: 'NOT_AUTHORIZED' });
  const ownedService = () => {
    const owner = getOwner();
    if (!active || disposed || !owner || owner.isDestroyed() || owner.webContents !== active.contents ||
      active.contents.isDestroyed() || active.frame !== active.contents.mainFrame || !trusted(active.frame)) return null;
    return active.service;
  };
  analysisSource = ownedService;
  for (const action of ['read', 'connect', 'send', 'disconnect', 'history', 'remove-history', 'clear-history', 'connection-status-subscribe']) {
    ipc.handle('ip-control:' + action, async (event, args) => {
      const owner = getOwner(), contents = owner?.webContents, frame = event.senderFrame;
      if (disposed || !owner || owner.isDestroyed() || !contents || contents.isDestroyed() ||
        contents !== event.sender || !frame || contents.mainFrame !== frame || !trusted(frame)) return denied();
      if (active?.frame !== frame || active.contents !== contents) {
        release();
        const navigate = details => { if (details.isMainFrame && !details.isSameDocument) release(); };
        active = { contents, frame, navigate, service: createService({
          onStatusChange(status) {
            if (active?.subscribed && active.contents === contents && active.frame === frame && !contents.isDestroyed() &&
              contents.mainFrame === frame && getOwner() === owner && owner.isVisible() && !owner.isMinimized()) contents.send('ip-control:connection-status', status);
          },
          onSuccessfulEndpoint: endpoint => changeHistory(() => history.record(endpoint))
        }) };
        contents.on('did-start-navigation', navigate);
        contents.once('render-process-gone', release);
        contents.once('destroyed', release);
      }
      const current = active;
      let result;
      if (action === 'connection-status-subscribe') {
        if (typeof args?.active !== 'boolean') return { success: false };
        current.subscribed = args.active;
        result = { success: true, status: current.service.connectionStatus() };
      } else if (action === 'history') {
        result = await history.list();
        if (historyError && result.ok) result = { ...result, error: historyError };
      } else if (action === 'remove-history') result = await changeHistory(() => history.remove(args));
      else if (action === 'clear-history') result = await changeHistory(() => history.clear());
      else {
        result = await current.service[action](args);
        if (action === 'read' && result.ok) result = { ...result, historyRevision };
      }
      return current === active ? result : denied();
    });
  }
  return () => { disposed = true; if (analysisSource === ownedService) analysisSource = undefined; release(); return history?.flush(); };
}
module.exports = { registerIpControl, readAnalysisSnapshot, isAnalysisSessionCurrent };
