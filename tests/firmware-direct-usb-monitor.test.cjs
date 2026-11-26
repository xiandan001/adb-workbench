const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { queryDirectUsb, watchDirectUsb } = require('../electron/lib/firmware-direct-targets.cjs');

const preloader = {
  instanceId: 'USB\\VID_0E8D&PID_2000\\5&ABC&0&1',
  locations: ['PCIROOT(0)#USBROOT(0)#USB(1)'], problemCode: 0,
  classGuid: '{4d36e978-e325-11ce-bfc1-08002be10318}', service: 'wdm_usb',
  driverInf: 'oem27.inf', label: '联调设备', port: 'COM3',
};
const packet = (rows, complete = true) => JSON.stringify({ complete, rows }) + '\r\n';

function fixture(options = {}) {
  const child = new EventEmitter(), controller = new AbortController(), snapshots = [], spawned = [];
  child.stdout = new PassThrough();
  child.kill = () => { child.kills = (child.kills || 0) + 1; return true; };
  const stop = watchDirectUsb({
    hostPlatform: 'win32', signal: controller.signal, onSnapshot: result => snapshots.push(result),
    spawnProcess: (...args) => { spawned.push(args); return child; }, ...options,
  });
  return { child, controller, snapshots, spawned, stop };
}

test('USB monitoring reuses one hidden, bounded probe and observes brief Preloader arrivals', async t => {
  const f = fixture(); t.after(f.stop);
  assert.equal(f.spawned.length, 1);
  const [program, args, options] = f.spawned[0];
  assert.match(program, /powershell\.exe$/i);
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.equal((script.match(/Add-Type/g) || []).length, 1);
  assert.ok(script.indexOf('Add-Type') < script.indexOf('while ($true)'));
  assert.match(script, /Sleep\(200\)/);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  f.child.stdout.write(packet([]));
  const live = Buffer.from(packet([preloader]), 'utf8');
  const split = live.indexOf(Buffer.from('联')) + 1;
  f.child.stdout.write(live.subarray(0, split));
  assert.equal(f.snapshots.length, 1, 'partial UTF-8/JSON is not a result');
  f.child.stdout.write(Buffer.concat([live.subarray(split), Buffer.from(packet([]))]));
  assert.equal(f.snapshots.length, 3);
  const wanted = await queryDirectUsb({ hostPlatform: 'win32', capture: async () => ({ complete: true, rows: [preloader] }) });
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.mtk[0]?.port || ''), ['', 'COM3', '']);
  assert.deepEqual(f.snapshots[1], wanted, 'same identity and port validation as an independent scan');
  assert.equal(f.spawned.length, 1);
});

test('abort and explicit stop kill only the owned monitor, never emit late results, and are idempotent', () => {
  const f = fixture();
  f.child.stdout.write(packet([preloader]).slice(0, -2));
  f.controller.abort();
  f.stop();
  f.child.stdout.write('\r\n' + packet([preloader]));
  f.child.emit('error', Error('aborted process'));
  f.child.emit('close', null);
  assert.equal(f.child.kills, 1);
  assert.deepEqual(f.snapshots, []);
});

test('invalid USB inventory is unselectable while a protocol violation stops the bounded monitor', () => {
  const f = fixture();
  f.child.stdout.write(packet([preloader], false));
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.code), ['usb-inventory-incomplete']);
  f.child.stdout.write('x'.repeat(128 * 1024 + 1));
  f.child.stdout.write('\n' + packet([preloader]));
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.code), ['usb-inventory-incomplete', 'usb-probe-failed']);
  assert.ok(f.snapshots.every(snapshot => !snapshot.ok && !snapshot.mtk.length));
  assert.equal(f.child.kills, 1);
  assert.equal(f.spawned.length, 1);
});

test('unexpected exit never retries, and no process starts without an active Windows task', () => {
  const f = fixture();
  f.child.emit('close', 1);
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.code), ['usb-probe-failed']);
  assert.equal(f.child.kills || 0, 0);
  f.stop();
  assert.equal(f.spawned.length, 1);
  const unsupported = fixture({ hostPlatform: 'linux' });
  const cancelled = fixture({ signal: AbortSignal.abort() });
  const unowned = fixture({ signal: undefined });
  assert.ok([unsupported, cancelled, unowned].every(item => item.spawned.length === 0));
});

test('an unavailable probe reports failure once and leaves no process to retry', () => {
  const missing = fixture({ spawnProcess: () => { throw Error('unavailable'); } });
  assert.deepEqual(missing.snapshots.map(snapshot => snapshot.code), ['usb-probe-failed']);
  missing.controller.abort();
  assert.equal(missing.child.kills || 0, 0);
  const f = fixture();
  f.child.emit('error', Error('spawn failed'));
  f.child.emit('close', null);
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.code), ['usb-probe-failed']);
  assert.equal(f.child.kills || 0, 0);
});
