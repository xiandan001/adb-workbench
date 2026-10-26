// A covered but still-visible workspace must keep its compositor surface ready.
// Explicitly hidden/minimized windows may sleep; restoring never reloads a page.
function attachWindowRenderContinuity(window, { schedule = setImmediate, cancel = clearImmediate } = {}) {
  let disposed = false;
  let throttled = false; // Matches the BrowserWindow's initial backgroundThrottling:false.
  let repaint = null;
  const listeners = [];
  const live = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed();
  const cancelRepaint = () => { if (repaint !== null) { cancel(repaint); repaint = null; } };
  const setThrottled = value => {
    if (!live() || value === throttled) return;
    window.webContents.setBackgroundThrottling(value); throttled = value;
  };
  const resume = () => {
    if (!live() || !window.isVisible() || window.isMinimized()) return;
    setThrottled(false);
    if (repaint !== null) return;
    repaint = schedule(() => {
      repaint = null;
      if (live() && window.isVisible() && !window.isMinimized()) window.webContents.invalidate();
    });
  };
  const suspend = () => { cancelRepaint(); setThrottled(true); };
  const listen = (source, name, callback) => { source.on(name, callback); listeners.push(() => source.removeListener(name, callback)); };
  const dispose = () => {
    if (disposed) return;
    disposed = true; cancelRepaint();
    for (const remove of listeners.splice(0)) remove();
  };
  for (const event of ['show', 'restore', 'focus']) listen(window, event, resume);
  for (const event of ['hide', 'minimize']) listen(window, event, suspend);
  listen(window, 'closed', dispose); listen(window.webContents, 'destroyed', dispose);
  return { dispose };
}

module.exports = { attachWindowRenderContinuity };
