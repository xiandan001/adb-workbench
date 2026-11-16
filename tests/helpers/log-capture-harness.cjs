const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

module.exports = function captureHarness(overrides = {}) {
  const handlers = new Map(), events = [], mainEvents = [], children = [], calls = [], timers = new Map(); let timer = 0;
  const owner = new EventEmitter(); owner.mainFrame = {}; owner.isDestroyed = () => false;
  owner.send = (channel, payload) => events.push({ channel, payload });
  const window = { webContents: owner, isDestroyed: () => false };
  const mainOwner = { mainFrame: {}, send: (channel, payload) => mainEvents.push({ channel, payload }), isDestroyed: () => false };
  const context = { isDev: false, broadcastToAllWindows: (channel, payload) => { owner.send(channel, payload); mainOwner.send(channel, payload); },
    getMainWindow: () => ({ webContents: mainOwner, isDestroyed: () => false }), getLogAnalyzerWindow: () => window };
  const adb = { runAdb: async args => { calls.push(args); return { ok: true, stdout: '' }; }, spawnAdb(args) {
    calls.push(args); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {}; children.push(child); return child;
  } };
  const filename = path.join(__dirname, '../../electron/lib/log-analyzer.cjs'), realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, __dirname: path.dirname(filename), Buffer, console,
    setTimeout: (callback, delay) => { const id = ++timer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timer, clearInterval() {},
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === 'electron') return { app: { getPath: () => overrides.userData }, dialog: overrides.dialog || {} };
      if (name === './app-context.cjs') return context;
      if (name === './adb-runtime.cjs') return adb;
      if (name === './log-sessions.cjs') return { register() {} };
      if (name === './auto-diagnose.cjs') return { autoDiagnoseOnLine() {}, resetAutoDiagnoseLastFire() {}, autoDiagnoseScanFile: async () => {} };
      return realRequire(name);
    } }, { filename });
  module.exports.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  return { api: module.exports, handlers, events, mainEvents, children, calls, owner, context, timers, event: { sender: owner, senderFrame: owner.mainFrame } };
};
