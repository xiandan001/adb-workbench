const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: flush } = require('node:timers/promises');
const { registerFirmwareDirectWorkspace, verifyBoot } = require('../electron/lib/firmware-direct-workspace.cjs');
const { MTK_VERSION } = require('../electron/lib/firmware-direct-mtk.cjs');
const { acceptedFlashProfiles } = require('../electron/lib/firmware-direct-profiles.cjs');
const { createFirmwareDirectFlow } = require('../electron/lib/firmware-direct-flow.cjs');

const profile = {
  platform: 'mtk', mode: 'format-all-download', firmwareSha256: 'f'.repeat(64), chip: 'MT8189', toolVersion: MTK_VERSION,
  usb: { vid: '0e8d', pid: '2000', stage: 'preloader', serial: 'flash-serial' }, board: 'Fixture Board',
};
const knownMtk = { identity: 'device-approved', location: 'usb-location', vid: '0e8d', pid: '2000', serial: 'flash-serial', stage: 'preloader', port: 'COM7', label: 'Fixture USB' };
const receipt = { sha256: profile.firmwareSha256, chip: profile.chip, path: 'C:/fixture/flash.xml' };

function fixture({ profiles, checkboxChecked = false, hasTool = true, setupTool } = {}) {
  const handlers = new Map(), asks = [], reads = [], writes = [], setupCalls = [];
  const frame = {}, otherFrame = {};
  const owner = {}, event = { senderFrame: frame };
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    profiles, ownerFor: value => value.senderFrame === frame ? owner : null, getOwnerFrame: () => frame,
    isWindows: true, toolRoot: async () => 'C:/tool', canStart: () => true,
    ...(setupTool ? { prepareTool: async (...args) => { setupCalls.push(args); return setupTool(...args); } } : {}),
    ask: async options => { asks.push(options); return { response: 1, checkboxChecked }; },
    backend: {
      inspect: async () => hasTool ? { ok: true, tool: { version: profile.toolVersion } } : { ok: false, code: 'missing' },
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
  return { api, call, asks, reads, writes, setupCalls, frame, otherFrame };
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

test('Start on a host with no verified tool fails without using the explicit setup action', async () => {
  const f = fixture({ profiles: [profile], hasTool: false, setupTool: async () => ({ ok: false, cancelled: true }) });
  assert.equal((await f.call('state')).toolReady, false);
  const firmwareId = f.api.rememberFile('mtk', receipt.path, f.frame);
  assert.equal((await f.call('arm', { firmwareId, mode: profile.mode })).ok, true);
  await flush();
  assert.equal((await f.call('state')).job.phase, 'failed');
  assert.equal((await f.call('state')).job.code, 'flash-tool-unavailable');
  assert.deepEqual(f.setupCalls, []);
  assert.deepEqual(f.asks, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.call('prepare-tool', { path: 'C:/untrusted' }), { ok: false, code: 'flash-invalid-request' });
  assert.deepEqual(await f.call('prepare-tool'), { ok: false, cancelled: true });
  assert.equal(f.setupCalls.length, 1);
});

const mtkModes = ['download-only', 'firmware-upgrade', 'format-all-download'];
test('the enrolled board offers all three MTK modes without a host-specific target identity', async () => {
  assert.deepEqual(await fixture().call('state'), { ok: true, enabled: true, modes: mtkModes, busy: false, job: null });
  assert.deepEqual(acceptedFlashProfiles.map(row => [row.product, row.mode]), [
    ...mtkModes.map(mode => ['IFPD-G520', mode]), ['IFPD3576_Pro', 'upgrade'],
  ]);
  assert.ok(acceptedFlashProfiles.every(row => !row.usb.serial && !row.usb.port && !row.bootSerial));
});

function qualifiedMtk({ mode, useSavedTarget = false, checkboxChecked = false } = {}) {
  const def = acceptedFlashProfiles.find(row => row.platform === 'mtk' && row.mode === mode);
  const handlers = new Map(), asks = [], requests = [];
  const frame = {}, owner = {}, loc = 'PCIROOT(0)#USBROOT(0)#USB(1)';
  const anchor = { location: loc, vid: '0e8d', serial: 'old-serial', identity: 'a'.repeat(64) };
  const history = { location: loc, instanceId: 'USB\\VID_0E8D&PID_2000\\FIXTURE', port: 'COM3', stage: 'preloader', verified: true };
  let attached = useSavedTarget ? null : anchor, settle, remembered, rkAttached = false;
  const savedRecord = { ...anchor, instanceId: history.instanceId, port: history.port, product: def.product };
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    ownerFor: () => owner, getOwnerFrame: () => frame, isWindows: true,
    toolsIdle: async () => true, toolRoot: async () => 'C:/tool', canStart: () => true,
    ask: async value => { asks.push(value); return { response: 1, checkboxChecked }; },
    mtkBindings: { read: async () => remembered ?? (useSavedTarget ? savedRecord : null),
      remember: async value => { remembered = value; return true; } },
    windowsMtkPorts: async () => [{ ...history, id: 'a'.repeat(64) }],
    resolveMtkPort: async forUsb => forUsb.location === loc && history,
    runAdb: async args => {
      requests.push(args);
      if (args[2] === 'reboot') {
        assert.deepEqual(args, ['-t', '7', 'reboot', 'loader']);
        return { ok: false };
      }
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
        assert.equal(params.options.mode, mode);
        assert.equal(params.options.permitFormatAll, mode === 'format-all-download');
        assert.equal(await ctx.beforeDispatch(), true);
        ctx.onReady();
        return new Promise(resolve => { settle = () => { attached = { ...anchor, serial: 'new-serial', identity: 'post-flash' }; resolve({ transferCompleted: true }); }; });
      },
    },
    targetProvider: { queryDirectUsb: async () => ({ ok: true, adb: attached ? [attached] : [], mtk: [],
      rk: rkAttached ? [{ identity: 'other-rk', location: loc, vid: '2207' }] : [] }) },
    firmware: {
      prepareDirectFirmware: async () => ({ chip: def.chip, sha256: def.firmwareSha256, project: def.project, path: 'C:/input/flash.xml' }),
      revalidateDirectFirmware: async () => true,
      stageDirectFirmware: async (_p, r) => ({ firmware: { ...r, path: 'C:/staged/flash.xml' } }),
    },
  });
  const call = (verb, payload) => handlers.get('firmware:direct:' + verb)({ senderFrame: frame }, 'mtk', payload);
  const id = api.rememberFile('mtk', 'C:/input/flash.xml', frame);
  return { api, call, asks, requests, settle: () => settle(), armed: () => typeof settle === 'function',
    arm: extra => call('arm', { firmwareId: id, mode, useSavedTarget, com: 'COM99', ...extra }),
    attach: value => { attached = value; },
    attachRk: () => { rkAttached = true; },
  };
}

