const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: flush } = require('node:timers/promises');
const { registerFirmwareDirectWorkspace, verifyBoot } = require('../electron/lib/firmware-direct-workspace.cjs');
const { MTK_VERSION } = require('../electron/lib/firmware-direct-mtk.cjs');
const { acceptedFlashProfiles } = require('../electron/lib/firmware-direct-profiles.cjs');

const profile = {
  platform: 'mtk', mode: 'format-all-download', firmwareSha256: 'f'.repeat(64), chip: 'MT8189', toolVersion: MTK_VERSION,
  usb: { vid: '0e8d', pid: '2000', stage: 'preloader', serial: 'flash-serial' }, board: 'Fixture Board',
};
const knownMtk = { identity: 'device-approved', location: 'usb-location', vid: '0e8d', pid: '2000', serial: 'flash-serial', stage: 'preloader', port: 'COM7', label: 'Fixture USB' };
const receipt = { sha256: profile.firmwareSha256, chip: profile.chip, path: 'C:/fixture/flash.xml' };

function fixture({ profiles, checkboxChecked = false } = {}) {
  const handlers = new Map(), asks = [], reads = [], writes = [];
  const frame = {}, otherFrame = {};
  const owner = {}, event = { senderFrame: frame };
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    profiles, ownerFor: value => value.senderFrame === frame ? owner : null, getOwnerFrame: () => frame,
    isWindows: true, toolRoot: async () => 'C:/tool', canStart: () => true,
    ask: async options => { asks.push(options); return { response: 1, checkboxChecked }; },
    backend: {
      inspect: async () => ({ ok: true, tool: { version: profile.toolVersion } }),
      write: async (plan, context) => {
        if (!await context.beforeDispatch()) return { transferCompleted: false };
        writes.push(plan); return { transferCompleted: true };
      },
    },
    targetProvider: { queryDirectUsb: async () => ({ ok: true, adb: [], mtk: [knownMtk], rk: [] }) },
    firmware: {
      prepareDirectFirmware: async (_kind, selected) => { reads.push(selected); return receipt; },
      revalidateDirectFirmware: async () => true,
      stageDirectFirmware: async () => ({ firmware: { ...receipt, path: 'C:/staged/flash.xml' } }),
    },
  });
  const call = (verb, body, source = event) => handlers.get('firmware:direct:' + verb)(source, 'mtk', body);
  return { api, call, asks, reads, writes, frame, otherFrame };
}

test('no configured profile rejects direct arm before touching files or hardware', async () => {
  const f = fixture({ profiles: [] });
  const firmwareId = f.api.rememberFile('mtk', receipt.path, f.frame);
  assert.deepEqual(await f.call('state'), {
    ok: true, enabled: false, modes: [], code: 'flash-profile-unverified', busy: false, job: null,
  });
  assert.equal((await f.call('arm', { firmwareId, mode: profile.mode })).code, 'flash-profile-unverified');
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

test('the release admits only the hardware-tested modes with no host-specific target identity', async () => {
  assert.deepEqual(await fixture().call('state'), { ok: true, enabled: true, modes: ['download-only'], busy: false, job: null });
  assert.deepEqual(acceptedFlashProfiles.map(row => [row.product, row.mode]), [
    ['IFPD-G520', 'download-only'], ['IFPD3576_Pro', 'upgrade'],
  ]);
  assert.ok(acceptedFlashProfiles.every(row => !row.usb.serial && !row.usb.port && !row.bootSerial));
});

test('qualified MTK flow arms only verified COM history and continues without sending a reboot', async () => {
  const def = acceptedFlashProfiles.find(row => row.platform === 'mtk');
  const handlers = new Map(), asks = [], requests = [];
  const frame = {}, owner = {}, loc = 'usb-g520';
  const anchor = { location: loc, vid: '0e8d', serial: 'old-serial', identity: 'old-anchor' };
  const history = { location: loc, instanceId: 'USB\\VID_0E8D&PID_2000\\FIXTURE', port: 'COM3', stage: 'preloader', verified: true };
  let attached = anchor, settle;
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    ownerFor: () => owner, getOwnerFrame: () => frame, isWindows: true,
    toolsIdle: async () => true, toolRoot: async () => 'C:/tool', canStart: () => true,
    ask: async value => { asks.push(value); return { response: 1 }; },
    resolveMtkPort: async forUsb => forUsb.location === loc && history,
    runAdb: async args => {
      requests.push(args);
      if (args[0] === 'devices') return { ok: true, stdout: `List of devices attached\n${attached.serial} device product:IFPD-G520 transport_id:7\n` };
      assert.deepEqual(args.slice(0, 3), ['-t', '7', 'shell']);
      const stdout = args[3].includes('fingerprint') ? [...Object.values(def.boot), '1'].join('\n') : 'IFPD-G520\nmt8189\n1\n';
      return { ok: true, stdout };
    },
    backend: {
      inspect: async () => ({ ok: true, tool: { version: MTK_VERSION } }),
      async write(params, ctx) {
        assert.equal(params.target.port, 'COM3');
        assert.equal(params.options.elevated, true);
        assert.equal(await ctx.beforeDispatch(), true);
        ctx.onReady();
        return new Promise(resolve => { settle = () => { attached = { ...anchor, serial: 'new-serial', identity: 'post-flash' }; resolve({ transferCompleted: true }); }; });
      },
    },
    targetProvider: { queryDirectUsb: async () => ({ ok: true, adb: [attached], mtk: [], rk: [] }) },
    firmware: {
      prepareDirectFirmware: async () => ({ chip: def.chip, sha256: def.firmwareSha256, project: def.project, path: 'C:/input/flash.xml' }),
      revalidateDirectFirmware: async () => true,
      stageDirectFirmware: async (_p, r) => ({ firmware: { ...r, path: 'C:/staged/flash.xml' } }),
    },
  });
  const call = (verb, payload) => handlers.get('firmware:direct:' + verb)({ senderFrame: frame }, 'mtk', payload);
  const id = api.rememberFile('mtk', 'C:/input/flash.xml', frame);
  assert.equal((await call('arm', { firmwareId: id, mode: 'download-only', com: 'COM99' })).ok, true);
  await flush();
  const waiting = (await call('state')).job;
  assert.equal(waiting.phase, 'armed');
  assert.equal(api.isProtected(), true);
  assert.equal((await call('cancel', waiting.id)).ok, false);
  settle();
  await flush();
  assert.equal((await call('state')).job.phase, 'verified');
  assert.equal(asks.length, 1);
  assert.ok(requests.every(args => !args.includes('reboot')));
});

