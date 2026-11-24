const test = require('node:test');
const assert = require('node:assert/strict');
const { queryDirectUsb, reconcileRkTargets } = require('../electron/lib/firmware-direct-targets.cjs');

const location = port => 'PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(' + port + ')';
const portsClass = '{4d36e978-e325-11ce-bfc1-08002be10318}';
const rockusbClass = '{79dfc2a8-2574-493c-ae71-52958e41dd00}';
const adbCompatible = 'USB\\Class_FF&SubClass_42&Prot_01';
const usb = (vid, pid, suffix, iface = '') => 'USB\\VID_' + vid + '&PID_' + pid + iface + '\\' + suffix;

const rkRow = (port, pid = '350a') => ({
  instanceId: usb('2207', pid, '5&abc&0&' + port),
  locations: [location(port)], problemCode: 0, classGuid: rockusbClass,
  service: 'Rockusb', label: 'Rockusb Device'
});
const mtkRow = (locationPort, com, pid = '2000') => ({
  instanceId: usb('0e8d', pid, '5&abc&0&' + locationPort),
  locations: [location(locationPort)], problemCode: 0, classGuid: portsClass,
  service: 'wdm_usb', label: 'MediaTek VCOM', port: com
});
const adbRow = (port, serial = 'Device_A') => ({
  instanceId: usb('18d1', '4ee7', '5&abc&0&01', '&MI_01'),
  parentInstanceId: usb('18d1', '4ee7', serial),
  locations: [location(port) + '#USBMI(1)'],
  parentLocations: [location(port)],
  parentCapabilities: 16,
  compatibleIds: [adbCompatible],
  problemCode: 0, service: 'WinUSB', label: 'ADB interface'
});
const query = (rows, complete = true) => queryDirectUsb({
  hostPlatform: 'win32', capture: async () => ({ complete, rows })
});

test('a complete empty scan is distinguishable from failed, partial or detached scans', async () => {
  const empty = await query([]);
  assert.deepEqual(empty, { ok: true, adb: [], rk: [], mtk: [] });
  const partial = await query([rkRow(2)], false);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.rk, []);
  const detached = await query([{ ...rkRow(2), locations: [] }, rkRow(3, '350b')]);
  assert.equal(detached.ok, false);
  assert.deepEqual(detached.rk, [], 'an addressable row must not look uniquely eligible in an incomplete capture');
  const unresolved = await query([{ ...rkRow(2), instanceId: 'USB\\VID_2207&PID_350A\\' }, rkRow(3, '350b')]);
  assert.equal(unresolved.ok, false);
  assert.deepEqual(unresolved.rk, []);
  let called = false;
  const unsupported = await queryDirectUsb({ hostPlatform: 'linux', capture: async () => { called = true; } });
  assert.equal(unsupported.ok, false);
  assert.equal(called, false);
});

test('ADB requires real USB ADB protocol and a provably unique parent, not a network or fastboot alias', async () => {
  const adb = adbRow(1, 'Device-A');
  const { ok, adb: candidates } = await query([
    adb,
    { ...adbRow(2), instanceId: usb('18d1', '4ee7', '5&xyz&0&01', '&MI_01'), compatibleIds: ['USB\\Class_FF&SubClass_42&Prot_03'] },
    { ...adbRow(3), instanceId: usb('18d1', '4ee7', '5&def&0&01', '&MI_01'), parentCapabilities: 0 },
    { ...adbRow(4), instanceId: 'TCPIP\\DEVICE\\192.0.2.1:5555' }
  ]);
  assert.equal(ok, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].serial, 'Device-A');
  assert.equal(candidates[0].location, location(1));
  assert.equal(candidates[0].instanceId, adb.parentInstanceId);
  assert.ok(candidates[0].identity);
});

test('two ADB interfaces can describe one physical device, but equal serials at different ports do not', async () => {
  const a = adbRow(1, 'RepeatedSerial');
  const twoInterfaces = await query([a, {
    ...a, instanceId: usb('18d1', '4ee7', '5&abc&0&02', '&MI_02'), locations: [location(1) + '#USBMI(2)']
  }]);
  assert.equal(twoInterfaces.adb.length, 1);
  const duplicates = await query([a, {
    ...adbRow(2, 'RepeatedSerial'), instanceId: usb('18d1', '4ee7', '5&def&0&01', '&MI_01')
  }]);
  assert.equal(duplicates.adb.length, 2);
  assert.notEqual(duplicates.adb[0].identity, duplicates.adb[1].identity);
});

