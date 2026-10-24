const { tr } = require('./localization.cjs');
function createSshShortcutGuard({ getOwner, isTerminalReady }) {
  let focused = null;
  let disposed = false;
  const watched = new WeakSet();
  function reset(contents) {
    if (!focused || contents && focused.contents !== contents) return;
    const previous = focused; focused = null;
    try { if (!previous.contents.isDestroyed?.()) previous.contents.setIgnoreMenuShortcuts(false); } catch { /* Window may have already closed. */ }
  }
  function set({ sessionId, terminalId, focused: enabled } = {}, sender) {
    const owner = getOwner();
    if (disposed || !owner || owner.isDestroyed() || owner.webContents !== sender || typeof enabled !== 'boolean') throw new Error(tr("SSH 终端焦点状态无效"));
    if (!enabled) {
      if (focused?.sessionId === sessionId && focused?.terminalId === terminalId) reset(sender);
      return;
    }
    if (typeof sessionId !== 'string' || typeof terminalId !== 'string' || !isTerminalReady(sessionId, terminalId)
      || owner.isVisible?.() === false || owner.isMinimized?.() === true) throw new Error(tr("当前 SSH 终端不可输入"));
    if (focused?.contents !== sender) reset();
    focused = { sessionId, terminalId, contents: sender };
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.on('did-start-loading', () => reset(sender));
      sender.on('render-process-gone', () => reset(sender));
      sender.once('destroyed', () => reset(sender));
      owner.on('blur', () => reset(sender));
      owner.once('closed', () => reset(sender));
    }
    sender.setIgnoreMenuShortcuts(true);
  }
  function validate() {
    if (focused && !isTerminalReady(focused.sessionId, focused.terminalId)) reset();
  }
  return { set, validate, reset, clearSession: id => { if (focused?.sessionId === id) reset(); }, dispose: () => { reset(); disposed = true; } };
}

module.exports = { createSshShortcutGuard };
