const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLogCaptureBuffer } = require('../electron/lib/log-capture-buffer.cjs');

test('rolling storage retains the exact latest count in order through repeated wraparound', () => {
  const store = createLogCaptureBuffer({ maxEntries: 3, maxBytes: 100 });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(store.push({ raw: String(index), id: index }), Math.min(index, 2));
    assert.deepEqual(store.toArray().map(entry => entry.id), Array.from({ length: Math.min(index + 1, 3) }, (_, offset) => Math.max(0, index - 2) + offset));
  }
  assert.equal(store.length, 3);
  assert.equal(store.bytes, 6);
  assert.equal(store.truncated, true);
  const snapshot = store.toArray();
  assert.equal(store.toArray(), snapshot);
  store.push({ raw: '20', id: 20 });
  assert.deepEqual(snapshot.map(entry => entry.id), [17, 18, 19]);
  assert.notEqual(store.toArray(), snapshot);
});

test('byte cap counts UTF-8 and rejects oversized records with explicit truncation', () => {
  const store = createLogCaptureBuffer({ maxEntries: 10, maxBytes: 10 });
  store.push({ raw: '中文' });
  store.push({ raw: 'abcd' });
  assert.equal(store.bytes, 10);
  store.push({ raw: '一' });
  assert.deepEqual(store.toArray().map(entry => entry.raw), ['abcd', '一']);
  assert.equal(store.bytes, 7);
  assert.equal(store.push({ raw: 'x'.repeat(11) }), -1);
  assert.equal(store.length, 0);
  assert.equal(store.bytes, 0);
  assert.equal(store.truncated, true);
  store.clear();
  assert.equal(store.truncated, false);
  store.push({ raw: 'new' });
  assert.deepEqual(store.toArray().map(entry => entry.raw), ['new']);
});

function captureHarness({ maxBytes } = {}) {
  const handlers = new Map();
  const timers = new Map();
  const intervals = new Map();
  const events = [];
  const processes = [];
  const diagnosed = [];
  let nextTimer = 1;
  const context = {
    isDev: false,
    broadcastToAllWindows: (channel, payload) => events.push({ channel, payload }),
    getMainWindow: () => null
  };
  const adb = {
    runAdb: async args => ({ ok: true, stdout: args[0] === 'devices' ? 'List of devices attached\nTEST-DEVICE\tdevice\n' : '' }),
    spawnAdb: () => {
      const process = new EventEmitter();
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.kill = () => {};
      processes.push(process);
      return process;
    }
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../electron/lib/log-analyzer.cjs');
  const clock = {
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id)
  };
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInNewContext(maxBytes ? source.replace('100 * 1024 * 1024', String(maxBytes)) : source, {
    module, __dirname: path.dirname(filename), Buffer, console, ...clock,
    require: name => {
      if (name === './localization.cjs') return require('../electron/lib/localization.cjs');
      if (name === 'electron') return {};
      if (name === './app-context.cjs') return context;
      if (name === './adb-runtime.cjs') return adb;
      if (name === './log-capture-buffer.cjs') return { createLogCaptureBuffer };
      if (name === './log-sessions.cjs') return { register() {} };
      if (name === './auto-diagnose.cjs') return { autoDiagnoseOnLine: (line, index) => diagnosed.push({ line, index }) };
      return require(name);
    }
  }, { filename });
  const api = module.exports;
  api.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  return {
    api, handlers, timers, intervals, events, processes, diagnosed, context, adb, clock,
    tick() {
      const scheduled = [...timers];
      timers.clear();
      for (const [, timer] of scheduled) timer.callback();
    },
    batches: () => events.filter(event => event.channel === 'log:appendBatch').map(event => event.payload)
  };
}

test('burst IPC coalesces on a single 100ms timer and explicitly bounds the pending tail', () => {
  const h = captureHarness();
  for (let index = 0; index < 50010; index += 1) h.api.getPushLogToBatch()({ id: index, raw: 'line' });
  assert.equal(h.batches().length, 0);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 100);
  h.tick();
  assert.equal(h.batches().length, 1);
  assert.equal(h.batches()[0].entries.length, 50000);
  assert.equal(h.batches()[0].entries[0].id, 10);
  assert.equal(h.batches()[0].entries.at(-1).id, 50009);
  assert.equal(h.batches()[0].truncated, true);
  h.api.getPushLogToBatch()({ raw: 'after' });
  h.api.getFlushLogBatch()();
  assert.equal(h.timers.size, 0);
  assert.equal(h.batches()[1].truncated, false);
  assert.equal(h.batches()[1].entries[0].raw, 'after');
  h.tick();
  assert.equal(h.batches().length, 2);
});

test('reset cancels old batches and count-limited storage snapshots stay chronological', async () => {
  const h = captureHarness();
  h.api.getPushLogToBatch()({ raw: 'old' });
  h.api.resetLogStoreRealtime();
  h.tick();
  assert.equal(h.batches().length, 0);
  for (let index = 0; index < 220000; index += 1) h.api.appendRealtimeEntry({ raw: String(index), id: index });
  const store = h.api.getLogStore().realtime;
  assert.equal(store.length, 200000);
  assert.equal(store[0].id, 20000);
  assert.equal(store.at(-1).id, 219999);
  const state = await h.handlers.get('log:getState')();
  assert.equal(state.entries.length, 50000);
  assert.equal(state.entries[0].id, 170000);
  assert.equal(state.truncated, true);
  assert.equal(h.api.getLogStoreBytes().realtime, store.reduce((sum, entry) => sum + Buffer.byteLength(entry.raw), 0));
});

