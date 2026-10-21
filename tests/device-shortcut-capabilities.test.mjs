import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defaultDeviceShortcuts } from '../src/shared/deviceNavigationShortcuts.js';
import { createCapabilityLoader, CAPABILITY_REFRESH_MS } from '../src/shared/deviceShortcutCapabilities.js';
const require = createRequire(import.meta.url);
const { createCapabilityService } = require('../electron/lib/device-shortcut-capabilities.cjs');
const ok = stdout => ({ ok: true, stdout });
const config = defaultDeviceShortcuts;
const request = (deviceId = 'device-A', value = config()) => ({ deviceId, config: value });
const allPackages = 'package:android\npackage:com.android.settings\npackage:com.xbh.navisetting\npackage:com.xbh.jyjsetting\npackage:com.xbh.whiteboard';
const settle = () => new Promise(resolve => setImmediate(resolve));
function defaultProbe(args) {
  if (args.includes('list')) return ok(allPackages);
  return ok(args.at(-1));
}

test('preflight only reads packages and exact components without launching apps or broadcasting', async () => {
  const calls = [];
  const service = createCapabilityService({ run: async (args, options) => { calls.push(args); assert.equal(options.timeoutMs, 2500); return defaultProbe(args); } });
  const result = await service.check(request());
  assert.equal(result.success, true);
  assert.deepEqual(result.checks.map(item => item.status), ['supported', 'unknown', 'supported', 'supported']);
  assert.match(result.checks[1].reason, /动态广播无法预检/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args[1] === 'device-A' && args[2] === 'shell'));
  assert.ok(calls.every(args => args[3] === 'pm' ? args[4] === 'list' : args[4] === 'package' && args[5] === 'resolve-activity'));
  assert.ok(calls.every(args => !args.includes('am') && !args.includes('monkey') && !args.includes('input')));
});

test('absent packages and missing components are unavailable, never caused by a failed inventory read', async () => {
  const absent = await createCapabilityService({ run: async () => ok('package:com.android.settings') }).check(request());
  assert.deepEqual(absent.checks.map(item => item.status), ['supported', 'unsupported', 'unsupported', 'unsupported']);
  const missing = await createCapabilityService({ run: async args => args.includes('list') ? ok(allPackages) : ok('No activity found') }).check(request());
  assert.equal(missing.checks[2].status, 'unsupported');
  assert.equal(missing.checks[3].status, 'unsupported');
  for (const result of [ok(''), ok('Error: permission denied'), { ok: false, error: 'unauthorized' }, { ok: false, timedOut: true }, { ok: false, error: 'device offline' }]) {
    const checks = (await createCapabilityService({ run: async () => result }).check(request())).checks;
    assert.equal(checks.filter(item => item.status === 'unsupported').length, 0);
    assert.equal(checks[2].status, 'unknown');
  }
});

test('unauthorized, offline, permission denied and timeout have distinct readable unknown reasons', async () => {
  for (const [result, reason] of [
    [{ ok: false, error: 'device unauthorized' }, /尚未授权/],
    [{ ok: false, error: 'device offline' }, /已断开/],
    [{ ok: false, error: 'Permission Denial' }, /查询权限/],
    [{ ok: false, timedOut: true }, /超时/]
  ]) {
    const checks = (await createCapabilityService({ run: async () => result }).check(request())).checks;
    assert.match(checks[2].reason, reason);
  }
});

test('wrong component and unsupported resolver remain unknown instead of claiming launch support', async () => {
  for (const result of [ok('com.xbh.jyjsetting/.WrongActivity'), ok('Unknown command: resolve-activity'), { ok: false, error: 'service missing' }]) {
    const checks = (await createCapabilityService({ run: async args => args.includes('list') ? ok(allPackages) : result }).check(request())).checks;
    assert.equal(checks[2].status, 'unknown');
  }
});

