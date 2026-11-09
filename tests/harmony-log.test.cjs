const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { buildHiLogArgs, parseHiLogLine, readHiLogSnapshot, clearHiLog } = require('../electron/lib/harmony-log.cjs');

test('native HiLog arguments distinguish blocking stream, bounded snapshot and type filters', () => {
  assert.deepEqual(buildHiLogArgs(), ['shell', 'hilog', '-v', 'time', '-z', '2000']);
  assert.deepEqual(buildHiLogArgs({ snapshot: true, maxLines: 300, types: ['app', 'core'] }), ['shell', 'hilog', '-x', '-v', 'time', '-z', '300', '-t', 'app,core']);
  for (const options of [{ maxLines: 0 }, { maxLines: 2001 }, { maxLines: '300' }, { types: ['main'] }, { types: ['kmsg', 'app'] }, { types: ['app;reboot'] }]) assert.throws(() => buildHiLogArgs(options));
});

test('HiLog parses domain, process, tag, IDs and severity while preserving original ANSI text', () => {
  const raw = '\u001b[32m11-09 12:34:56.789 5394 5395 I A03200/test_server/testTag: 中文😀\u001b[0m';
  const value = parseHiLogLine(raw, { now: Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(value.raw, raw); assert.equal(value.pid, 5394); assert.equal(value.tid, 5395); assert.equal(value.level, 'I');
  assert.equal(value.domain, 'A03200'); assert.equal(value.processName, 'test_server'); assert.equal(value.tag, 'testTag');
  assert.equal(value.message, '中文😀'); assert.equal(value.platform, 'harmony'); assert.equal(value.logFormat, 'hilog');
  assert.equal(value.clockBasis, 'device-local-year-unknown'); assert.equal(value.pkg, undefined);
});

test('old domain/tag format and C++ tags remain distinct from Android logcat', () => {
  const value = parseHiLogLine('11-15 15:51:02.100 1197 1198 E C01406/OHOS::RS: Error: fixture');
  assert.equal(value.processName, ''); assert.equal(value.tag, 'OHOS::RS'); assert.equal(value.message, 'Error: fixture');
  assert.equal(parseHiLogLine('11-15 15:51:02.100 1197 1198 E AndroidRuntime: fixture'), null);
  assert.equal(parseHiLogLine('unstructured continuation'), null);
  assert.equal(parseHiLogLine('2026-11-09 12:34:56.123+0800 1 2 W A03200/App/Tag: event').clockBasis, 'explicit-offset');
});

test('snapshot and clear use the supplied HDC target only and never clear as part of reading', async () => {
  const calls = [], runHdc = async (id, args, options) => { calls.push({ id, args, options }); return { ok: true, stdout: 'fixture', stderr: '' }; };
  const signal = new AbortController().signal;
  assert.equal((await readHiLogSnapshot('hdc:A', { maxLines: 12, signal }, { runHdc })).ok, true);
  assert.equal(calls[0].id, 'hdc:A'); assert.ok(calls[0].args.includes('-x')); assert.ok(!calls[0].args.includes('-r')); assert.equal(calls[0].options.signal, signal);
  await clearHiLog('hdc:B', { types: ['app'] }, { runHdc });
  assert.deepEqual(calls[1].args, ['shell', 'hilog', '-r', '-t', 'app']); assert.equal(calls[1].id, 'hdc:B');
  const failed = await readHiLogSnapshot('hdc:A', {}, { runHdc: async () => ({ ok: false, error: 'unsupported' }) }); assert.equal(failed.ok, false);
});

function captureFixture() {
  const filename = path.join(__dirname, '../electron/lib/log-analyzer.cjs'), realRequire = createRequire(filename);
  const registry = realRequire('./device-registry.cjs');
  registry.registerDiscoveredDevices('hdc', [{ id: 'hdc:LOG-A', status: 'device' }, { id: 'hdc:LOG-READY', status: 'ready' }]);
  const children = [], reads = [], events = [], handlers = new Map(); let failClear = false;
  const child = () => { const value = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.kills = 0; value.kill = () => { value.kills++; }; children.push(value); return value; };
  const module = { exports: {} }, controls = {
    runHdc: async (id, args) => { reads.push({ id, args }); return failClear ? { ok: false, error: 'fixture disconnected' } : { ok: true, stdout: '' }; },
    spawnHdc: (id, args) => { reads.push({ id, args }); return child(); },
  };
  const hilog = realRequire('./harmony-log.cjs');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, __dirname: path.dirname(filename), Buffer, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === 'electron') return {};
      if (name === './app-context.cjs') return { isDev: false, broadcastToAllWindows: (channel, payload) => events.push({ channel, payload }) };
      if (name === './adb-runtime.cjs') return { runAdb: async args => { reads.push({ adb: args }); return { ok: true, stdout: '' }; }, spawnAdb: child };
      if (name === './harmony-log.cjs') return { ...hilog, spawnHiLog: (id, opts) => hilog.spawnHiLog(id, opts, controls), clearHiLog: (id, opts) => hilog.clearHiLog(id, opts, controls) };
      if (name === './log-sessions.cjs') return { register() {} };
      if (name === './device-discovery.cjs') return { listDevices: async () => [{ id: 'hdc:LOG-A', status: 'device' }, { id: 'hdc:LOG-READY', status: 'ready' }] };
      if (name === './auto-diagnose.cjs') return { autoDiagnoseOnLine() {}, resetAutoDiagnoseLastFire() {} };
      return realRequire(name);
    } }, { filename });
  module.exports.register({ handle: (name, fn) => handlers.set(name, fn) });
  return { api: module.exports, handlers, reads, children, events, failClear: value => { failClear = value; } };
}