test('byte-limited batches and backend state report discarded history even below the count limit', async () => {
  const h = captureHarness({ maxBytes: 10 });
  for (let id = 0; id < 3; id += 1) {
    const entry = { id, raw: 'abcd' };
    h.api.appendRealtimeEntry(entry);
    h.api.getPushLogToBatch()(entry);
  }
  h.tick();
  assert.deepEqual(h.batches()[0].entries.map(entry => entry.id), [1, 2]);
  assert.equal(h.batches()[0].truncated, true);
  assert.equal(h.api.getLogStoreBytes().realtime, 8);
  assert.equal((await h.handlers.get('log:getState')()).truncated, true);
  h.api.getPushLogToBatch()({ raw: 'x'.repeat(11) });
  h.tick();
  assert.equal(h.batches()[1].entries.length, 0);
  assert.equal(h.batches()[1].truncated, true);
  h.api.resetLogStoreRealtime();
  assert.equal((await h.handlers.get('log:getState')()).truncated, false);
});

test('capture stop flushes the tail and an old child exit cannot flush or stop its replacement', async () => {
  const h = captureHarness();
  await h.handlers.get('adb:startLog')({}, { deviceId: 'old-device' });
  const old = h.processes[0];
  old.stdout.write('10-21 12:00:00.000 1 2 I Tag: old\n');
  await h.handlers.get('adb:startLog')({}, { deviceId: 'new-device' });
  const current = h.processes[1];
  current.stdout.write('10-21 12:00:00.000 1 2 I Tag: current\n');
  old.emit('exit');
  assert.equal(h.api.getLogcatProc(), current);
  assert.equal(h.batches().length, 0);
  assert.equal(h.timers.size, 1);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.diagnosed.at(-1).index, 0);
  await h.handlers.get('adb:stopLog')();
  assert.equal(h.batches().length, 1);
  assert.equal(h.batches()[0].entries[0].deviceId, 'new-device');
  assert.equal(h.batches()[0].entries[0].message, 'current');
  assert.equal(h.api.getLogcatProc(), null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  current.emit('exit');
  h.tick();
  assert.equal(h.batches().length, 1);
});

test('MCP capture uses the same bounded batcher and ignores an old process exit', async () => {
  const h = captureHarness();
  const module = { exports: {} };
  const filename = path.join(__dirname, '../electron/lib/mcp-server.cjs');
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.callMcpTool = callMcpTool;`, {
    module, console, Buffer, ...h.clock,
    require: name => {
      if (name === './localization.cjs') return require('../electron/lib/localization.cjs');
      if (name === './app-context.cjs') return h.context;
      if (name === './log-analyzer.cjs') return h.api;
      if (name === './adb-runtime.cjs') return h.adb;
      if (name === './ai-analyze.cjs') return { aiKeys: {} };
      if (name === './version.cjs') return { getAppVersion: () => 'test' };
      if (name.startsWith('.')) return {};
      return require(name);
    }
  }, { filename });
  const call = module.exports.callMcpTool;
  await call('capture_start', { deviceId: 'TEST-DEVICE' });
  const old = h.processes[0];
  old.stdout.write('10-21 12:00:00.000 1 2 I Tag: mcp-tail\n');
  assert.equal(h.batches().length, 0);
  await call('capture_stop', {});
  assert.equal(h.batches()[0].entries[0].deviceId, 'TEST-DEVICE');
  await call('capture_start', { deviceId: 'TEST-DEVICE' });
  const current = h.processes[1];
  current.stdout.write('10-21 12:00:00.000 1 2 I Tag: replacement\n');
  old.emit('exit');
  assert.equal(h.batches().length, 1);
  assert.equal(h.api.getLogcatProc(), current);
  assert.equal(h.timers.size, 1);
  assert.equal((await h.handlers.get('log:getState')()).deviceId, 'TEST-DEVICE');
  current.emit('exit');
  assert.equal(h.batches().length, 2);
  assert.equal(h.batches()[1].entries[0].message, 'replacement');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
});

test('repeated diagnosed stack lines do not log or snapshot again inside the debounce window', () => {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../electron/lib/auto-diagnose.cjs');
  const messages = [];
  const events = [];
  let snapshots = 0;
  class FixedDate extends Date { static now() { return 10000; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, Date: FixedDate,
    console: { log: message => messages.push(message) },
    require: name => {
      if (name === './localization.cjs') return require('../electron/lib/localization.cjs');
      if (name === 'electron') return { app: { getPath: () => '' } };
      if (name === 'fs') return { readFileSync() { throw new Error('No custom rules'); } };
      if (name === './app-context.cjs') return { broadcastToAllWindows: (channel, payload) => events.push({ channel, payload }) };
      if (name === './ai-analyze.cjs') return { aiKeys: {} };
      if (name === './vip.cjs') return {};
      if (name === './log-analyzer.cjs') return { getLogStore: () => { snapshots += 1; return { realtime: [{ raw: 'FATAL EXCEPTION' }] }; } };
      return require(name);
    }
  }, { filename });
  for (let index = 0; index < 5000; index += 1) module.exports.autoDiagnoseOnLine('FATAL EXCEPTION', 0);
  assert.equal(events.length, 1);
  assert.equal(snapshots, 1);
  assert.equal(messages.length, 2);
});
