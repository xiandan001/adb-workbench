const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(t, { delayedLoad = false, fakeTimers = false } = {}) {
  const windows = [], handlers = new Map(), states = new Map(), starts = [], stops = [], inputs = [], logs = [];
  let generation = 1, callbacks, localeCallback, releaseLoad;
  const timers = [];
  const load = delayedLoad ? new Promise(resolve => { releaseLoad = resolve; }) : Promise.resolve();
  class Window extends EventEmitter {
    constructor() {
      super(); this.sent = []; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.send = (channel, data) => this.sent.push({ channel, data });
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    loadFile() { return load; }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
    setTitle(value) { this.title = value; }
    close() {
      let prevented = false; this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const streams = {
    async start(deviceId) {
      starts.push(deviceId);
      const state = { id: 'stream-' + deviceId, deviceId, status: 'streaming', width: 640, height: 360, sourceWidth: 1280, sourceHeight: 720 };
      states.set(state.id, state); callbacks.onState({ ...state, status: 'starting' });
      callbacks.onFrame(state.id, { timestamp: 1, flags: 1, data: Buffer.from([0, 0, 1, 0x65]) });
      return { success: true, session: state };
    },
    get: id => states.get(id),
    stop: async id => { stops.push(id); return { success: true }; },
    shutdownAll: async () => ({ success: true, failed: [] }), hasActiveStreams: () => false
  };
  const recordings = { list: () => [], stopAllRecordings: async () => ({ success: true, failed: [] }) };
  const overrides = {
    electron: { app: { getPath: () => process.cwd() }, BrowserWindow: Window },
    './localization.cjs': { tr: value => value, onLocaleChanged: fn => { localeCallback = fn; return () => {}; } },
    './harmony-media-labels.cjs': { mediaLabels: () => ({ title: 'Media', locale: 'en' }) },
    './harmony-media-diagnostics.cjs': require('../electron/lib/harmony-media-diagnostics.cjs'),
    './application-log.cjs': { record: event => logs.push(event) },
    './application-log-policy.cjs': require('../electron/lib/application-log-policy.cjs'),
    './harmony-media-session.cjs': { createHarmonyMediaSessions: options => { callbacks = options; return streams; } },
    './harmony-recording.cjs': { createHarmonyRecordingService: () => recordings },
    './device-registry.cjs': { resolveDeviceRef: id => ({ id, transport: 'hdc', generation, targetKey: id.slice(4) }) },
    './harmony-task-ui.cjs': { performHarmonyInput: async (...args) => { inputs.push(args); return { ok: true }; } },
    './harmony-media-input.cjs': require('../electron/lib/harmony-media-input.cjs')
  };
  const filename = path.join(__dirname, '../electron/lib/harmony-media-window.cjs');
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Buffer,
    setTimeout: fakeTimers ? (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; } : setTimeout,
    clearTimeout: fakeTimers ? timer => { if (timer) timer.cleared = true; } : clearTimeout,
    __dirname: path.dirname(filename), require: name => overrides[name] || require(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = module.exports;
  api.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  const invoke = (name, window, args, senderFrame = window.webContents.mainFrame) => handlers.get('harmony-media:' + name)(
    { sender: window.webContents, senderFrame }, args);
  t.after(() => api.shutdownAll());
  return { api, windows, starts, stops, inputs, logs, invoke, releaseLoad, timers,
    replaceDevice: () => { generation++; }, locale: () => localeCallback() };
}
async function readyWindow(h) {
  const opening = h.api.openWindow('hdc:A');
  const window = h.windows[0];
  await h.invoke('ready', window);
  await new Promise(resolve => setImmediate(resolve));
  return { opening, window };
}
async function ackDecoded(h, window) {
  const frame = window.sent.find(item => item.channel === 'harmony-media:frame').data;
  const ack = { sessionId: frame.sessionId, sequence: frame.sequence };
  assert.equal((await h.invoke('ack', window, ack)).success, true);
  assert.equal((await h.invoke('ack', window, { ...ack, decoded: true })).success, true);
}
test('device replacement while loadFile is pending rejects before native stream deployment', async t => {
  const h = fixture(t, { delayedLoad: true });
  const opening = h.api.openWindow('hdc:A');
  await h.invoke('ready', h.windows[0]);
  h.replaceDevice(); h.releaseLoad();
  const result = await opening;
  assert.equal(result.success, false); assert.match(result.error, /设备连接已变化/);
  assert.equal(h.starts.length, 0);
});
test('normal ACK followed by decoded ACK permits first-frame readiness without restarting on locale changes', async t => {
  const h = fixture(t);
  const { opening, window } = await readyWindow(h);
  await ackDecoded(h, window);
  assert.equal((await opening).success, true);
  h.locale(); h.locale();
  assert.equal(h.starts.length, 1);
  assert.equal(window.sent.filter(item => item.channel === 'harmony-media:locale').length, 2);
  assert.equal((await h.invoke('ack', window, { sessionId: 'other', sequence: 0, decoded: true })).success, false);
});

test('first-frame timeout uses bounded decoder stage metadata instead of losing missing-parameter evidence', async t => {
  const h = fixture(t, { fakeTimers: true });
  const { opening, window } = await readyWindow(h);
  const frame = window.sent.find(item => item.channel === 'harmony-media:frame').data;
  const ack = { sessionId: frame.sessionId, sequence: frame.sequence,
    diagnostic: { stage: 'waiting-configuration', received: 2, submitted: 0, keyframes: 1, sps: true, pps: false, codec: '' } };
  assert.equal((await h.invoke('ack', window, { ...ack, diagnostic: { ...ack.diagnostic, data: 'private-screen' } })).success, false);
  assert.equal((await h.invoke('ack', window, ack)).success, true);
  h.timers.filter(timer => timer.ms === 15000 && !timer.cleared).at(-1).fn();
  const result = await opening;
  assert.equal(result.success, false); assert.match(result.error, /初始化参数/);
});
test('cached view cannot be reused for the next device generation or send input to it', async t => {
  const h = fixture(t);
  const { opening, window } = await readyWindow(h);
  await ackDecoded(h, window); await opening;
  h.replaceDevice();
  const next = await h.api.openWindow('hdc:A');
  assert.equal(next.success, false); assert.match(next.error, /旧投屏窗口/);
  assert.equal(h.starts.length, 1); assert.equal(h.windows.length, 1);
  const control = await h.invoke('input', window, { type: 'tap', x: 0.5, y: 0.5 });
  assert.equal(control.success, false); assert.equal(h.inputs.length, 0);
});
test('renderer actions require the owning main frame and native input receives real coordinates/logical keys', async t => {
  const h = fixture(t);
  const { opening, window } = await readyWindow(h);
  await ackDecoded(h, window); await opening;
  const foreign = await h.invoke('input', window, { type: 'keyevent', key: 'home' }, {});
  assert.equal(foreign.success, false); assert.equal(h.inputs.length, 0);
  assert.equal((await h.invoke('input', window, { type: 'tap', x: 0.5, y: 0.5 })).success, true);
  assert.equal(h.inputs[0][2].x, 640); assert.equal(h.inputs[0][2].y, 360);
  assert.equal((await h.invoke('input', window, { type: 'keyevent', key: 'home' })).success, true);
  assert.equal(h.inputs[1][1].keyCode, 'Home');
});
test('media diagnostic IPC accepts only owned metadata and never logs device data or arbitrary text', async t => {
  const h = fixture(t), { opening, window } = await readyWindow(h);
  const count = h.logs.length;
  assert.equal((await h.invoke('diagnostic', window, { event: 'configure', message: 'SECRET' })).success, false);
  assert.equal((await h.invoke('diagnostic', window, { event: 'configure' }, {})).success, false);
  assert.equal((await h.invoke('diagnostic', window, { event: 'configure' }, null)).success, false);
  assert.equal(h.logs.length, count);
  assert.equal((await h.invoke('diagnostic', window, { event: 'configured', mode: 'software', codec: 'avc1.640028', width: 640, height: 360, supported: true })).success, true);
  assert.equal(h.logs.at(-1).source, 'media'); assert.equal(h.logs.at(-1).mode, 'software');
  assert.doesNotMatch(JSON.stringify(h.logs), /hdc:|SECRET|deviceId|stream-/);
  await ackDecoded(h, window); assert.equal((await opening).success, true);
});