test('the bridge rejects non-owner IPC and uses only the remembered native picker file, plus an independent format checkbox', async () => {
  const f = fixture({ profiles: [profile] });
  const firmwareId = f.api.rememberFile('mtk', receipt.path, f.frame);
  assert.equal((await f.call('arm', { firmwareId, mode: profile.mode }, { senderFrame: f.otherFrame })).ok, false);
  assert.equal((await f.call('arm', { firmwareId, mode: 'download-only' })).ok, false);
  assert.equal((await f.call('arm', { firmwareId: '1'.repeat(36), mode: profile.mode })).ok, false);
  assert.equal((await f.call('arm', { firmwareId, mode: profile.mode, targetHint: '192.168.2.1:5555' })).ok, false);
  assert.equal((await f.call('arm', { firmwareId, mode: profile.mode, filePath: 'C:/ignored.xml' })).ok, true);
  await flush();
  assert.deepEqual(f.reads, [receipt.path]);
  assert.ok(f.asks[0].checkboxLabel);
  assert.deepEqual(f.writes, []);
  assert.equal((await f.call('state')).job.phase, 'cancelled');
});

test('admitted mode with explicit target uses a staged file and does not claim boot from a write marker', async () => {
  const f = fixture({ profiles: [profile], checkboxChecked: true });
  const firmwareId = f.api.rememberFile('mtk', receipt.path, f.frame);
  await f.call('arm', { firmwareId, mode: profile.mode, permitFormatAll: false, com: 'COM99' });
  await flush();
  assert.equal(f.writes[0].target.port, 'COM7');
  assert.equal(f.writes[0].firmware.path, 'C:/staged/flash.xml');
  assert.deepEqual(f.writes[0].options, { mode: profile.mode, reboot: false, permitFormatAll: true });
  assert.equal((await f.call('state')).job.phase, 'written');
});

test('boot success independently requires the same USB port, authenticated ADB and the expected build', async () => {
  const p = { profile: { bootSerial: 'adb-serial', bootFingerprint: 'fixture/build' } };
  const device = { serial: 'adb-serial', location: knownMtk.location };
  const queryUsb = async () => ({ ok: true, adb: [device] });
  const runAdb = async args => {
    if (args[0] === 'devices') return { ok: true, stdout: 'List of devices attached\nadb-serial device transport_id:7\n' };
    assert.deepEqual(args, ['-t', '7', 'shell', 'getprop', 'ro.build.fingerprint']);
    return { ok: true, stdout: 'fixture/build\n' };
  };
  assert.equal(await verifyBoot(p, knownMtk, { queryUsb, runAdb, retries: 1 }), true);
  assert.equal(await verifyBoot(p, knownMtk, { queryUsb: async () => ({ ok: true, adb: [{ ...device, location: 'new-port' }] }), runAdb, retries: 1 }), false);
  assert.equal(await verifyBoot(p, knownMtk, { queryUsb,
    runAdb: async args => args[0] === 'devices' ? runAdb(args) : { ok: true, stdout: 'wrong/build' }, retries: 1 }), false);
  let scans = 0;
  assert.equal(await verifyBoot(p, knownMtk, { queryUsb, retries: 1,
    runAdb: async args => args[0] === 'devices' && ++scans === 2
      ? { ok: true, stdout: 'List of devices attached\nadb-serial device transport_id:8\n' } : runAdb(args) }), false);
});