test('real capture module uses HiLog, excludes Ready and preserves current capture when an invalid target is requested', async () => {
  const h = captureFixture();
  assert.deepEqual(Array.from(await h.handlers.get('adb:listDevices')(), item => item.id), ['hdc:LOG-A']);
  assert.equal((await h.api.startLogCapture({ deviceId: 'hdc:LOG-A', types: ['app'] })).ok, true);
  assert.deepEqual(h.reads[0], { id: 'hdc:LOG-A', args: ['shell', 'hilog', '-v', 'time', '-z', '2000', '-t', 'app'] });
  h.children[0].stdout.write('11-09 12:34:56.123 12 13 W A03200/my.proc/MyTag: 中文😀\n');
  const entry = h.api.getLogStore().realtime[0]; assert.equal(entry.deviceId, 'hdc:LOG-A'); assert.equal(entry.domain, 'A03200'); assert.equal(entry.processName, 'my.proc');
  assert.equal((await h.api.startLogCapture({ deviceId: 'hdc:LOG-READY' })).ok, false);
  assert.equal(h.children[0].kills, 0); assert.equal(h.api.getLogcatProc(), h.children[0]);
  assert.equal((await h.api.startLogCapture({ deviceId: 'hdc:LOG-A', buffers: ['main'] })).ok, false);
  assert.equal(h.children[0].kills, 0);
});

test('clear binds the retained realtime source and keeps evidence on target mismatch or native failure', async () => {
  const h = captureFixture(); await h.api.startLogCapture({ deviceId: 'hdc:LOG-A' });
  h.children[0].stdout.write('11-09 12:34:56.123 12 13 W A03200/Tag: retained\n');
  assert.equal((await h.api.clearLogs({ source: 'realtime', deviceId: 'hdc:OTHER' })).ok, false);
  assert.equal(h.api.getLogStore().realtime.length, 1);
  h.failClear(true); assert.equal((await h.api.clearLogs({ source: 'realtime', deviceId: 'hdc:LOG-A' })).ok, false); assert.equal(h.api.getLogStore().realtime.length, 1);
  h.failClear(false); h.api.setCurrentLogSource('file', 'another-device');
  assert.equal((await h.api.clearLogs({ source: 'realtime', deviceId: 'hdc:LOG-A' })).ok, true);
  assert.deepEqual(h.reads.at(-1), { id: 'hdc:LOG-A', args: ['shell', 'hilog', '-r'] });
  assert.equal(h.api.getLogStore().realtime.length, 0);
});

test('late exit from the previous process cannot announce that the newer capture stopped', async () => {
  const h = captureFixture(); await h.api.startLogCapture({ deviceId: 'hdc:LOG-A' }); const old = h.children[0];
  const current = await h.api.startLogCapture({ deviceId: 'android-fixture' });
  old.emit('exit', 1); assert.equal(h.events.filter(event => event.channel === 'log:capture-state').length, 0);
  h.children[1].emit('exit', 1); const event = h.events.find(event => event.channel === 'log:capture-state');
  assert.equal(event.payload.captureId, current.captureId); assert.equal(event.payload.deviceId, 'android-fixture'); assert.equal(event.payload.running, false);
});

test('HiLog metadata and domain filters survive local session serialization', () => {
  const { normalizeSession } = require('../electron/lib/log-sessions.cjs');
  const entry = { id: 'entry', source: 'realtime', deviceId: 'hdc:LOG-A', ...parseHiLogLine('11-09 12:34:56.123 12 13 W A03200/my.proc/Tag: retained') };
  const session = normalizeSession({ name: 'HiLog', source: 'realtime', deviceId: 'hdc:LOG-A', entries: [entry], aiTurns: [], buffers: ['app'], filter: { domain: 'A03200' } });
  assert.equal(session.entries[0].domain, 'A03200'); assert.equal(session.entries[0].tid, 13); assert.equal(session.entries[0].platform, 'harmony');
  assert.equal(session.filter.domain, 'A03200'); assert.deepEqual(session.buffers, ['app']);
});