async function assertMtkWritten(fixture) {
  const requestsBeforeCompletion = [...fixture.requests];
  fixture.settle();
  await flush();
  const status = await fixture.call('state');
  assert.equal(status.job.phase, 'written');
  assert.equal(status.job.percent, 100);
  assert.equal(status.job.code, undefined);
  assert.equal(status.busy, false);
  assert.deepEqual(fixture.requests, requestsBeforeCompletion);
}

for (const mode of mtkModes) test('qualified MTK mode arms the reserved COM before any explicit device transition: ' + mode, async () => {
  const real = qualifiedMtk({ mode, checkboxChecked: mode === 'format-all-download' });
  const { api, call, requests, asks } = real;
  assert.equal((await real.arm()).ok, true);
  await flush();
  const waiting = (await call('state')).job;
  assert.equal(waiting.phase, 'armed');
  assert.equal(api.isProtected(), true);
  assert.equal((await call('cancel', waiting.id)).ok, false);
  assert.equal(Boolean(asks[0].checkboxLabel), mode === 'format-all-download');
  assert.ok(requests.every(args => !args.includes('reboot')));
  if (mode === 'download-only') {
    assert.equal(waiting.entryAvailable, true);
    assert.equal((await call('enter-loader', waiting.id)).ok, true);
    assert.equal((await call('enter-loader', waiting.id)).ok, false);
    assert.equal(requests.filter(args => args.includes('reboot')).length, 1);
    assert.equal((await call('state')).job.entryRequested, true);
  }
  await assertMtkWritten(real);
  assert.equal(asks.length, 1);
});

test('a saved MTK target can arm while offline and never offers an ADB reboot', async () => {
  const f = qualifiedMtk({ mode: 'download-only', useSavedTarget: true });
  assert.deepEqual((await f.call('state')).savedTarget, { label: 'IFPD-G520', port: 'COM3' });
  assert.equal((await f.arm()).ok, true);
  await flush();
  assert.ok(f.armed());
  const job = (await f.call('state')).job;
  assert.equal(job.phase, 'armed');
  assert.equal(job.entryAvailable, false);
  assert.equal((await f.call('enter-loader', job.id)).ok, false);
  assert.deepEqual(f.requests, []);
  await assertMtkWritten(f);
});

