const { randomUUID } = require('node:crypto');

function createLogCloseGuard({ getOwner, getActivity = () => false, getSourceIdentity = () => '', getPendingContent = () => false, timeoutMs = 300000 } = {}) {
  let owner = null, pending = null, bypass = null, disposed = false, quitting = false, approvalGeneration = 0, quitReviewId = '', inputLock = null;
  let state = { documentId: '', revision: 0, dirty: false, ready: false, sourceIdentity: '' };
  const issued = new WeakSet(), detach = [];
  const usable = window => window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed();
  const activeOwner = () => { const window = getOwner(); return usable(window) ? window : null; };
  const sourceIdentity = () => { try { const value = getSourceIdentity(); return typeof value === 'string' ? value : null; } catch { return null; } };
  const current = permit => permit?.owner === activeOwner() && permit.documentId === state.documentId && permit.revision === state.revision
    && permit.generation === approvalGeneration && permit.sourceIdentity === sourceIdentity();
  const authorized = event => usable(owner) && owner === getOwner() && event?.sender === owner.webContents && event.senderFrame && event.senderFrame === owner.webContents.mainFrame;
  const activity = () => { try { return Boolean(getActivity()); } catch { return true; } };
  const permit = (proceed, intent = 'quit', requestId = '') => {
    const result = { proceed, owner: activeOwner(), documentId: state.documentId, revision: state.revision, sourceIdentity: sourceIdentity(), generation: approvalGeneration, intent, requestId }; if (proceed) issued.add(result); return result;
  };
  function notifyCancelled(requestId) { if (requestId && usable(owner)) { try { owner.webContents.send('log:closeCancelled', { requestId }); } catch { /* An unavailable frame cannot authorize close. */ } } }
  function settle(proceed) {
    if (!pending) return;
    const item = pending; pending = null; clearTimeout(item.timer);
    if (proceed && item.intent === 'quit') quitReviewId = item.requestId;
    if (!proceed) notifyCancelled(item.requestId);
    item.resolve(permit(proceed, item.intent, item.requestId));
  }
  function ask(intent) {
    if (disposed) return Promise.resolve(permit(false, intent));
    if (!usable(owner)) return Promise.resolve(permit(true, intent));
    if ((!state.ready || state.sourceIdentity !== sourceIdentity()) && (state.dirty || activity() || getPendingContent())) return Promise.resolve(permit(false, intent));
    if (!state.dirty && !activity()) return Promise.resolve(permit(true, intent));
    if (pending) return pending.promise;
    let resolve; const promise = new Promise(done => { resolve = done; });
    const item = { requestId: randomUUID(), documentId: state.documentId, revision: state.revision, sourceIdentity: sourceIdentity(), intent, resolve, promise };
    item.timer = setTimeout(() => settle(false), timeoutMs); pending = item;
    try {
      if (owner.isMinimized?.()) owner.restore();
      if (owner.isVisible && !owner.isVisible()) owner.show(); owner.focus?.();
      owner.webContents.send('log:closeRequested', { requestId: item.requestId, documentId: item.documentId, revision: item.revision, intent });
    }
    catch { settle(false); }
    return promise;
  }
  function allowQuit(value) {
    if (!value?.proceed || !issued.has(value) || !current(value)) return false;
    if (value.intent === 'quit' && usable(value.owner) && value.owner.isEnabled?.() && value.owner.setEnabled) {
      value.owner.setEnabled(false); inputLock = value.owner;
    }
    issued.delete(value); bypass = value; quitting ||= value.intent === 'quit'; return true;
  }
  function releaseInputLock() {
    const window = inputLock; inputLock = null;
    if (usable(window)) window.setEnabled(true);
  }
  function attach(window) {
    if (owner === window) return;
    settle(false); for (const remove of detach.splice(0)) remove(); owner = window; bypass = null;
    state = { documentId: '', revision: 0, dirty: false, ready: false, sourceIdentity: '' }; approvalGeneration++; quitReviewId = '';
    if (!usable(window)) return;
    const closing = event => {
      if (bypass && current(bypass)) { bypass = null; return; }
      const unacknowledged = (!state.ready || state.sourceIdentity !== sourceIdentity()) && (state.dirty || activity() || getPendingContent());
      if (!state.dirty && !activity() && !unacknowledged) return;
      event.preventDefault(); if (pending) return;
      void ask('window').then(value => { if (allowQuit(value) && usable(window) && window === getOwner()) window.close(); });
    };
    const gone = () => { settle(false); notifyCancelled(quitReviewId); quitReviewId = ''; bypass = null; approvalGeneration++;
      state = { documentId: '', revision: 0, dirty: false, ready: false, sourceIdentity: '' }; };
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) gone(); };
    window.on('close', closing); window.on('closed', gone);
    window.webContents.on('render-process-gone', gone); window.webContents.on('did-start-navigation', navigation);
    detach.push(() => { window.removeListener('close', closing); window.removeListener('closed', gone);
      window.webContents.removeListener('render-process-gone', gone); window.webContents.removeListener('did-start-navigation', navigation); });
  }
  function update(event, value) {
    if (!authorized(event) || !value || !['dirty', 'documentId', 'revision'].every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => !['dirty', 'documentId', 'revision', 'sourceIdentity', 'ready'].includes(key)) || typeof value.documentId !== 'string'
      || !value.documentId || value.documentId.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(value.documentId)
      || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.dirty !== 'boolean'
      || value.ready !== undefined && typeof value.ready !== 'boolean' || (value.sourceIdentity ?? '') !== sourceIdentity()) return { accepted: false };
    if (value.revision < state.revision || value.revision === state.revision && state.documentId && value.documentId !== state.documentId) return { accepted: false };
    if (value.documentId !== state.documentId || value.revision !== state.revision) {
      settle(false); bypass = null; approvalGeneration++; notifyCancelled(quitReviewId); quitReviewId = '';
    }
    state = { ...value, ready: value.ready !== false, sourceIdentity: value.sourceIdentity ?? '' }; return { accepted: true };
  }
  function reply(event, value) {
    if (!authorized(event) || !pending || !value || Object.keys(value).sort().join(',') !== 'action,documentId,requestId,revision'
      || value.requestId !== pending.requestId || value.documentId !== pending.documentId || value.revision !== pending.revision
      || !['cancel', 'discard', 'saved'].includes(value.action)) return { accepted: false };
    if (value.action === 'cancel') { settle(false); return { accepted: true }; }
    if (state.documentId !== pending.documentId || state.revision !== pending.revision || pending.sourceIdentity !== sourceIdentity()) { settle(false); return { accepted: false }; }
    if (value.action === 'saved' && state.dirty) return { accepted: false };
    settle(true); return { accepted: true };
  }
  return { attach, update, reply, confirmQuit: () => ask('quit'), allowQuit, isQuitting: () => quitting,
    revokeQuit: () => { bypass = null; quitting = false; approvalGeneration++; releaseInputLock(); notifyCancelled(quitReviewId); quitReviewId = ''; },
    dispose() { disposed = true; settle(false); releaseInputLock(); for (const remove of detach.splice(0)) remove(); owner = null; bypass = null; } };
}

let guard;
function register(ipcMain, options) {
  guard = createLogCloseGuard(options);
  ipcMain.handle('log:documentState', (event, value) => guard.update(event, value));
  ipcMain.handle('log:closeDecision', (event, value) => guard.reply(event, value));
}
module.exports = { createLogCloseGuard, register, attach: window => guard?.attach(window),
  confirmQuit: () => guard ? guard.confirmQuit() : Promise.resolve(null), allowQuit: value => !guard || guard.allowQuit(value),
  revokeQuit: () => guard?.revokeQuit(), isQuitting: () => guard?.isQuitting() === true };
