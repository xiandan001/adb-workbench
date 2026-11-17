const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { parse } = require('@babel/parser');

function fixture() {
  const filename = path.resolve(__dirname, '../electron/lib/log-analyzer.cjs'), source = fs.readFileSync(filename, 'utf8'), realRequire = createRequire(filename);
  const node = parse(source, { sourceType: 'script' }).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'createLogAnalyzerWindow');
  const windows = [], records = [], questions = []; let owner = null, resets = 0, stops = 0, answer = 1, sourceIdentity = 'source-A', loadFailure = false;
  const main = { visible: false, minimized: true, focused: false, isDestroyed: () => false, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; }, show() { this.visible = true; }, focus() { this.focused = true; } };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.visible = true; this.minimized = false; this.loads = 0; this.focuses = 0;
      this.webContents = Object.assign(new EventEmitter(), { dead: false, crashed: false, isDestroyed: () => this.webContents.dead, isCrashed: () => this.webContents.crashed,
        setBackgroundThrottling() {}, invalidate: () => { this.repainted = true; }, send() {} }); windows.push(this);
    }
    isDestroyed() { return this.dead; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    setMenu() {} setTitle() {} show() { this.visible = true; } restore() { this.minimized = false; this.visible = true; } focus() { this.focuses++; }
    loadFile() { this.loads++; this.webContents.crashed = false; return loadFailure ? Promise.reject(new Error('private path')) : Promise.resolve(); }
    loadURL() { return this.loadFile(); }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const context = { path, __dirname: path.dirname(filename), tr: text => text, windowArguments: () => [], onLocaleChanged: () => () => {}, isDev: false,
    ctx: { getLogAnalyzerWindow: () => owner, getMainWindow: () => main, setLogAnalyzerWindow: value => { owner = value; } }, captureEpoch: 0, cancelPendingImport() {}, finishCaptureLine: null,
    archiveSession: null, logcatProc: null, getSourceIdentity: () => sourceIdentity, stopPidPackageResolver: () => { stops++; }, clearLogBatchState() {}, resetLogStoreSource: () => { resets++; },
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window };
      if (name === './log-window-close.cjs') return { isQuitting: () => false, attach() {} };
      if (name === './auto-diagnose.cjs') return { resetAutoDiagnoseLastFire() {} };
      if (name === './ai-analyze.cjs') return { abortAiRequest() { stops++; }, clearAiConversation() {} };
      if (name === './application-log.cjs') return { record: value => records.push(value) };
      if (name === './app-message-dialog.cjs') return { ask: async value => { questions.push(value); return typeof answer === 'function' ? answer() : { response: answer }; } };
      return realRequire(name);
    } };
  vm.createContext(context); vm.runInContext(source.slice(node.start, node.end) + ';globalThis.open=createLogAnalyzerWindow', context, { filename });
  return { open: context.open, windows, records, questions, main, owner: () => owner, resets: () => resets, stops: () => stops, answer: value => { answer = value; },
    source: value => { sourceIdentity = value; }, failLoad: value => { loadFailure = value; },
    lifecycle: window => realRequire('./log-window-lifecycle.cjs').getLogWindowLifecycle(window) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('actual log factory reuses a healthy unsaved window and resumes a minimized or hidden owner without reloading', async () => {
  const h = fixture(), first = h.open(); await settle(); first.visible = false; first.minimized = true;
  assert.equal(h.open(), first); assert.equal(h.windows.length, 1); assert.equal(first.loads, 1);
  assert.equal(first.visible, true); assert.equal(first.minimized, false); assert.equal(first.options.webPreferences.backgroundThrottling, false);
  assert.equal(h.resets(), 0); assert.equal(h.stops(), 0); assert.equal(h.questions.length, 0);
});
test('a renderer failure uses an explicit custom retry, preserves main caches and does not loop or automatically start services', async () => {
  const h = fixture(), first = h.open(); await settle();
  first.webContents.crashed = true; first.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 }); await settle();
  assert.equal(h.questions.length, 1); assert.equal(first.loads, 1); assert.equal(h.resets(), 0); assert.equal(h.stops(), 0);
  h.answer(0); assert.equal(h.open(), first); await settle(); assert.equal(first.loads, 2); assert.equal(h.windows.length, 1);
  assert.ok(h.records.some(item => item.event === 'renderer-gone' && item.component === 'log-window'));
  first.webContents.emit('did-finish-load'); await settle(); assert.equal(first.loads, 2);
});
test('a late closed callback from an obsolete window cannot clear the new owner reference, source caches or running operation', async () => {
  const h = fixture(), old = h.open(); old.dead = true; const current = h.open(); assert.notEqual(current, old);
  old.emit('closed'); assert.equal(h.owner(), current); assert.equal(h.resets(), 0); assert.equal(h.stops(), 0);
  current.dead = true; current.emit('closed'); assert.equal(h.owner(), null); assert.equal(h.resets(), 2);
});
test('main-frame load failure is classified without URLs or error text and cancel never reloads the failed page', async () => {
  const h = fixture(), first = h.open(); await settle();
  first.webContents.emit('did-fail-load', {}, -2, 'secret device log', 'file:///private/profile', false); await settle(); assert.equal(h.questions.length, 0);
  first.webContents.emit('did-fail-load', {}, -2, 'secret device log', 'file:///private/profile', true); await settle();
  assert.equal(h.questions.length, 1); assert.equal(first.loads, 1); assert.ok(h.records.some(item => item.event === 'load-failed'));
  assert.doesNotMatch(JSON.stringify(h.records), /secret|private|file:/); assert.equal(h.resets(), 0);
});
test('the bounded application log policy keeps the fixed log-window component but drops arbitrary payloads', () => {
  const { normalizeApplicationLogEvent } = require('../electron/lib/application-log-policy.cjs');
  assert.deepEqual(normalizeApplicationLogEvent({ source: 'app', event: 'load-failed', component: 'log-window', errorCode: 'UNKNOWN', url: 'private', raw: 'secret' }),
    { source: 'app', event: 'load-failed', component: 'log-window', errorCode: 'UNKNOWN' });
});
test('native close and repeated open share one custom failure review and only explicit discard destroys the exact failed owner', async () => {
  const h = fixture(), window = h.open(); await settle(); let answer; h.answer(() => new Promise(resolve => { answer = resolve; }));
  window.webContents.emit('render-process-gone', {}, { exitCode: 4 }); await settle();
  const pending = h.lifecycle(window).review(); let prevented = false;
  window.emit('close', { preventDefault() { prevented = true; } }); h.open(); await settle();
  assert.equal(prevented, true); assert.equal(h.questions.length, 1); assert.equal(h.resets(), 0);
  assert.equal(h.questions[0].defaultId, 0); assert.equal(h.questions[0].cancelId, 1); assert.equal(h.questions[0].buttons.length, 3);
  answer({ response: 2 }); assert.equal(await pending, true); assert.equal(h.owner(), null); assert.equal(h.resets(), 2);
});
test('a source change or renderer recovery during the custom review fences its late discard and does not claim the new window was closed', async () => {
  for (const change of ['source', 'recovered', 'retry-navigation']) {
    const h = fixture(), window = h.open(); await settle(); let answer; h.answer(() => new Promise(resolve => { answer = resolve; }));
    window.webContents.emit('render-process-gone', {}, {}); await settle(); const pending = h.lifecycle(window).review();
    if (change === 'source') h.source('source-B');
    if (change === 'recovered') h.lifecycle(window).ready();
    if (change === 'retry-navigation') window.webContents.emit('did-start-navigation', {}, 'file:///fixed-log-window.html', false, true);
    answer({ response: 2 }); assert.equal(await pending, false, change); assert.equal(window.dead, false, change); assert.equal(h.resets(), 0, change);
    window.dead = true; window.emit('closed');
  }
});
test('a rejected actual load promise is caught once without an automatic reload loop or private error text', async () => {
  const h = fixture(); h.failLoad(true); const window = h.open(); await settle(); await settle();
  assert.equal(window.loads, 1); assert.equal(h.questions.length, 1); assert.equal(h.resets(), 0); assert.doesNotMatch(JSON.stringify(h.records), /private path/);
  window.dead = true; window.emit('closed');
});
test('renderer startup notifications execute only for the current log owner and exact top frame, never the main window or an old frame', () => {
  const filename = path.resolve(__dirname, '../electron/lib/log-analyzer.cjs'), source = fs.readFileSync(filename, 'utf8');
  const registration = parse(source, { sourceType: 'script' }).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'register');
  const callback = registration.body.body[0].body.expression.arguments[1];
  let count = 0; const owner = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  const notify = vm.runInNewContext('(' + source.slice(callback.start, callback.end) + ')', { method: 'ready',
    ctx: { getLogAnalyzerWindow: () => owner }, require: () => ({ getLogWindowLifecycle: () => ({ ready: () => { count++; } }) }) });
  notify({ sender: owner.webContents, senderFrame: {} }); notify({ sender: {}, senderFrame: owner.webContents.mainFrame });
  assert.equal(count, 0); notify({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }); assert.equal(count, 1);
});
test('only app log-window events accept the four bounded lifecycle stages', () => {
  const { normalizeApplicationLogEvent } = require('../electron/lib/application-log-policy.cjs');
  for (const stage of ['loading', 'document-loaded', 'renderer-ready', 'renderer-failed']) {
    assert.equal(normalizeApplicationLogEvent({ source: 'app', event: 'ready', component: 'log-window', stage }).stage, stage);
    assert.equal(normalizeApplicationLogEvent({ source: 'app', event: 'ready', component: 'renderer', stage }).stage, undefined);
  }
  assert.equal(normalizeApplicationLogEvent({ source: 'app', event: 'ready', component: 'log-window', stage: 'raw secret' }).stage, undefined);
});
test('the existing custom failure question restores and focuses its Main host instead of being hidden behind a blank log window', async () => {
  const h = fixture(), window = h.open(); await settle(); assert.equal(h.main.focused, false);
  window.webContents.emit('render-process-gone', {}, {}); await settle();
  assert.equal(h.main.visible, true); assert.equal(h.main.minimized, false); assert.equal(h.main.focused, true);
});
test('a repeated native close while the custom question is pending reveals the same Main question again without queuing another', async () => {
  const h = fixture(), window = h.open(); await settle(); let resolve; h.answer(() => new Promise(done => { resolve = done; }));
  window.webContents.emit('render-process-gone', {}, {}); await settle(); assert.equal(h.main.focused, true);
  h.main.focused = false; window.emit('close', { preventDefault() {} }); await settle();
  assert.equal(h.main.focused, true); assert.equal(h.questions.length, 1); resolve({ response: 1 }); await settle();
});
