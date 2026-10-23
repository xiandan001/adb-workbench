const path = require('node:path');
const { types } = require('node:util');

function validPreferences(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.length === 2 && keys.every(key => ['startupAnimation', 'reducedMotion'].includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value') && typeof descriptors[key].value === 'boolean');
}

function validRectangle(value) {
  return value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) <= 100000)
    && value.width > 0 && value.height > 0;
}

function createStartupPresentation({ BrowserWindow, ipcMain, screen, mainWindow }) {
  let ended = false; let preferences; let mainReady = false; let overlay; let playing = false;
  let loadTimer; let playTimer;
  const listeners = [];
  const totalTimer = setTimeout(reveal, 10000);
  const listen = (source, name, handler) => { source.on(name, handler); listeners.push(() => source.removeListener(name, handler)); };
  function owns(event, window) {
    return !ended && window && !window.isDestroyed() && !window.webContents.isDestroyed()
      && window.webContents.mainFrame && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  }
  function cleanup() {
    clearTimeout(totalTimer); clearTimeout(loadTimer); clearTimeout(playTimer);
    for (const detach of listeners.splice(0)) detach();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = undefined;
  }
  function reveal() {
    if (ended) return;
    ended = true; cleanup();
    if (!mainWindow.isDestroyed()) {
      if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(true);
      mainWindow.show();
    }
  }
  function dispose() {
    if (ended) return;
    ended = true; cleanup();
  }
  function createOverlay() {
    try {
      const mainBounds = mainWindow.getBounds();
      const displayBounds = screen.getDisplayMatching(mainBounds).bounds;
      const target = { x: mainBounds.x - displayBounds.x, y: mainBounds.y - displayBounds.y, width: mainBounds.width, height: mainBounds.height };
      if (!validRectangle(displayBounds) || !validRectangle(target)) { reveal(); return; }
      overlay = new BrowserWindow({ ...displayBounds, frame: false, transparent: true, backgroundColor: '#00000000',
        show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, thickFrame: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreen: false, fullscreenable: false,
        paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, '../startup/preload.cjs'), nodeIntegration: false,
          contextIsolation: true, sandbox: true, devTools: false, backgroundThrottling: false } });
      overlay.setIgnoreMouseEvents(true);
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      listen(overlay.webContents, 'will-navigate', event => event.preventDefault());
      listen(overlay.webContents, 'did-fail-load', reveal);
      listen(overlay.webContents, 'render-process-gone', reveal);
      listen(overlay, 'closed', reveal);
      listen(ipcMain, 'startup-overlay:ready', (event, ...args) => {
        if (args.length || !owns(event, overlay) || playing) return;
        playing = true; clearTimeout(loadTimer);
        try {
          overlay.showInactive();
          playTimer = setTimeout(reveal, 5400);
          overlay.webContents.send('startup-overlay:play', { target });
        } catch { reveal(); }
      });
      listen(ipcMain, 'startup-overlay:finished', (event, ...args) => {
        if (!args.length && playing && owns(event, overlay)) reveal();
      });
      loadTimer = setTimeout(reveal, 2000);
      Promise.resolve(overlay.loadFile(path.join(__dirname, '../startup/scene.html'))).catch(reveal);
    } catch { reveal(); }
  }
  listen(ipcMain, 'startup:prefs', (event, ...args) => {
    if (!owns(event, mainWindow) || preferences || args.length !== 1 || !validPreferences(args[0])) return;
    preferences = { ...args[0] };
    if (preferences.startupAnimation && !preferences.reducedMotion) createOverlay();
    else if (mainReady) reveal();
  });
  listen(ipcMain, 'startup:ready', (event, ...args) => {
    if (args.length || !owns(event, mainWindow)) return;
    mainReady = true;
    if (preferences && (!preferences.startupAnimation || preferences.reducedMotion)) reveal();
  });
  listen(ipcMain, 'startup:failed', (event, ...args) => { if (!args.length && owns(event, mainWindow)) reveal(); });
  listen(mainWindow, 'closed', dispose);
  listen(mainWindow.webContents, 'did-fail-load', reveal);
  listen(mainWindow.webContents, 'render-process-gone', reveal);
  return { reveal, dispose };
}

module.exports = { createStartupPresentation };
