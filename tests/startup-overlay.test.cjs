const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createStartupPresentation } = require('../electron/lib/startup-presentation.cjs');

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows = []; const ipcMain = new EventEmitter();
  class Window extends EventEmitter {
    constructor(config) {
      super(); if (options.constructorError && config) throw Error('fixture constructor');
      this.config = config; this.destroyed = false; this.shows = 0; this.inactiveShows = 0; this.focuses = 0;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => this.destroyed,
        sent: [], throttles: [], send: (...args) => this.webContents.sent.push(args),
        setBackgroundThrottling: value => this.webContents.throttles.push(value),
        setWindowOpenHandler: handler => { this.openHandler = handler; } });
      if (config) windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return options.bounds || { x: 1800, y: 100, width: 1600, height: 900 }; }
    show() { this.shows++; }
    showInactive() { this.inactiveShows++; }
    focus() { this.focuses++; }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    loadFile(file) { this.file = file; return options.loadReject ? Promise.reject(Error('fixture load')) : Promise.resolve(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const mainWindow = new Window(); const display = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const matches = []; const screen = { getDisplayMatching: bounds => { matches.push(bounds); return display; } };
  const api = createStartupPresentation({ BrowserWindow: Window, ipcMain, screen, mainWindow }); t.after(() => api.dispose());
  const emit = (channel, window = mainWindow, ...args) => ipcMain.emit(channel, { sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  const prefs = flags => emit('startup:prefs', mainWindow, flags === undefined ? { startupAnimation: true, reducedMotion: false } : flags);
  return { api, windows, mainWindow, screen, matches, ipcMain, emit, prefs, Window, tick: value => t.mock.timers.tick(value) };
}

test('enabled animation uses native transparent click-through display bounds and real relative main target', t => {
  const h = fixture(t); assert.equal(h.windows.length, 0); assert.equal(h.mainWindow.shows, 0);
  h.prefs(); const overlay = h.windows[0];
  assert.deepEqual(h.matches, [h.mainWindow.getBounds()]);
  for (const [key, value] of Object.entries({ x: 1920, y: 0, width: 1920, height: 1080, frame: false,
    transparent: true, backgroundColor: '#00000000', show: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, thickFrame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreen: false, fullscreenable: false, paintWhenInitiallyHidden: true })) assert.equal(overlay.config[key], value, key);
  assert.equal(overlay.ignoreMouse, true); assert.equal(overlay.config.webPreferences.nodeIntegration, false);
  assert.equal(overlay.config.webPreferences.contextIsolation, true); assert.equal(overlay.config.webPreferences.sandbox, true);
  assert.equal(overlay.config.webPreferences.devTools, false);
  assert.equal(overlay.config.webPreferences.preload, path.resolve(__dirname, '../electron/startup/preload.cjs'));
  assert.equal(overlay.file, path.resolve(__dirname, '../electron/startup/scene.html'));
  h.emit('startup:ready'); h.emit('startup-overlay:ready', overlay);
  assert.equal(overlay.inactiveShows, 1); assert.equal(overlay.focuses, 0); assert.equal(h.mainWindow.shows, 0);
  assert.deepEqual(overlay.webContents.sent, [['startup-overlay:play', { target: { x: -120, y: 100, width: 1600, height: 900 } }]]);
  h.tick(4400); assert.equal(h.mainWindow.shows, 0, 'elapsed time alone is not successful completion');
  h.emit('startup-overlay:finished', overlay);
  assert.equal(overlay.destroyed, true); assert.equal(h.mainWindow.shows, 1);
  assert.deepEqual(h.mainWindow.webContents.throttles, [true]);
});

test('disabled and reduced-motion modes wait only for the actual main frame and create no overlay', t => {
  const h = fixture(t); h.prefs({ startupAnimation: false, reducedMotion: false });
  assert.equal(h.windows.length, 0); h.tick(500); assert.equal(h.mainWindow.shows, 0);
  h.emit('startup:ready'); assert.equal(h.mainWindow.shows, 1);
});

test('a ready main frame before reduced-motion preferences opens immediately without deliberate delay', t => {
  const h = fixture(t); h.emit('startup:ready'); assert.equal(h.mainWindow.shows, 0);
  h.prefs({ startupAnimation: true, reducedMotion: true });
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows.length, 0);
});

test('foreign windows and subframes cannot send prefs, readiness, failure or overlay completion', t => {
  const h = fixture(t); const foreign = new h.Window();
  for (const channel of ['startup:prefs', 'startup:ready', 'startup:failed']) {
    const args = channel === 'startup:prefs' ? [{ startupAnimation: true, reducedMotion: false }] : [];
    h.emit(channel, foreign, ...args);
    h.ipcMain.emit(channel, { sender: h.mainWindow.webContents, senderFrame: {} }, ...args);
  }
  assert.equal(h.windows.length, 0); assert.equal(h.mainWindow.shows, 0);
  h.prefs(); const overlay = h.windows[0];
  for (const channel of ['startup-overlay:ready', 'startup-overlay:finished']) {
    h.emit(channel, foreign); h.emit(channel, h.mainWindow);
    h.ipcMain.emit(channel, { sender: overlay.webContents, senderFrame: {} });
  }
  assert.equal(overlay.inactiveShows, 0); assert.equal(h.mainWindow.shows, 0);
  h.emit('startup-overlay:finished', overlay); assert.equal(h.mainWindow.shows, 0, 'cannot finish before play');
  h.emit('startup-overlay:ready', overlay); assert.equal(overlay.inactiveShows, 1);
});

test('invalid and repeated payloads cannot override the first validated preferences or replay', t => {
  const h = fixture(t);
  for (const value of [null, [], {}, { startupAnimation: 1, reducedMotion: false }, { startupAnimation: true, reducedMotion: false, extra: true }]) h.prefs(value);
  assert.equal(h.windows.length, 0); h.prefs();
  const overlay = h.windows[0]; h.prefs({ startupAnimation: false, reducedMotion: true });
  h.emit('startup-overlay:ready', overlay, { forged: true }); assert.equal(overlay.inactiveShows, 0);
  h.emit('startup-overlay:ready', overlay); h.emit('startup-overlay:ready', overlay);
  assert.equal(overlay.inactiveShows, 1); assert.equal(h.windows.length, 1);
  h.emit('startup-overlay:finished', overlay); h.prefs(); h.api.reveal(); h.tick(20000);
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows.length, 1);
});

test('normal animation completion reveals even a slow main renderer static loading page', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0];
  h.emit('startup-overlay:ready', overlay); h.emit('startup-overlay:finished', overlay);
  assert.equal(h.mainWindow.shows, 1); assert.equal(overlay.destroyed, true);
});

