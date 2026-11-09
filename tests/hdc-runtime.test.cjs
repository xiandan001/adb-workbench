const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseHdcDeviceRows } = require('../electron/lib/hdc-device-parser.cjs');
const { hdcDeviceId, deviceTarget, shellQuote } = require('../electron/lib/device-platform.cjs');
const { registerDiscoveredDevices, resolveDeviceRef } = require('../electron/lib/device-registry.cjs');
const { createHdcRuntime, normalizeHdcResult, getHdcCommand } = require('../electron/lib/hdc-runtime.cjs');
const { compileHdcOperation } = require('../electron/lib/device-invocation.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = key => ({ id: hdcDeviceId(key), targetKey: key, transport: 'hdc', platform: 'harmony', status: 'device', generation: 0, capabilities: { ui: true } });
function fixture() {
  const calls = [];
  const runtime = createHdcRuntime({ commandPath: () => 'C:/fixture/hdc.exe', resolve: (id, options) => options.deviceRef || ref(deviceTarget(id)),
    execFile(file, args, options, done) {
      const child = new EventEmitter(); child.stdin = { end() {} }; child.killed = false;
      child.kill = () => { child.killed = true; queueMicrotask(() => done(Object.assign(new Error('Aborted'), { killed: true }), '', '')); };
      calls.push({ file, args, options, child, finish(stdout = 'ok', code = 0) {
        const marker = args.at(-1).match(/__AWB_HDC_[a-f\d]+/)?.[0];
        done(null, marker ? `${stdout}\n${marker}:${code}\n` : stdout, '');
      } });
      return child;
    }, spawn(file, args, options) { calls.push({ file, args, options }); return { pid: 1 }; }
  });
  return { runtime, calls };
}

test('HDC discovery does not count UART Ready or authorization failures as connected devices', () => {
  const rows = parseHdcDeviceRows('OpenHarmony device connector\nCOM4\tUART\tReady\thdc\nshared USB Connected Board hdc\nremote:10178 TCP Unauthorized Phone hdc\n[Info] Not a target\n[Empty]\n');
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['hdc:COM4', 'offline'], ['hdc:shared', 'device'], ['hdc:remote:10178', 'unauthorized']]);
  assert.equal(rows[1].model, 'Board');
  assert.deepEqual(parseHdcDeviceRows('[Empty]\n'), []);
});

test('same raw Android and HDC serials keep separate backend descriptors and queues', () => {
  registerDiscoveredDevices('adb', [{ id: 'same-target', status: 'device' }]);
  registerDiscoveredDevices('hdc', [{ ...ref('same-target'), status: 'device' }]);
  assert.equal(resolveDeviceRef('same-target').transport, 'adb');
  assert.equal(resolveDeviceRef('hdc:same-target').transport, 'hdc');
  assert.throws(() => resolveDeviceRef('hdc:unknown-target'), /尚未识别/);
  assert.throws(() => resolveDeviceRef('hdc:same-target', { deviceRef: ref('another') }), /不匹配/);
  registerDiscoveredDevices('hdc', [{ ...ref('same-target'), status: 'unauthorized' }]);
  assert.throws(() => resolveDeviceRef('hdc:same-target'), /未连接或未获授权/);
});

test('every device-scoped command pins -t and rejects host commands and global target replacement', async () => {
  const f = fixture();
  const job = f.runtime.runHdc('hdc:pin-me', ['shell', 'printf', 'hello']); await tick();
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['-t', 'pin-me', 'shell']);
  assert.equal(f.calls[0].options.windowsHide, true);
  f.calls[0].finish('hello'); assert.equal((await job).ok, true);
  assert.equal((await f.runtime.runHdc('hdc:pin-me', ['-t', 'other', 'shell', 'true'])).ok, false);
  assert.equal((await f.runtime.runHdcHost(['kill', '-r'])).ok, false);
  assert.equal(f.calls.length, 1);
  for (const value of ['', '-t', 'a\nb', 'a b']) assert.throws(() => hdcDeviceId(value));
});

test('zero client exit cannot turn an HDC transport error or failed remote shell into success', () => {
  assert.equal(normalizeHdcResult(null, 'prefix\n__fixture_marker:0\n[Fail] channel closed', '', '__fixture_marker').ok, false);
  assert.equal(normalizeHdcResult(null, 'x'.repeat(10000) + '\n[Fail] channel closed', '').ok, false);
  assert.equal(normalizeHdcResult(null, '[Fail]Device not founded or connected.', '', null, false).ok, false);
  assert.equal(normalizeHdcResult(null, 'command failed\nMARKER:7\n', '', 'MARKER', false).code, 7);
  assert.equal(normalizeHdcResult(null, 'no remote completion', '', 'MARKER', false).ok, false);
  const result = normalizeHdcResult(null, 'data\nMARKER:0\nclient trailing diagnostic', '', 'MARKER', false);
  assert.equal(result.ok, true); assert.equal(result.stdout, 'data');
});

test('queued cancellation does not start a child; active cancellation only kills its owned process', async () => {
  const f = fixture(), abort = new AbortController();
  const first = f.runtime.runHdc('hdc:A', ['shell', 'first']);
  const queued = f.runtime.runHdc('hdc:A', ['shell', 'second'], { signal: abort.signal });
  const other = f.runtime.runHdc('hdc:B', ['shell', 'third']);
  await tick(); assert.equal(f.calls.length, 2);
  abort.abort(); f.calls[0].finish(); await first;
  assert.equal((await queued).cancelled, true); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].child.killed, false); f.calls[1].finish(); await other;
  const runningAbort = new AbortController();
  const active = f.runtime.runHdc('hdc:C', ['shell', 'fourth'], { signal: runningAbort.signal });
  await tick(); runningAbort.abort(); assert.equal((await active).cancelled, true);
  assert.equal(f.calls[2].child.killed, true);
});

test('cross-platform facade translates only verified equivalents and never drops Android-only flags', () => {
  const target = ref('A');
  assert.deepEqual(compileHdcOperation(['shell', 'input', 'keyevent', '3'], target).args, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
  assert.deepEqual(compileHdcOperation(['shell', 'input keyevent 4'], target).args.at(-1), 'Back');
  assert.deepEqual(compileHdcOperation(['push', 'C:/a b/file.txt', '/data/local/tmp/file.txt'], target).args, ['file', 'send', 'C:/a b/file.txt', '/data/local/tmp/file.txt']);
  assert.throws(() => compileHdcOperation(['install', '-r', '-d', 'file.hap'], target), error => error.code === 'DEVICE_UNSUPPORTED');
  assert.throws(() => compileHdcOperation(['install', '-r', 'file.apk'], target));
  assert.throws(() => compileHdcOperation(['logcat', '-c'], target));
  assert.throws(() => compileHdcOperation(['shell', 'dumpsys', 'package', 'a.b'], target));
  assert.throws(() => compileHdcOperation(['reboot', 'loader'], target));
  assert.equal(shellQuote("a'$(touch x)"), "'a'\\''$(touch x)'");
});

test('the supplied HDC command resolves relative to the application, not the process working directory', () => {
  assert.match(getHdcCommand().replaceAll('\\', '/'), /\/adb-workbench\/hdc\/hdc\.exe$/);
});
