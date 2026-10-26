const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ast = parser.parse(source, { sourceType: 'script' });
function extract(select) {
  let found;
  traverse(ast, { enter({ node }) { const result = select(node); if (result) found = result; } });
  assert.ok(found);
  return '(' + source.slice(found.start, found.end) + ')';
}
const createSource = extract(node => node.type === 'FunctionDeclaration' && node.id.name === 'createWindow' ? node : null);
const secondSource = extract(node => node.type === 'CallExpression' && node.callee.property?.name === 'on' && node.arguments[0]?.value === 'second-instance' ? node.arguments[1] : null);
const cleanupSource = extract(node => node.type === 'FunctionDeclaration' && node.id.name === 'cleanupRuntimeResources' ? node : null);
const beforeQuitSource = extract(node => node.type === 'FunctionDeclaration' && node.id.name === 'cleanupBeforeQuit' ? node : null);

function harness() {
  const calls = []; const windows = []; const presentations = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter(); windows.push(this);
      this.menuVisible = true; this.menuVisibilityCalls = []; this.menuReplacements = [];
      this.webContents.getURL = () => 'file:///app/dist/index.html';
      this.webContents.openDevTools = () => calls.push('devtools');
    }
    loadFile(file) { this.menuVisibleAtLoad = this.menuVisible; calls.push('load:' + file); return Promise.resolve(); }
    loadURL(url) { this.menuVisibleAtLoad = this.menuVisible; calls.push('url:' + url); return Promise.resolve(); }
    setMenuBarVisibility(value) { this.menuVisible = value; this.menuVisibilityCalls.push(value); }
    setMenu(value) { this.menuReplacements.push(value); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() { calls.push('show'); }
    focus() { calls.push('focus'); }
  }
  const ctx = { setMainWindow(win) { ctx.current = win; calls.push('context'); }, getMainWindow: () => ctx.current, getLogAnalyzerWindow: () => null };
  const cleanupModule = label => ({ cleanup: () => calls.push(label) });
  const context = { BrowserWindow: Window, path, __dirname: path.resolve('electron'), ctx, isDev: false,
    localization: require('../electron/lib/localization.cjs'), tr: require('../electron/lib/localization.cjs').tr,
    feedback: { record() {}, cleanup() {} }, setTimeout, clearTimeout,
    startupPresentation: null, startupPresented: false, ipcMain: {}, screen: {}, console: { log() {} },
    createStartupPresentation({ mainWindow }) {
      assert.equal(ctx.current, mainWindow); calls.push('controller');
      const item = { reveals: 0, disposals: 0, reveal() { this.reveals++; calls.push('reveal'); }, dispose() { this.disposals++; calls.push('dispose'); } };
      presentations.push(item); return item;
    },
    startupSettings: cleanupModule('settings'), aiAnalyze: { resetAiState: () => {} }, aiWorkspace: cleanupModule('ai-workspace'), mcp: { closeMcpServer: () => {} },
    performanceMonitor: cleanupModule('performance'), taskCenter: cleanupModule('tasks'), deviceGuard: cleanupModule('guard'), adb: { stopAllShellProcs: () => {} },
  };
  vm.createContext(context);
  return { calls, windows, presentations, context, create: vm.runInContext(createSource, context), second: vm.runInContext(secondSource, context), cleanup: vm.runInContext(cleanupSource, context) };
}

test('first native window loads concurrently while hidden with unthrottled first frame and context before IPC', () => {
  const h = harness(); h.create();
  assert.equal(h.windows[0].options.show, false);
  assert.equal(h.windows[0].options.webPreferences.backgroundThrottling, false);
  assert.deepEqual(h.calls.slice(0, 2), ['context', 'controller']); assert.match(h.calls[2], /^load:/);
  assert.equal(h.presentations.length, 1);
});