test('MTK requires a healthy bound USB Ports driver and real PortName for addressability', async () => {
  const { ok, mtk } = await query([
    mtkRow(1, 'com4'),
    mtkRow(2, 'COM5', '0003'),
    mtkRow(3, 'COM6', '2001'),
    { ...mtkRow(4, 'COM7'), problemCode: 28 },
    { ...mtkRow(5, 'COM8'), service: 'another-driver' },
    { ...mtkRow(6, 'COM9'), classGuid: rockusbClass },
    { ...mtkRow(7, 'COM10', '9999') }
  ]);
  assert.equal(ok, true);
  assert.deepEqual(mtk.map(row => [row.stage, row.port, row.location]), [
    ['preloader', 'COM4', location(1)], ['brom', 'COM5', location(2)], ['da', 'COM6', location(3)]
  ]);
  const unusable = await query([{ ...mtkRow(1), label: 'MediaTek VCOM (COM4)' }]);
  assert.equal(unusable.ok, false, 'never infer COM from a display label');
  assert.deepEqual(unusable.mtk, []);
});

test('a COM reassignment changes identity, and duplicate COM addresses are not selectable', async () => {
  const old = (await query([mtkRow(1, 'COM4')])).mtk[0];
  const sameComOnDifferentUsbDevice = (await query([mtkRow(2, 'COM4')])).mtk[0];
  const sameUsbDeviceDifferentCom = (await query([mtkRow(1, 'COM5')])).mtk[0];
  assert.notEqual(old.identity, sameComOnDifferentUsbDevice.identity);
  assert.notEqual(old.identity, sameUsbDeviceDifferentCom.identity);
  const collision = await query([mtkRow(1, 'COM4'), mtkRow(2, 'COM4')]);
  assert.equal(collision.ok, false);
  assert.deepEqual(collision.mtk, []);
  const otherVendor = await query([mtkRow(1, 'COM4'), {
    instanceId: 'ACPI\\PNP0501\\1', problemCode: 0,
    classGuid: portsClass, service: 'serial', port: 'COM4'
  }]);
  assert.equal(otherVendor.ok, false);
  assert.deepEqual(otherVendor.mtk, []);
});

test('only a trustworthy USB serial is exposed for a flashing device', async () => {
  const { mtk, rk } = await query([
    { ...mtkRow(1, 'COM4'), instanceId: usb('0e8d', '2000', 'Mtk_Usb_1'), capabilities: 16 },
    { ...rkRow(2), capabilities: 16 },
    { ...rkRow(3), instanceId: usb('2207', '350a', 'Unproved_Serial'), capabilities: 0 }
  ]);
  assert.equal(mtk[0].serial, 'Mtk_Usb_1');
  assert.equal(rk[0].serial, undefined);
  assert.equal(rk[1].serial, undefined);
});

const cli = (locationId, pid = '350a', mode = 'loader') => ({ locationId, vid: '2207', pid, mode, serial: '' });
test('RK only joins exact VID/PID singletons, independent of scan order', async () => {
  const inventory = (await query([rkRow(1, '350a'), rkRow(2, '350b')])).rk;
  const matched = reconcileRkTargets(inventory, [cli('0042', '350b', 'maskrom'), cli('0025')]);
  assert.deepEqual(matched.map(row => [row.location, row.locationId, row.mode]), [
    [location(1), '25', 'loader'], [location(2), '42', 'maskrom']
  ]);
  assert.deepEqual(reconcileRkTargets(inventory, [cli('25', 'abcd')]), []);
});

test('RK equal models, incompatible results, duplicate native locations or duplicate CLI selectors fail closed', async () => {
  const inventory = (await query([rkRow(1), rkRow(2)])).rk;
  assert.deepEqual(reconcileRkTargets(inventory, [cli('25'), cli('42')]), []);
  assert.deepEqual(reconcileRkTargets(inventory, [cli('25')]), []);
  assert.deepEqual(reconcileRkTargets([inventory[0]], [cli('25'), cli('42')]), []);
  assert.deepEqual(reconcileRkTargets([inventory[0]], [cli('25', '350a', 'unknown')]), []);
  assert.deepEqual(reconcileRkTargets([inventory[0]], [cli('25'), cli('0025', '350b')]), []);
  assert.deepEqual(reconcileRkTargets([{ ...inventory[0], location: undefined }], [cli('25')]), []);
});

test('capture failure and an aborted probe return no candidates', async () => {
  const controller = new AbortController();
  const inFlight = queryDirectUsb({
    hostPlatform: 'win32', signal: controller.signal, capture: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return { complete: true, rows: [rkRow(1)] };
    }
  });
  assert.deepEqual((await inFlight).rk, []);
  assert.equal((await inFlight).ok, false);
  const failed = await queryDirectUsb({ hostPlatform: 'win32', capture: async () => { throw Error('unavailable'); } });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.adb, []);
});
