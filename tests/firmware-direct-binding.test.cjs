const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const {
  matchMtkPortHistory, listMtkPortReservationsFromSnapshot, listMtkPortReservations, queryMtkPortHistory,
  selectQualifiedUsbAnchor, createMtkBindingStore,
} = require('../electron/lib/firmware-direct-binding.cjs');

const target = { location: 'PCIROOT(0)#USBROOT(0)#USB(3)', label: 'IFPD-G520' };
const instance = 'USB\\VID_0E8D&PID_2000\\8&FIXTURE&0&1';
const mtk = { id: instance, port: 'com3', location: target.location, service: 'wdm_usb', inf: 'oem12.inf' };
const profile = { board: 'IFPD-G520', product: 'IFPD-G520', boardPlatform: 'mt8189', adbVids: ['0e8d', '046d'] };

test('accepts only a unique reserved, unoccupied MTK port on the approved physical USB path', () => {
  const read = (nodes, activePorts = []) => matchMtkPortHistory({ complete: true, nodes, activePorts }, target);
  assert.deepEqual(read([mtk]), {
    instanceId: instance, port: 'COM3', selector: 'COM3', location: target.location, label: target.label, stage: 'preloader', verified: true,
  });
  assert.equal(read([mtk], ['COM3']), null);
  assert.equal(read([{ ...mtk, location: 'usb-other' }]), null);
  assert.equal(read([mtk, { ...mtk, location: 'usb-other', id: 'USB\\VID_0E8D&PID_2000\\OTHER' }]), null);
  assert.equal(read([{ ...mtk, service: 'winusb' }]), null);
  assert.equal(matchMtkPortHistory({ complete: false, nodes: [mtk], activePorts: [] }, target), null);
});

test('reserved MTK port list offers only canonical one-to-one USB and COM matches', () => {
  const second = { ...mtk, id: 'USB\\VID_0E8D&PID_2000\\SECOND', port: 'COM12', location: 'PCIROOT(0)#USBROOT(0)#USB(4)' };
  const list = (nodes, activePorts = []) => listMtkPortReservationsFromSnapshot({ complete: true, nodes, activePorts });
  const accepted = list([second, mtk]);
  assert.deepEqual(accepted.map(row => row.port), ['COM3', 'COM12']);
  assert.match(accepted[0].id, /^[a-f0-9]{64}$/);
  assert.deepEqual(accepted[0], {
    id: accepted[0].id, instanceId: instance, port: 'COM3', selector: 'COM3', location: target.location, stage: 'preloader', verified: true,
  });
  assert.deepEqual(list([{ ...mtk, id: instance.toLowerCase(), location: target.location.toLowerCase(), service: 'WDM_USB', inf: 'OEM12.INF' }]),
    [accepted[0]]);
  assert.notEqual(list([{ ...mtk, inf: 'oem42.inf' }])[0].id, accepted[0].id);
  assert.deepEqual(list([second, mtk], ['com3']), [accepted[1]]);
  assert.deepEqual(list([mtk, { ...second, port: 'COM3', location: null }]), []);
  assert.deepEqual(list([mtk, { ...second, location: target.location }]), []);
  assert.deepEqual(list([mtk, { ...second, location: target.location, inf: 'unknown.inf' }]), []);
  assert.deepEqual(list([mtk, { ...mtk }]), []);
  assert.deepEqual(list([{ ...mtk, location: 'PCIROOT(0)#USBROOT(0)' }]), []);
  assert.deepEqual(listMtkPortReservationsFromSnapshot({ complete: false, nodes: [mtk], activePorts: [] }), []);
});

test('Windows reservation APIs share one bounded read, and aborted or malformed captures do not produce offers', {
  skip: process.platform !== 'win32',
}, async () => {
  let calls = 0;
  const exec = async (_file, args, options) => {
    calls++;
    assert.ok(args.includes('-EncodedCommand'));
    assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify({ complete: true, nodes: [mtk], activePorts: [] }) };
  };
  assert.equal((await listMtkPortReservations({ exec }))[0].port, 'COM3');
  assert.equal(calls, 1);
  assert.equal((await queryMtkPortHistory(target, { exec })).port, 'COM3');
  assert.equal(calls, 2);
  assert.deepEqual(await listMtkPortReservations({ signal: AbortSignal.abort(), exec }), []);
  assert.equal(calls, 2);
  assert.deepEqual(await listMtkPortReservations({ exec: async () => ({ stdout: 'nope' }) }), []);
});

test('ADB anchoring requires a single matching USB transport and real board identity', async () => {
  const inv = { ok: true, adb: [{ serial: 'g520', location: target.location, identity: 'sealed', vid: '046d' }] };
  const calls = [];
  const adb = async args => {
    calls.push(args);
    return { ok: true, stdout: args[0] === 'devices' ?
      'List of devices attached\ng520 device product:IFPD-G520 transport_id:6\n192.0.2.10:5555 device product:IFPD-G520 transport_id:7\n' :
      'IFPD-G520\nmt8189\n1\n' };
  };
  const ok = await selectQualifiedUsbAnchor(inv, profile, '', adb);
  assert.equal(ok.transport, '6');
  assert.deepEqual(calls[1].slice(0, 3), ['-t', '6', 'shell']);
  assert.equal(await selectQualifiedUsbAnchor(inv, profile, '192.0.2.10:5555', adb), null);
  assert.equal(await selectQualifiedUsbAnchor(inv, profile, '', async args => args[0] === 'devices' ?
    adb(args) : { ok: true, stdout: 'NotThatProduct\nmt8189\n1\n' }), null);
});

test('the saved USB target persists across app lifetimes without arbitrary executable or path fields', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'veylo-mtk-binding-'));
  const filename = path.join(directory, 'binding.json');
  t.after(async () => {
    await fs.unlink(filename).catch(() => {});
    await fs.rmdir(directory);
  });
  const store = createMtkBindingStore(filename);
  assert.equal(await store.read(), null);
  const record = { product: profile.product, location: target.location, serial: 'target',
    identity: 'f'.repeat(64), instanceId: instance, port: 'COM3' };
  assert.equal(await store.remember({ ...record, executable: 'bad.exe' }), true);
  assert.deepEqual(await createMtkBindingStore(filename).read(), record);
  assert.equal(await store.remember({ ...record, port: 'COM8888' }), false);
  assert.deepEqual(await createMtkBindingStore(filename).read(), record);
});