test('MTK USB registration is read-only and enables a later cold start, but COM alone cannot arm', async () => {
  const f = qualifiedMtk({ mode: 'download-only' });
  assert.equal((await f.call('state')).savedTarget, null);
  assert.equal((await f.arm({ windowsPortId: 'a'.repeat(64) })).ok, false);
  assert.deepEqual(await f.call('register-target'), { ok: true, savedTarget: { label: 'IFPD-G520', port: 'COM3' } });
  assert.equal(f.armed(), false);
  assert.deepEqual(f.asks, []);
  assert.ok(f.requests.every(args => !args.includes('reboot')));
  f.attach(null);
  const before = f.requests.length;
  assert.equal((await f.arm({ useSavedTarget: true })).ok, true);
  await flush();
  assert.equal((await f.call('state')).job.phase, 'armed');
  assert.equal((await f.call('state')).job.entryAvailable, false);
  assert.equal(f.requests.length, before);
  await assertMtkWritten(f);
});

test('MTK cold does not arm a COM reservation while an RK download device is present', async () => {
  const f = qualifiedMtk({ mode: 'download-only', useSavedTarget: true });
  f.attachRk();
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.code, 'flash-platform-mismatch');
  assert.equal(f.armed(), false);
  assert.deepEqual(f.asks, []);
});

test('a different device at the saved port and a missing format acknowledgement never arm the backend', async () => {
  const cold = qualifiedMtk({ mode: 'download-only', useSavedTarget: true });
  cold.attach({ serial: 'different', location: 'PCIROOT(0)#USBROOT(0)#USB(1)', identity: 'different' });
  await cold.arm();
  await flush();
  assert.equal((await cold.call('state')).job.code, 'flash-anchor-required');
  assert.equal(cold.armed(), false);
  const formatted = qualifiedMtk({ mode: 'format-all-download' });
  await formatted.arm({ permitFormatAll: true });
  await flush();
  assert.equal((await formatted.call('state')).job.phase, 'cancelled');
  assert.equal(formatted.armed(), false);
});

function coldRkFixture({ malformed = false, checkboxChecked = true } = {}) {
  const def = acceptedFlashProfiles.find(row => row.platform === 'rk');
  const handlers = new Map(), calls = [], frame = {}, owner = {};
  let inventory = { ok: true, adb: [], rk: [], mtk: [] }, scan, saved;
  const rk = { id: 'rk-device', location: 'PCIROOT(0)#USBROOT(0)#USB(2)', identity: 'rk-device', vid: '2207', pid: '350e',
    mode: 'loader', locationId: '10', label: 'fixture RK' };
  const fakeFlow = opts => createFirmwareDirectFlow({ ...opts, setTimer: next => { scan = next; return 1; }, clearTimer() {} });
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    ownerFor: () => owner, getOwnerFrame: () => frame, isWindows: true, createFlow: fakeFlow,
    toolsIdle: async () => { calls.push('idle'); return true; }, toolRoot: async () => 'C:/tool', canStart: () => true,
    rkBindings: { read: async () => saved, remember: async value => { saved = value; return true; } },
    runAdb: async args => ({ ok: true, stdout: args[0] === 'devices' ?
      'List of devices attached\nrk-anchor device product:IFPD3576_Pro transport_id:3\n' : 'IFPD3576_Pro\nrk3576\n1\n' }),
    ask: async () => { calls.push('confirm'); return { response: 1, checkboxChecked }; },
    backend: {
      inspect: async () => { calls.push('tool-verified'); return { ok: true, tool: { version: def.toolVersion } }; },
      listRk: async () => ({ ok: true, devices: inventory.rk }),
      prepareRk: async ({ target }) => { calls.push('chip-checked'); return { ok: true, target }; },
      write: async (_r, context) => {
        assert.equal(await context.beforeDispatch(), true);
        calls.push('write');
        return { transferCompleted: false, code: 'flash-plan-changed' };
      },
    },
    targetProvider: { queryDirectUsb: async () => { calls.push('usb-checked'); return inventory; },
      reconcileRkTargets: rows => rows },
    firmware: {
      preflightFirmware: async () => { calls.push('structure'); return malformed ? { ok: false, code: 'unsupported-format' } : { ok: true, chip: def.chip }; },
      prepareStagedDirectFirmware: async (_p, _f, { onProgress }) => {
        calls.push('one-pass-staging'); onProgress({ copiedBytes: 5, totalBytes: 10 });
        return { firmware: { path: 'C:/sealed/update.img', chip: def.chip, contentSha256: def.contentSha256 }, release: () => calls.push('release') };
      },
      revalidateDirectFirmware: async () => true,
    },
  });
  const call = (verb, payload) => handlers.get('firmware:direct:' + verb)({ senderFrame: frame }, 'rk', payload);
  const id = api.rememberFile('rk', 'C:/update.img', frame);
  return { call, calls, arm: extra => call('arm', { firmwareId: id, mode: 'upgrade', coldStart: true, ...extra }),
    attach: platform => { inventory = { ...inventory, rk: platform === 'rk' ? [rk] : [],
      adb: platform === 'adb' ? [{ location: rk.location, identity: 'c'.repeat(64), serial: 'rk-anchor', vid: rk.vid }] : [],
      mtk: platform === 'mtk' ? [{ identity: 'foreign', location: 'usb-other', vid: '0e8d' }] : [] }; },
    tick: async () => { scan?.(); await flush(); },
  };
}