test('overlay load timeout fails open at two seconds and ignores late ready events', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0];
  h.tick(1999); assert.equal(h.mainWindow.shows, 0); h.tick(1);
  assert.equal(h.mainWindow.shows, 1); assert.equal(overlay.destroyed, true);
  h.emit('startup-overlay:ready', overlay); assert.equal(overlay.inactiveShows, 0);
});

test('play watchdog fails open at 5.4 seconds without requiring renderer completion', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0]; h.emit('startup-overlay:ready', overlay);
  h.tick(5399); assert.equal(h.mainWindow.shows, 0); h.tick(1);
  assert.equal(h.mainWindow.shows, 1); assert.equal(overlay.destroyed, true);
});

test('total concealment is capped at ten seconds even without preferences or main readiness', t => {
  const h = fixture(t); h.tick(9999); assert.equal(h.mainWindow.shows, 0); h.tick(1);
  assert.equal(h.mainWindow.shows, 1); h.prefs(); assert.equal(h.windows.length, 0);
});

test('late valid preferences cannot extend the total ten-second concealment bound', t => {
  const h = fixture(t); h.tick(9500); h.prefs(); const overlay = h.windows[0]; h.emit('startup-overlay:ready', overlay);
  h.tick(499); assert.equal(h.mainWindow.shows, 0); h.tick(1);
  assert.equal(h.mainWindow.shows, 1); assert.equal(overlay.destroyed, true); h.tick(10000); assert.equal(h.mainWindow.shows, 1);
});

test('overlay construction and asynchronous load errors fail open', async t => {
  const h = fixture(t, { constructorError: true }); h.prefs(); assert.equal(h.mainWindow.shows, 1);
});

test('rejected overlay loading fails open without an unhandled rejection', async t => {
  const h = fixture(t, { loadReject: true }); h.prefs(); await Promise.resolve();
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows[0].destroyed, true);
});

test('main bootstrap failure and overlay renderer failure release the main window', t => {
  const h = fixture(t); h.prefs(); h.emit('startup:failed');
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows[0].destroyed, true);
});

test('native overlay renderer crash and load failure share idempotent fail-open', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0];
  overlay.webContents.emit('render-process-gone'); overlay.webContents.emit('did-fail-load');
  assert.equal(h.mainWindow.shows, 1); assert.equal(overlay.destroyed, true);
});

test('main native load failure opens its fallback without waiting for a renderer handshake', t => {
  const h = fixture(t); h.mainWindow.webContents.emit('did-fail-load');
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows.length, 0); h.tick(20000); assert.equal(h.mainWindow.shows, 1);
});

test('overlay closing unexpectedly reveals the main window once', t => {
  const h = fixture(t); h.prefs(); h.windows[0].destroy(); h.tick(20000);
  assert.equal(h.mainWindow.shows, 1);
});

test('invalid native target dimensions fail open without creating a giant or malformed overlay', t => {
  const h = fixture(t, { bounds: { x: 0, y: 0, width: Infinity, height: 900 } }); h.prefs();
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows.length, 0);
});

test('overlay navigation and new windows are blocked without granting application privileges', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0]; let prevented = false;
  overlay.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(overlay.openHandler({ url: 'https://example.invalid' }), { action: 'deny' });
});

test('dispose and closed main windows destroy the overlay without revealing during quit', t => {
  const h = fixture(t); h.prefs(); const overlay = h.windows[0]; h.emit('startup-overlay:ready', overlay);
  h.api.dispose(); h.api.dispose(); h.api.reveal(); h.tick(20000);
  assert.equal(overlay.destroyed, true); assert.equal(h.mainWindow.shows, 0);
  for (const name of ['startup:prefs', 'startup:ready', 'startup:failed', 'startup-overlay:ready', 'startup-overlay:finished']) assert.equal(h.ipcMain.listenerCount(name), 0);
});

test('unexpected main closure cleans all pending startup work without showing another window', t => {
  const h = fixture(t); h.prefs(); h.mainWindow.destroy(); h.tick(20000);
  assert.equal(h.windows[0].destroyed, true); assert.equal(h.mainWindow.shows, 0);
});

test('dispose before preferences rejects all later startup signals without any extra window', t => {
  const h = fixture(t); h.api.dispose(); h.prefs(); h.emit('startup:ready'); h.api.reveal(); h.tick(20000);
  assert.equal(h.windows.length, 0); assert.equal(h.mainWindow.shows, 0);
});

test('explicit second activation reveal cancels animation and never replays or focuses overlay', t => {
  const h = fixture(t); h.prefs(); h.api.reveal(); h.api.reveal(); h.tick(20000);
  assert.equal(h.mainWindow.shows, 1); assert.equal(h.windows[0].destroyed, true); assert.equal(h.windows[0].focuses, 0);
});