test('notification help and app launch intent are read-only; shell is confirm-only and never probed', async () => {
  const value = config();
  value.slots[1] = { id: 'slot-2', type: 'shell', command: 'reboot', label: '回到桌面' };
  value.slots[2] = { id: 'slot-3', type: 'app', packageName: 'com.example.app', label: '应用' };
  value.slots[3] = { id: 'slot-4', type: 'builtin', action: 'notifications', label: '通知栏' };
  const calls = [];
  const result = await createCapabilityService({ run: async args => {
    calls.push(args);
    if (args.includes('list')) return ok('package:com.example.app');
    if (args.includes('help')) return ok('Status bar commands:\n expand-notifications');
    return ok('com.example.app/.MainActivity');
  } }).check(request('device-B', value));
  assert.deepEqual(result.checks.map(item => item.status), ['supported', 'confirm', 'supported', 'supported']);
  assert.ok(calls.every(args => args[1] === 'device-B' && !args.includes('reboot') && !args.includes('expand-notifications')));
  assert.ok(calls.some(args => args.includes('android.intent.category.LAUNCHER')));
});

test('preflight validates exact four-slot policy before any command', async () => {
  let count = 0;
  const service = createCapabilityService({ run: async () => { count++; return ok(allPackages); } });
  assert.equal((await service.check({ deviceId: 'device-A', config: { version: 1, slots: [] } })).success, false);
  assert.equal((await service.check(request('device-A\nreboot'))).success, false);
  const bad = config(); bad.slots[1] = { id: 'slot-2', type: 'app', packageName: 'com.x;reboot', label: '应用' };
  assert.equal((await service.check(request('A', bad))).success, false);
  assert.equal(count, 0);
});

test('cache is exact device/config, expires after 30s, and deduplicates pending scans', async () => {
  let time = 1000; let calls = 0;
  const service = createCapabilityService({ now: () => time, run: async args => { calls++; await settle(); return defaultProbe(args); } });
  const args = request();
  await Promise.all([service.check(args), service.check(args), service.check(args)]);
  assert.equal(calls, 3);
  await service.check(args); assert.equal(calls, 3);
  await service.check(request('device-B')); assert.equal(calls, 6);
  const renamed = config(); renamed.slots[0].label = '主页';
  await service.check(request('device-A', renamed)); assert.equal(calls, 9);
  time += 30001;
  await service.check(args); assert.equal(calls, 12);
  await service.check({ ...args, force: true }); assert.equal(calls, 15);
});

test('all device scans share a bounded two-device queue', async () => {
  let active = 0; let maxActive = 0;
  const service = createCapabilityService({ run: async args => {
    active++; maxActive = Math.max(active, maxActive); await settle(); active--; return defaultProbe(args);
  } });
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.check(request(`device-${index}`))));
  assert.equal(maxActive, 2);
});

test('reconnect force scan does not cache a late response from the previous connection', async () => {
  let release; let first = true;
  const service = createCapabilityService({ run: async args => {
    if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
    return defaultProbe(args);
  } });
  const old = service.check(request());
  await settle();
  const fresh = await service.check({ ...request(), force: true });
  assert.equal(fresh.checks[2].status, 'supported');
  release(ok('package:com.android.settings')); await old;
  assert.equal((await service.check(request())).checks[2].status, 'supported');
});

test('renderer loader coalesces refreshes and ignores late old-device and old-request results', async () => {
  let time = 1000; const releases = []; const results = [];
  const loader = createCapabilityLoader({ now: () => time, load: () => new Promise(resolve => releases.push(resolve)), onResult: result => results.push(result) });
  const old = loader.refresh(); loader.refresh();
  await settle(); assert.equal(releases.length, 1);
  const newer = loader.refresh(true);
  await settle(); releases[1]('new'); await newer;
  releases[0]('old'); await old;
  assert.deepEqual(results, ['new']);
  await loader.refresh(); assert.equal(releases.length, 2);
  time += CAPABILITY_REFRESH_MS;
  const last = loader.refresh(); await settle(); loader.dispose(); releases[2]('unmounted'); await last;
  assert.deepEqual(results, ['new']);
});