test('RK cold waits without ADB and chooses only its live Loader, then runs one confirmation and guarded write', async () => {
  const f = coldRkFixture();
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.deepEqual(f.calls.slice(0, 5), ['structure', 'usb-checked', 'idle', 'tool-verified', 'one-pass-staging']);
  assert.equal(f.calls.includes('confirm'), false);
  f.attach('rk');
  await f.tick();
  const choice = (await f.call('state')).job;
  assert.equal(choice.coldStart, true);
  assert.equal(choice.phase, 'choice-required');
  assert.equal(f.calls.includes('write'), false);
  await f.call('choose', { jobId: choice.id, targetId: choice.candidates[0].id });
  await flush();
  assert.equal(f.calls.filter(value => value === 'confirm').length, 1);
  assert.ok(f.calls.indexOf('chip-checked') < f.calls.indexOf('write'));
});

test('cross-platform package, connected device and late cold arrival never start writing', async () => {
  const wrongFile = coldRkFixture({ malformed: true });
  await wrongFile.arm();
  await flush();
  assert.equal((await wrongFile.call('state')).job.code, 'flash-platform-mismatch');
  assert.deepEqual(wrongFile.calls, ['structure']);
  const early = coldRkFixture();
  early.attach('mtk');
  await early.arm();
  await flush();
  assert.equal((await early.call('state')).job.code, 'flash-platform-mismatch');
  assert.equal(early.calls.includes('one-pass-staging'), false);
  const late = coldRkFixture();
  await late.arm();
  await flush();
  late.attach('mtk');
  await late.tick();
  assert.equal((await late.call('state')).job.code, 'flash-platform-mismatch');
  assert.equal(late.calls.includes('write'), false);
});

test('RK cold selection does not write without the physical board model acknowledgement', async () => {
  const f = coldRkFixture({ checkboxChecked: false });
  await f.arm();
  await flush();
  f.attach('rk');
  await f.tick();
  const choice = (await f.call('state')).job;
  await f.call('choose', { jobId: choice.id, targetId: choice.candidates[0].id });
  await flush();
  const retry = (await f.call('state')).job;
  assert.equal(retry.phase, 'choice-required', 'the detected board remains available for an explicit retry');
  assert.equal(retry.candidates[0].id, choice.candidates[0].id);
  assert.equal(f.calls.includes('write'), false);
});

test('registered RK can arm disconnected and starts once the same port enters Loader, without a second choice', async () => {
  const f = coldRkFixture();
  f.attach('adb');
  assert.deepEqual(await f.call('register-target'), { ok: true, savedTarget: { label: 'IFPD3576_Pro' } });
  assert.equal(f.calls.includes('one-pass-staging'), false);
  assert.equal(f.calls.includes('write'), false);
  f.attach(null);
  await f.arm({ coldStart: false, useSavedTarget: true });
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.equal(f.calls.filter(value => value === 'confirm').length, 1);
  f.attach('rk');
  await f.tick();
  assert.equal(f.calls.filter(value => value === 'confirm').length, 1);
  assert.ok(f.calls.indexOf('chip-checked') < f.calls.indexOf('write'));
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