test('subsequent created main windows do not replay native startup', () => {
  const h = harness(); h.create(); h.windows[0].emit('closed');
  assert.equal(h.presentations[0].disposals, 1); assert.equal(h.context.startupPresentation, null);
  h.create(); assert.equal(h.presentations.length, 1);
  assert.equal(h.windows[1].options.show, true); assert.equal(h.windows[1].options.webPreferences.backgroundThrottling, true);
});

test('main windows hide the native menu before loading without removing its Alt access or accelerator menu', () => {
  for (const isDev of [false, true]) {
    const h = harness(); h.context.isDev = isDev; h.create(); h.windows[0].emit('closed'); h.create();
    for (const window of h.windows) {
      assert.equal(window.options.autoHideMenuBar, true);
      assert.deepEqual(window.menuVisibilityCalls, [false]); assert.equal(window.menuVisibleAtLoad, false);
      assert.deepEqual(window.menuReplacements, [], 'hiding must not remove the application menu or its accelerators');
    }
  }
});

test('second-instance activation reveals the existing main and cancels the presentation instead of replaying', () => {
  const h = harness(); h.create(); h.second({}, [], '');
  assert.equal(h.presentations[0].reveals, 1); assert.deepEqual(h.calls.slice(-3), ['reveal', 'show', 'focus']);
  assert.equal(h.windows.length, 1);
});

test('confirmed quit disposes the presentation without revealing any window', () => {
  const h = harness(); h.create(); h.cleanup();
  assert.equal(h.presentations[0].disposals, 1); assert.equal(h.presentations[0].reveals, 0);
  assert.equal(h.context.startupPresentation, null);
  assert.ok(!h.calls.includes('show'));
});

test('confirmed quit cancels animation before awaiting potentially slow device cleanup', async () => {
  const h = harness(); h.create(); let finish;
  Object.assign(h.context, { appMessageDialog: { cleanup() {} }, aiTools: { cleanup: async () => {} },
    serial: { cleanup: () => new Promise(resolve => { finish = resolve; }) }, ssh: { cleanup: async () => {} },
    cleanupRuntimeResources: h.cleanup, cleanupAndroidToolProcesses: async () => {},
  });
  const pending = vm.runInContext(beforeQuitSource, h.context)();
  assert.equal(h.presentations[0].disposals, 1); assert.equal(h.context.startupPresentation, null);
  assert.equal(h.presentations[0].reveals, 0); await Promise.resolve(); finish(); await pending;
  assert.equal(h.presentations[0].disposals, 1);
});

test('regular preload exposes only fixed one-way startup signals, never overlay controls', () => {
  const sent = []; const exposed = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: { send: (...args) => sent.push(args) }, webUtils: {} }),
  });
  const api = exposed.electronAPI; const flags = { startupAnimation: true, reducedMotion: false };
  api.startupPresentationPreferences(flags); api.startupPresentationReady('ignored'); api.startupPresentationFailed('ignored');
  assert.deepEqual(sent, [['startup:prefs', flags], ['startup:ready'], ['startup:failed']]);
  assert.ok(!Object.keys(api).some(key => /overlay/i.test(key)));
});

test('a stalled optional diagnostic flush cannot block starting device cleanup or hold exit forever', async () => {
  const h = harness(); h.create(); let deadline; const cleaned = [];
  Object.assign(h.context, { feedback: { record() {}, cleanup: () => new Promise(() => {}) }, appMessageDialog: { cleanup() {} },
    aiTools: { cleanup: async () => cleaned.push('ai') }, serial: { cleanup: async () => cleaned.push('serial') }, ssh: { cleanup: async () => cleaned.push('ssh') },
    cleanupRuntimeResources: h.cleanup, cleanupAndroidToolProcesses: async () => cleaned.push('android'),
    setTimeout: (fn, ms) => { assert.equal(ms, 1000); deadline = fn; return 1; }, clearTimeout() {},
  });
  const pending = vm.runInContext(beforeQuitSource, h.context)();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(cleaned.includes('serial') && cleaned.includes('ssh') && cleaned.includes('ai'));
  assert.equal(typeof deadline, 'function'); deadline(); await pending; assert.ok(cleaned.includes('android'));
});
