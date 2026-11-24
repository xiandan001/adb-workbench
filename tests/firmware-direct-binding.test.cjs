const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { matchMtkPortHistory, selectQualifiedUsbAnchor, createMtkBindingStore } = require('../electron/lib/firmware-direct-binding.cjs');

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
