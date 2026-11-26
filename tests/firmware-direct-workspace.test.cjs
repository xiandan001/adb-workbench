const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
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
const legacyProfiles = acceptedFlashProfiles.map(profile => profile.platform === 'mtk'
  ? { ...profile, sessionReview: false, firmwareSha256: 'b'.repeat(64) }
  : { ...profile, sessionReview: false, contentSha256: 'c'.repeat(64) });
const sessionProfiles = acceptedFlashProfiles;
function pickerValidationFixture(profiles = legacyProfiles, { askReview, revalidate } = {}) {
  const frame = {}, otherFrame = {}, owner = new EventEmitter(), handlers = new Map(), reads = [], arms = [];
  let current = frame;
  const forbidden = () => assert.fail('File-only validation must not access hardware, stage or arm');
  const api = registerFirmwareDirectWorkspace({ handle: (name, handler) => handlers.set(name, handler) }, {
    profiles, ownerFor: event => event.senderFrame === current && current ? owner : null, getOwnerFrame: () => current,
    isWindows: true, toolRoot: forbidden, canStart: () => true, toolsIdle: forbidden,
    ask: askReview || forbidden, backend: { inspect: forbidden, write: forbidden }, runAdb: forbidden,
    targetProvider: { queryDirectUsb: forbidden, watchDirectUsb: forbidden },
    firmware: {
      preflightFirmware: forbidden, prepareStagedDirectFirmware: forbidden, stageDirectFirmware: forbidden,
      revalidateDirectFirmware: revalidate || forbidden,
      prepareDirectFirmware: (platform, path, { signal }) => new Promise((resolve, reject) => {
        reads.push({ platform, path, signal, resolve, reject });
      }),
    },
    createFlow: () => ({ arm: (request, origin) => { arms.push({ request, origin }); return { ok: true }; },
      status: () => ({ busy: false, job: null }), cancelPending() {} }),
  });
  return { frame, otherFrame, owner, reads, arms, api, changeFrame: () => { current = otherFrame; },
    call: (action, payload, platform = 'mtk', senderFrame = frame) => handlers.get('firmware:direct:' + action)({ senderFrame }, platform, payload) };
}

test('read-only picker validation returns only the same qualified firmware modes as explicit arm would accept', async () => {
  const f = pickerValidationFixture();
  const file = 'C:/verified/download_agent/flash.xml';
  const mtk = legacyProfiles.find(row => row.platform === 'mtk');
  const rk = legacyProfiles.find(row => row.platform === 'rk');
  const mtkId = f.api.rememberFile('mtk', file, f.frame);
  const rkId = f.api.rememberFile('rk', 'C:/verified/update.img', f.frame);
  assert.deepEqual(await f.call('validate-file', { firmwareId: mtkId, filePath: 'C:/foreign/flash.xml' }), { ok: false, code: 'flash-invalid-request' });
  assert.deepEqual(await f.call('validate-file', { firmwareId: mtkId }, 'mtk', f.otherFrame), { ok: false, cancelled: true });
  assert.deepEqual(await f.call('validate-file', { firmwareId: rkId }), { ok: false, cancelled: true });
  assert.equal(f.reads.length, 0);
  const validated = f.call('validate-file', { firmwareId: mtkId });
  assert.equal(f.reads[0].path, file);
  f.reads[0].resolve({ chip: mtk.chip, project: mtk.project, sha256: mtk.firmwareSha256 });
  assert.deepEqual(await validated, { ok: true, modes: mtkModes });
  const wrongContent = f.call('validate-file', { firmwareId: mtkId });
  f.reads[1].resolve({ chip: mtk.chip, project: mtk.project, sha256: 'e'.repeat(64) });
  assert.deepEqual(await wrongContent, { ok: false, code: 'flash-firmware-content-unverified', fingerprint: 'e'.repeat(64) });
  const wrongProject = f.call('validate-file', { firmwareId: mtkId });
  f.reads[2].resolve({ chip: mtk.chip, project: 'other-project', sha256: mtk.firmwareSha256 });
  assert.deepEqual(await wrongProject, { ok: false, code: 'flash-profile-no-match' });
  const rkValidated = f.call('validate-file', { firmwareId: rkId }, 'rk');
  f.reads[3].resolve({ chip: rk.chip, sha256: 'e'.repeat(64), contentSha256: rk.contentSha256 });
  assert.deepEqual(await rkValidated, { ok: true, modes: ['upgrade'] });
  assert.deepEqual(f.arms, []);
  assert.equal(f.owner.listenerCount('closed'), 0);
});

test('downloading new bytes to a previously accepted path never inherits the former approval', async () => {
  const f = pickerValidationFixture();
  const filename = 'C:/same/path/download_agent/flash.xml';
  const mtk = legacyProfiles.find(row => row.platform === 'mtk');
  const oldFile = f.api.rememberFile('mtk', filename, f.frame);
  const oldCheck = f.call('validate-file', { firmwareId: oldFile });
  f.reads[0].resolve({ chip: mtk.chip, project: mtk.project, sha256: mtk.firmwareSha256 });
  assert.equal((await oldCheck).ok, true);

  const replacement = f.api.rememberFile('mtk', filename, f.frame);
  const newCheck = f.call('validate-file', { firmwareId: replacement });
  assert.equal(f.reads[1].path, f.reads[0].path);
  f.reads[1].resolve({ chip: mtk.chip, project: mtk.project, sha256: 'd'.repeat(64) });
  assert.deepEqual(await newCheck, { ok: false, code: 'flash-firmware-content-unverified', fingerprint: 'd'.repeat(64) });
  assert.deepEqual(await f.call('validate-file', { firmwareId: oldFile }), { ok: false, cancelled: true });
  assert.deepEqual(f.arms, []);
});

test('a new picker ticket for the same path aborts the old read and explicit arm only uses the latest ticket', async () => {
  const f = pickerValidationFixture();
  const path = 'C:/new/flash.xml';
  const previousId = f.api.rememberFile('mtk', path, f.frame);
  const previous = f.call('validate-file', { firmwareId: previousId });
  const newId = f.api.rememberFile('mtk', path, f.frame);
  assert.notEqual(newId, previousId);
  assert.equal(f.reads[0].signal.aborted, true);
  assert.deepEqual(await f.call('validate-file', { firmwareId: previousId }), { ok: false, cancelled: true });
  const next = f.call('validate-file', { firmwareId: newId });
  const mtk = legacyProfiles.find(row => row.platform === 'mtk');
  const approved = { chip: mtk.chip, project: mtk.project, sha256: mtk.firmwareSha256 };
  assert.equal(f.reads[1].path, path);
  f.reads[0].resolve(approved);
  assert.deepEqual(await previous, { ok: false, cancelled: true });
  f.reads[1].resolve(approved);
  assert.deepEqual(await next, { ok: true, modes: mtkModes });
  assert.deepEqual(await f.call('arm', { firmwareId: previousId, mode: mtk.mode }), { ok: false, code: 'flash-firmware-unavailable' });
  assert.deepEqual(await f.call('arm', { firmwareId: newId, mode: mtk.mode }), { ok: true });
  assert.equal(f.arms.length, 1);
  assert.equal(f.arms[0].request.firmwareId, newId);
  assert.equal(f.arms[0].request.filePath, path);
  assert.equal(f.arms[0].origin, f.frame);
});

test('superseded validation, an invalid picker selection, and owner loss never publish a late result', async () => {
  const f = pickerValidationFixture();
  const firmwareId = f.api.rememberFile('mtk', 'C:/verified/flash.xml', f.frame);
  const old = f.call('validate-file', { firmwareId });
  const latest = f.call('validate-file', { firmwareId });
  assert.equal(f.reads[0].signal.aborted, true);
  assert.equal(f.reads[1].signal.aborted, false);
  f.api.forgetFile('mtk', f.otherFrame);
  assert.equal(f.reads[1].signal.aborted, false);
  f.api.forgetFile('mtk', f.frame);
  assert.equal(f.reads[1].signal.aborted, true);
  f.reads[0].reject(Object.assign(new Error('old'), { code: 'cancelled' }));
  f.reads[1].resolve({});
  assert.deepEqual(await old, { ok: false, cancelled: true });
  assert.deepEqual(await latest, { ok: false, cancelled: true });
  assert.deepEqual(await f.call('validate-file', { firmwareId }), { ok: false, cancelled: true });
  assert.deepEqual(await f.call('arm', { firmwareId, mode: mtkModes[0] }), { ok: false, code: 'flash-firmware-unavailable' });

  const changingId = f.api.rememberFile('mtk', 'C:/verified/flash.xml', f.frame);
  const changing = f.call('validate-file', { firmwareId: changingId });
  f.changeFrame();
  f.reads[2].resolve({});
  assert.deepEqual(await changing, { ok: false, cancelled: true });
  const closedId = f.api.rememberFile('mtk', 'C:/verified/flash.xml', f.otherFrame);
  const closed = f.call('validate-file', { firmwareId: closedId }, 'mtk', f.otherFrame);
  f.owner.emit('closed');
  assert.equal(f.reads[3].signal.aborted, true);
  f.reads[3].reject(new Error('closed'));
  assert.deepEqual(await closed, { ok: false, cancelled: true });
  assert.equal(f.owner.listenerCount('closed'), 0);
  assert.deepEqual(f.arms, []);
});

test('the enrolled board offers all three MTK modes without a host-specific target identity', async () => {
  assert.deepEqual(await fixture().call('state'), { ok: true, enabled: true, modes: mtkModes,
    sessionReviewRequired: true, mtkAutoPowerOn: true, busy: false, job: null });
  assert.deepEqual(acceptedFlashProfiles.map(row => [row.product, row.mode]), [
    ...mtkModes.map(mode => ['IFPD-G520', mode]), ['IFPD3576_Pro', 'upgrade'],
  ]);
  assert.ok(acceptedFlashProfiles.every(row => !row.usb.serial && !row.usb.port && !row.bootSerial));
  assert.ok(acceptedFlashProfiles.every(row => row.sessionReview === true && !row.firmwareSha256 && !row.contentSha256 && !row.boot));
});

const newPackageHash = 'c'.repeat(64);
async function validateSessionPackage(f, platform, firmwareId, path) {
  const profile = sessionProfiles.find(row => row.platform === platform);
  const reading = f.call('validate-file', { firmwareId }, platform);
  f.reads.at(-1).resolve({ path, chip: profile.chip, project: profile.project, sha256: newPackageHash,
    files: [{ path, identity: 'current-file' }] });
  return reading;
}

for (const platform of ['rk', 'mtk']) test(platform + ' new package review is tied to the file, mode and source stamp', async () => {
  let answer = { response: 1, checkboxChecked: true };
  const prompts = [], stamps = [];
  const f = pickerValidationFixture(sessionProfiles, {
    askReview: async options => { prompts.push(options); return answer; },
    revalidate: async receipt => { stamps.push(receipt.files[0].identity); return true; },
  });
  const path = platform === 'rk' ? 'C:/selected/new.img' : 'C:/selected/new.xml';
  const firmwareId = f.api.rememberFile(platform, path, f.frame);
  const modes = platform === 'rk' ? ['upgrade'] : mtkModes;
  const profile = sessionProfiles.find(row => row.platform === platform);
  assert.deepEqual(await validateSessionPackage(f, platform, firmwareId, path),
    { ok: true, reviewRequired: true, modes, fingerprint: newPackageHash, board: profile.board });
  const arm = mode => f.call('arm', { firmwareId, mode }, platform);
  const review = mode => f.call('review-file', { firmwareId, mode }, platform);
  assert.deepEqual(await arm(modes[0]), { ok: false, code: 'flash-firmware-review-required' });
  assert.equal(prompts.length, 0);
  assert.deepEqual(await review(modes[0]), { ok: true, mode: modes[0] });
  assert.equal(f.arms.length, 0, 'The check and review themselves never arm any job');
  assert.deepEqual(stamps, ['current-file', 'current-file']);
  assert.ok(prompts[0].detail.includes(profile.board) && prompts[0].detail.includes(newPackageHash));
  assert.match(prompts[0].checkboxLabel, /可信渠道/);
  if (platform === 'mtk') {
    answer = { response: 1, checkboxChecked: false };
    assert.deepEqual(await review(modes[2]), { ok: false, cancelled: true });
    assert.match(prompts[1].detail, /格式化后下载.*清除存储/s);
    assert.deepEqual(await arm(modes[2]), { ok: false, code: 'flash-firmware-review-required' });
  }
  assert.deepEqual(await arm(modes[0]), { ok: true });
  if (platform === 'mtk') {
    answer = { response: 1, checkboxChecked: true };
    assert.deepEqual(await review(modes[2]), { ok: true, mode: modes[2] });
    assert.deepEqual(await arm(modes[0]), { ok: false, code: 'flash-firmware-review-required' });
    assert.deepEqual(await arm(modes[2]), { ok: true });
  }
  await validateSessionPackage(f, platform, firmwareId, path);
  assert.deepEqual(await arm(modes.at(-1)), { ok: false, code: 'flash-firmware-review-required' });
});

test('changed source stamps or in-flight picker replacement revoke session review instead of approving', async () => {
  let complete;
  let unchanged = true;
  const f = pickerValidationFixture(sessionProfiles, {
    askReview: () => new Promise(resolve => { complete = resolve; }),
    revalidate: async () => unchanged,
  });
  const path = 'C:/selected/new.xml', mode = 'download-only';
  const first = f.api.rememberFile('mtk', path, f.frame);
  await validateSessionPackage(f, 'mtk', first, path);
  const prompt = f.call('review-file', { firmwareId: first, mode });
  await flush();
  assert.deepEqual(await f.call('arm', { firmwareId: first, mode }), { ok: false, code: 'flash-busy' });
  const second = f.api.rememberFile('mtk', path, f.frame);
  await validateSessionPackage(f, 'mtk', second, path);
  complete({ response: 1, checkboxChecked: true });
  assert.deepEqual(await prompt, { ok: false, cancelled: true });
  assert.deepEqual(await f.call('arm', { firmwareId: second, mode }), { ok: false, code: 'flash-firmware-review-required' });
  const secondPrompt = f.call('review-file', { firmwareId: second, mode });
  await flush();
  unchanged = false;
  complete({ response: 1, checkboxChecked: true });
  assert.deepEqual(await secondPrompt, { ok: false, code: 'flash-firmware-changed' });
  assert.deepEqual(await f.call('arm', { firmwareId: second, mode }), { ok: false, code: 'flash-firmware-review-required' });
  assert.deepEqual(f.arms, []);
});

function qualifiedMtk({ mode, useSavedTarget = false, checkboxChecked = false } = {}) {
  const def = legacyProfiles.find(row => row.platform === 'mtk' && row.mode === mode);
  const handlers = new Map(), asks = [], requests = [];
  const frame = {}, owner = {}, loc = 'PCIROOT(0)#USBROOT(0)#USB(1)';
  const anchor = { location: loc, vid: '0e8d', serial: 'old-serial', identity: 'a'.repeat(64) };
  const history = { location: loc, instanceId: 'USB\\VID_0E8D&PID_2000\\FIXTURE', port: 'COM3', stage: 'preloader', verified: true };
  let attached = useSavedTarget ? null : anchor, settle, remembered, rkAttached = false;
  const savedRecord = { ...anchor, instanceId: history.instanceId, port: history.port, product: def.product };
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    profiles: legacyProfiles,
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
      const stdout = 'IFPD-G520\nmt8189\n1\n';
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

function coldMtkFixture({ mode = 'download-only', checked = true, duringConfirm, watchdog = true,
  deferWatchReady = false, stagedDigest, checkedDigest, sessionReview = false, holdWriter = false,
  confirmChecked = checked, confirmResponse = 1, quick = false, quickStageError, quickLeaseActive = true } = {}) {
  const profiles = sessionReview ? sessionProfiles : legacyProfiles;
  const profile = profiles.find(row => row.platform === 'mtk' && row.mode === mode);
  const reviewedPath = 'C:/sealed-source/flash.xml';
  const handlers = new Map(), frame = {}, owner = {}, writes = [], confirmations = [], reads = [];
  const preloader = {
    vid: '0e8d', pid: '2000', stage: 'preloader', label: 'Fixture Preloader',
    port: 'COM7', instanceId: 'USB\\VID_0E8D&PID_2000\\FIXTURE',
    location: 'PCIROOT(0)#USBROOT(0)#USB(1)', identity: 'a'.repeat(64),
  };
  const inventory = () => ({ ok: true, adb: [], rk, mtk });
  let scan, observe, vendor, stopped = false, mtk = [], rk = [], reservations = [], reserveReads = 0, releases = 0, registrations = 0;
  let quickStages = 0, usbReads = 0;
  const call = (verb, payload) => handlers.get('firmware:direct:' + verb)({ senderFrame: frame }, 'mtk', payload);
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    profiles,
    ownerFor: () => owner, getOwnerFrame: () => frame, isWindows: true,
    createFlow: opts => createFirmwareDirectFlow({ ...opts, setTimer: next => { scan = next; return 1; }, clearTimer() {} }),
    toolsIdle: async () => true, toolRoot: async () => 'C:/tool', canStart: () => true,
    ask: async options => {
      confirmations.push(options);
      duringConfirm?.(controls, options);
      return options.title === '核对本次固件'
        ? { response: 1, checkboxChecked: checked } : { response: confirmResponse, checkboxChecked: confirmChecked };
    },
    runAdb: async () => assert.fail('Cold MTK must not query or reboot through ADB'),
    resolveMtkPort: async () => assert.fail('Cold MTK must not need an ADB-to-COM binding'),
    mtkBindings: {
      read: async () => null,
      remember: async () => { registrations++; return true; },
    },
    windowsMtkPorts: async () => { reserveReads++; return reservations; },
    backend: {
      inspect: async () => ({ ok: true, tool: { version: MTK_VERSION } }),
      async write(plan, ctx) {
        if (!await ctx.beforeDispatch()) return { transferCompleted: false, code: 'flash-plan-changed' };
        assert.equal(stopped, watchdog);
        writes.push(plan);
        if (holdWriter) return new Promise(resolve => { vendor = { ...ctx, settle: resolve }; });
        ctx.onReady?.({ timeoutMs: 8000 });
        ctx.onProgress(null, { stage: 'connecting' });
        return { transferCompleted: true };
      },
    },
    targetProvider: {
      queryDirectUsb: async () => { usbReads++; return inventory(); },
      ...(watchdog ? { watchDirectUsb: ({ onSnapshot }) => {
        observe = onSnapshot;
        if (!deferWatchReady) observe(inventory());
        return () => { stopped = true; };
      } } : {}),
    },
    firmware: {
      prepareDirectFirmware: async (_platform, file) => {
        if (quick) assert.fail('Quick MTK should skip whole-package hashing');
        reads.push(file);
        return { chip: profile.chip, sha256: checkedDigest ?? profile.firmwareSha256, project: profile.project,
          path: sessionReview ? reviewedPath : file, files: [{ path: reviewedPath, identity: 'fixture' }] };
      },
      ...(quick ? {
        prepareMtkQuickReview: async file => {
          reads.push(file);
          return { chip: profile.chip, project: profile.project,
            path: reviewedPath, files: [{ path: reviewedPath, identity: 'fixture' }] };
        },
        stageMtkQuickReview: async receipt => {
          quickStages++;
          if (quickStageError) throw Object.assign(new Error(quickStageError), { code: quickStageError });
          const path = 'C:/veylo-flash-abc/download_agent/flash.xml';
          return { firmware: { ...receipt, path }, protectedFiles: [path], isActive: () => quickLeaseActive,
            release: () => { releases++; } };
        },
      } : {}),
      ...(stagedDigest === undefined ? {} : {
        preflightFirmware: async (_platform, file) => {
          reads.push(file);
          return { ok: true, chip: profile.chip, project: profile.project };
        },
        prepareStagedDirectFirmware: async (_platform, source, { onProgress }) => {
          if (sessionReview) assert.equal(source, reviewedPath, 'Stage only the path captured by the trusted read-only receipt');
          onProgress({ copiedBytes: 6, totalBytes: 100 });
          onProgress({ copiedBytes: 100, totalBytes: 100 });
          return {
            firmware: { path: 'C:/staged/flash.xml', chip: profile.chip, project: profile.project, sha256: stagedDigest },
            release: () => { releases++; },
          };
        },
      }),
      revalidateDirectFirmware: async () => true,
      stageDirectFirmware: async (_platform, receipt) => ({ firmware: { ...receipt, path: 'C:/staged/flash.xml' } }),
    },
  });
  const id = api.rememberFile('mtk', 'C:/input/flash.xml', frame);
  const controls = {
    api, call, confirmations, writes, reads, preloader,
    vendor: () => vendor,
    registrations: () => registrations,
    releases: () => releases,
    quickStages: () => quickStages,
    usbReads: () => usbReads,
    validateFile: () => call('validate-file', { firmwareId: id }),
    reviewFile: () => call('review-file', { firmwareId: id, mode }),
    arm: extra => call('arm', { firmwareId: id, coldStart: true, mode, ...extra }),
    targets: values => { mtk = values; },
    foreign: () => { rk = [{ identity: 'rk', location: preloader.location }]; },
    reserve: options => { reservations = [{ ...preloader, verified: true, ...options }]; },
    reserveReads: () => reserveReads,
    observe: (values = mtk) => observe?.({ ...inventory(), mtk: values }),
    tick: async () => { scan?.(); await flush(); },
    choose: async () => {
      const { job } = await call('state');
      assert.equal(job.phase, 'choice-required');
      assert.equal(job.candidates.length, 1);
      return call('choose', { jobId: job.id, targetId: job.candidates[0].id });
    },
  };
  return controls;
}

test('MTK pins eligible XML quickly and requires just one real job confirmation before protected dispatch', async () => {
  const mode = 'format-all-download';
  const f = coldMtkFixture({ mode, quick: true, sessionReview: true, watchdog: false, holdWriter: true });
  assert.equal((await f.call('state')).mtkFastReview, true);
  assert.equal((await f.arm()).code, 'flash-firmware-review-required');
  const check = await f.validateFile();
  assert.equal(check.quickReview, true);
  assert.equal(check.fingerprint, undefined);
  assert.equal((await f.reviewFile()).ok, false);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.usbReads(), 0);
  assert.equal(f.quickStages(), 0);

  assert.equal((await f.arm()).ok, true);
  await flush();
  assert.equal((await f.call('state')).job.phase, 'authorizing');
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].detail, /可信渠道/);
  assert.match(f.confirmations[0].checkboxLabel, /格式化会清除数据/);
  assert.equal(f.quickStages(), 1);
  assert.equal(f.usbReads(), 2, 'one initial inventory and one last check at start');
  assert.deepEqual(f.writes[0].options.protectedFiles, ['C:/veylo-flash-abc/download_agent/flash.xml']);
  const vendor = f.vendor();
  vendor.onReady({ timeoutMs: 8000 });
  assert.equal((await f.call('state')).job.phase, 'armed');
  vendor.settle({ transferCompleted: false, code: 'mtk-wait-expired' });
  await flush();
  assert.equal(f.releases(), 1);
});

test('MTK quick flow never dispatches after refusal, file change or loss of the file lease', async () => {
  for (const verification of [
    { confirmChecked: false, expected: 'flash-cancelled', stage: 0 },
    { quickStageError: 'firmware-changed', expected: 'flash-firmware-changed', stage: 1 },
    { quickLeaseActive: false, expected: 'flash-plan-changed', stage: 1 },
  ]) {
    const f = coldMtkFixture({ ...verification, mode: 'format-all-download', quick: true, sessionReview: true, watchdog: false });
    assert.equal((await f.validateFile()).ok, true);
    assert.equal((await f.arm()).ok, true);
    await flush();
    assert.equal((await f.call('state')).job.code, verification.expected);
    assert.equal(f.quickStages(), verification.stage);
    assert.deepEqual(f.writes, []);
  }
});

test('quick MTK reuses one USB watcher and requires a new sample before launching', async () => {
  const f = coldMtkFixture({ quick: true, sessionReview: true, watchdog: true, holdWriter: true });
  await f.validateFile();
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'authorizing');
  assert.equal(f.usbReads(), 0);
  assert.equal(f.writes.length, 0, 'the initial empty snapshot alone cannot authorize launch');
  f.observe([f.preloader]);
  await flush();
  assert.equal((await f.call('state')).job.code, 'flash-mtk-auto-target-present');
  assert.deepEqual(f.writes, []);

  const clean = coldMtkFixture({ quick: true, sessionReview: true, watchdog: true, holdWriter: true });
  await clean.validateFile();
  await clean.arm();
  await flush();
  clean.observe([]);
  await flush();
  assert.equal(clean.usbReads(), 0);
  assert.equal(clean.writes.length, 1);
  clean.vendor().settle({ transferCompleted: false, code: 'mtk-wait-expired' });
  await flush();
});

test('MTK can prepare for the first power-on without ADB, reservation or choosing a COM port', async () => {
  const mode = 'format-all-download';
  const f = coldMtkFixture({ mode, holdWriter: true, sessionReview: true, watchdog: false,
    checkedDigest: newPackageHash, stagedDigest: newPackageHash });
  const state = await f.call('state');
  assert.equal(state.savedTarget, null);
  assert.equal(state.mtkAutoPowerOn, true);
  assert.equal((await f.arm()).code, 'flash-firmware-review-required');
  assert.equal((await f.validateFile()).fingerprint, newPackageHash);
  assert.deepEqual(await f.reviewFile(), { ok: true, mode });
  assert.equal((await f.arm({ mode: 'download-only' })).code, 'flash-firmware-review-required');
  assert.deepEqual(f.writes, []);
  const initial = await f.arm();
  assert.equal(initial.ok, true);
  await flush();
  const authorizing = (await f.call('state')).job;
  assert.equal(authorizing.phase, 'authorizing');
  assert.equal(authorizing.autoPowerOn, true);
  assert.equal(f.confirmations.length, 2);
  const { checkboxLabel, message, detail } = f.confirmations[1];
  assert.match(checkboxLabel, /格式化/);
  const approvalCopy = [checkboxLabel, message, detail].join('\n');
  assert.match(approvalCopy, /只.*一台|仅.*一台/);
  assert.match(approvalCopy, /板卡|型号/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].target.verified, true);
  assert.equal(f.writes[0].target.stage, 'preloader-auto');
  assert.equal(f.writes[0].target.port, undefined);
  assert.equal(f.writes[0].target.instanceId, undefined);
  assert.equal(f.writes[0].options.mode, mode);
  assert.equal(f.writes[0].options.permitFormatAll, true);
  assert.equal(f.writes[0].firmware.sha256, newPackageHash);
  assert.equal(f.reserveReads(), 0);

  const vendor = f.vendor();
  vendor.onProgress(12, { stage: 'writing' });
  assert.equal((await f.call('state')).job.phase, 'authorizing');
  vendor.onReady({ timeoutMs: 8000 });
  const armed = (await f.call('state')).job;
  assert.equal(armed.phase, 'armed');
  assert.equal(armed.autoPowerOn, true);
  assert.notEqual(armed.entryAvailable, true);
  assert.equal((await f.call('enter-loader', armed.id)).ok, false);
  assert.deepEqual(armed.candidates, []);

  f.targets([f.preloader]);
  vendor.onProgress(24, { stage: 'writing' });
  const writing = (await f.call('state')).job;
  assert.equal(writing.phase, 'writing');
  assert.equal(writing.percent, 24);
  vendor.settle({ transferCompleted: true });
  await flush();
  const done = await f.call('state');
  assert.equal(done.job.phase, 'written');
  assert.equal(done.job.percent, 100);
  assert.equal(done.savedTarget, null);
  assert.equal(f.registrations(), 0);
});

test('MTK automatic power-on never launches before explicit consent or with a download device already present', async () => {
  const mode = 'format-all-download';
  const cases = [
    { name: 'unchecked confirmation', phase: 'cancelled', confirmChecked: false },
    { name: 'declined confirmation', phase: 'cancelled', confirmResponse: 0 },
    { name: 'preloader present before starting', phase: 'failed', beforehand: f => f.targets([f.preloader]) },
    { name: 'RK present before starting', phase: 'failed', beforehand: f => f.foreign() },
    { name: 'preloader appeared during confirmation', phase: 'failed', afterReview: f => f.targets([f.preloader]) },
    { name: 'RK appeared during confirmation', phase: 'failed', afterReview: f => f.foreign() },
  ];
  for (const { name, phase, beforehand, afterReview, ...confirmation } of cases) {
    const f = coldMtkFixture({ mode, watchdog: false, sessionReview: true, checkedDigest: newPackageHash,
      stagedDigest: newPackageHash, ...confirmation,
      duringConfirm: (subject, options) => { if (options.title !== '核对本次固件') afterReview?.(subject); } });
    assert.equal((await f.validateFile()).reviewRequired, true, name);
    assert.deepEqual(await f.reviewFile(), { ok: true, mode }, name);
    beforehand?.(f);
    assert.equal((await f.arm()).ok, true, name);
    await flush();
    const { job } = await f.call('state');
    assert.equal(job.phase, phase, name);
    assert.equal(job.code, phase === 'failed' ? 'flash-mtk-auto-target-present' : 'flash-cancelled', name);
    assert.deepEqual(f.writes, [], name);
    assert.equal(f.registrations(), 0, name);
  }
});

test('MTK matching XML structure with a different complete staged digest is rejected before waiting or writing', async () => {
  const f = coldMtkFixture({ mode: 'format-all-download', stagedDigest: 'e'.repeat(64), watchdog: false });
  assert.equal((await f.arm()).ok, true);
  await flush();
  assert.equal((await f.call('state')).job.code, 'flash-firmware-content-unverified');
  assert.equal((await f.call('state')).job.phase, 'failed');
  assert.equal(f.releases(), 1);
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.writes, []);
});

test('the attested MTK digest still enters cold waiting with the same mode and approved tool', async () => {
  const attested = legacyProfiles.find(row => row.platform === 'mtk' && row.mode === 'format-all-download');
  const f = coldMtkFixture({ mode: attested.mode, stagedDigest: attested.firmwareSha256, watchdog: false });
  await f.arm();
  await flush();
  const { job } = await f.call('state');
  assert.equal(job.phase, 'waiting');
  assert.equal(f.releases(), 0);
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.writes, []);
  await f.call('cancel', job.id);
  await flush();
  assert.equal(f.releases(), 1);
});

test('read-only receipts keep metadata support distinct from complete content admission', async () => {
  const f = coldMtkFixture({ checkedDigest: 'e'.repeat(64), watchdog: false });
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.code, 'flash-firmware-content-unverified');
  assert.deepEqual(f.writes, []);
});

test('a newly reviewed MTK package cannot write if the sealed snapshot differs from review', async () => {
  const mode = 'format-all-download';
  const setup = stagedDigest => coldMtkFixture({ mode, sessionReview: true, watchdog: false,
    checkedDigest: newPackageHash, stagedDigest });
  const changed = setup('e'.repeat(64));
  assert.equal((await changed.validateFile()).reviewRequired, true);
  assert.deepEqual(await changed.reviewFile(), { ok: true, mode });
  await changed.arm();
  await flush();
  assert.equal((await changed.call('state')).job.code, 'flash-firmware-changed');
  assert.deepEqual(changed.writes, []);
  assert.equal(changed.releases(), 1);
  assert.deepEqual(await changed.arm(), { ok: false, code: 'flash-firmware-review-required' });
});

for (const mode of mtkModes) test('unregistered MTK waits for an exact Preloader and always confirms it: ' + mode, async () => {
  const f = coldMtkFixture({ mode, watchdog: false });
  assert.equal((await f.arm({ targetHint: 'device' })).code, 'flash-invalid-request');
  assert.equal((await f.arm({ useSavedTarget: true })).code, 'flash-invalid-request');
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.writes, []);
  f.targets([f.preloader]);
  await f.tick();
  assert.deepEqual(f.writes, []);
  await f.choose();
  await flush();
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].checkboxLabel, mode === 'format-all-download' ? /型号.*格式化/ : /MTK.*型号/);
  assert.deepEqual(f.reads, ['C:/input/flash.xml']);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].target.instanceId, f.preloader.instanceId);
  assert.equal(f.writes[0].target.port, 'COM7');
  assert.equal(f.writes[0].options.elevated, true);
  assert.equal(f.writes[0].options.permitFormatAll, mode === 'format-all-download');
  assert.equal(f.reserveReads(), 0);
  assert.equal((await f.call('state')).job.phase, 'written');
});

test('a transient MTK Preloader can only use its own observed, detached Windows reservation', async () => {
  const f = coldMtkFixture();
  f.reserve();
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.equal(f.reserveReads(), 0, 'Windows history alone cannot nominate an unregistered target');
  f.observe([f.preloader]);
  f.observe([]);
  await f.tick();
  await f.choose();
  await flush();
  assert.equal(f.reserveReads(), 1);
  assert.equal(f.writes[0]?.target.port, 'COM7');
  assert.equal(f.writes[0]?.target.instanceId, f.preloader.instanceId);
  assert.equal((await f.call('state')).job.phase, 'written');
});

test('MTK does not ask to power on before the streaming inventory has started', async () => {
  const f = coldMtkFixture({ deferWatchReady: true });
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'preparing');
  f.observe();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.deepEqual(f.writes, []);
});

test('cold MTK never writes an unconfirmed, ambiguous, reassigned or cross-platform USB target', async () => {
  for (const failure of ['unchecked', 'ambiguous', 'changed-reservation', 'changed-live', 'foreign-platform']) {
    const f = coldMtkFixture({
      checked: failure !== 'unchecked',
      duringConfirm: controls => {
        if (failure === 'changed-reservation') controls.reserve({ port: 'COM8' });
        if (failure === 'changed-live') {
          controls.targets([{ ...controls.preloader, instanceId: 'USB\\VID_0E8D&PID_2000\\DIFFERENT', identity: 'b'.repeat(64) }]);
        }
        if (failure === 'foreign-platform') controls.foreign();
      },
    });
    await f.arm();
    await flush();
    if (failure === 'ambiguous') {
      f.observe([f.preloader, { ...f.preloader, port: 'COM8', identity: 'b'.repeat(64) }]);
      await f.tick();
      assert.equal((await f.call('state')).job.phase, 'waiting');
      assert.deepEqual(f.confirmations, []);
    } else {
      f.observe([f.preloader]);
      await f.tick();
      await f.choose();
      await flush();
      if (failure !== 'unchecked') assert.equal((await f.call('state')).job.phase, 'failed');
    }
    assert.deepEqual(f.writes, [], failure);
  }
});

function coldRkFixture({ malformed = false, checkboxChecked = true, sessionReview = false, stagedDigest = 'c'.repeat(64) } = {}) {
  const profiles = sessionReview ? sessionProfiles : legacyProfiles;
  const def = profiles.find(row => row.platform === 'rk');
  const handlers = new Map(), calls = [], frame = {}, owner = {};
  let inventory = { ok: true, adb: [], rk: [], mtk: [] }, scan, saved, cliReady = true;
  const rk = { id: 'rk-device', location: 'PCIROOT(0)#USBROOT(0)#USB(2)', identity: 'rk-device', vid: '2207', pid: '350e',
    mode: 'loader', locationId: '10', label: 'fixture RK' };
  const fakeFlow = opts => createFirmwareDirectFlow({ ...opts, setTimer: next => { scan = next; return 1; }, clearTimer() {} });
  const api = registerFirmwareDirectWorkspace({ handle: (key, value) => handlers.set(key, value) }, {
    profiles,
    ownerFor: () => owner, getOwnerFrame: () => frame, isWindows: true, createFlow: fakeFlow,
    toolsIdle: async () => { calls.push('idle'); return true; }, toolRoot: async () => 'C:/tool', canStart: () => true,
    rkBindings: { read: async () => saved, remember: async value => { saved = value; return true; } },
    runAdb: async args => ({ ok: true, stdout: args[0] === 'devices' ?
      'List of devices attached\nrk-anchor device product:IFPD3576_Pro transport_id:3\n' : 'IFPD3576_Pro\nrk3576\n1\n' }),
    ask: async () => { calls.push('confirm'); return { response: 1, checkboxChecked }; },
    backend: {
      inspect: async () => { calls.push('tool-verified'); return { ok: true, tool: { version: def.toolVersion } }; },
      listRk: async () => { calls.push('vendor-list'); return cliReady ? { ok: true, devices: inventory.rk } : { ok: false }; },
      prepareRk: async ({ target, beforeRamBoot }) => {
        if (sessionReview) assert.equal(await beforeRamBoot(), true);
        calls.push('chip-checked'); return { ok: true, target };
      },
      write: async (_r, context) => {
        assert.equal(await context.beforeDispatch(), true);
        calls.push('write');
        return { transferCompleted: false, code: 'flash-plan-changed' };
      },
    },
    targetProvider: { queryDirectUsb: async () => { calls.push('usb-checked'); return inventory; },
      reconcileRkTargets: rows => rows },
    firmware: {
      prepareDirectFirmware: async () => ({ path: 'C:/update.img', chip: def.chip, sha256: 'c'.repeat(64),
        contentSha256: 'd'.repeat(64), files: [{ path: 'C:/update.img', identity: 'fixture' }] }),
      preflightFirmware: async () => { calls.push('structure'); return malformed ? { ok: false, code: 'unsupported-format' } : { ok: true, chip: def.chip }; },
      prepareStagedDirectFirmware: async (_p, _f, { onProgress }) => {
        calls.push('one-pass-staging'); onProgress({ copiedBytes: 5, totalBytes: 10 });
        return { firmware: { path: 'C:/sealed/update.img', chip: def.chip, sha256: stagedDigest, contentSha256: def.contentSha256 }, release: () => calls.push('release') };
      },
      revalidateDirectFirmware: async () => true,
    },
  });
  const call = (verb, payload) => handlers.get('firmware:direct:' + verb)({ senderFrame: frame }, 'rk', payload);
  const id = api.rememberFile('rk', 'C:/update.img', frame);
  return { call, calls, arm: extra => call('arm', { firmwareId: id, mode: 'upgrade', coldStart: true, ...extra }),
    validateFile: () => call('validate-file', { firmwareId: id }),
    reviewFile: () => call('review-file', { firmwareId: id, mode: 'upgrade' }),
    attach: platform => { inventory = { ...inventory, rk: platform === 'rk' ? [rk] : [],
      adb: platform === 'adb' ? [{ location: rk.location, identity: 'c'.repeat(64), serial: 'rk-anchor', vid: rk.vid }] : [],
      mtk: platform === 'mtk' ? [{ identity: 'foreign', location: 'usb-other', vid: '0e8d' }] : [] }; },
    setCliReady: value => { cliReady = value; },
    tick: async () => { scan?.(); await flush(); },
  };
}

test('RK cold waits without ADB and chooses only its live Loader, then runs one confirmation and guarded write', async () => {
  const f = coldRkFixture();
  await f.arm();
  await flush();
  assert.equal((await f.call('state')).job.phase, 'waiting');
  assert.deepEqual(f.calls.slice(0, 5), ['structure', 'usb-checked', 'idle', 'tool-verified', 'one-pass-staging']);
  assert.equal(f.calls.includes('vendor-list'), false, 'No Rockusb CLI polling while Windows shows no RK device');
  assert.equal(f.calls.includes('confirm'), false);
  f.attach('rk');
  f.setCliReady(false);
  await f.tick();
  assert.equal((await f.call('state')).job.phase, 'waiting', 'A transitory CLI failure while USB initializes remains waiting');
  f.setCliReady(true);
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

test('a newly reviewed RK image requires the same sealed digest and still runs both hardware checks and write gate', async () => {
  const changed = coldRkFixture({ sessionReview: true, stagedDigest: 'e'.repeat(64) });
  assert.equal((await changed.validateFile()).reviewRequired, true);
  assert.deepEqual(await changed.reviewFile(), { ok: true, mode: 'upgrade' });
  await changed.arm();
  await flush();
  assert.equal((await changed.call('state')).job.code, 'flash-firmware-changed');
  assert.equal(changed.calls.includes('chip-checked'), false);
  assert.equal(changed.calls.includes('write'), false);

  const intact = coldRkFixture({ sessionReview: true });
  assert.equal((await intact.validateFile()).fingerprint, newPackageHash);
  assert.deepEqual(await intact.reviewFile(), { ok: true, mode: 'upgrade' });
  await intact.arm();
  await flush();
  assert.equal((await intact.call('state')).job.phase, 'waiting');
  intact.attach('rk');
  await intact.tick();
  const choice = (await intact.call('state')).job;
  assert.equal(choice.phase, 'choice-required');
  assert.equal(intact.calls.includes('write'), false);
  await intact.call('choose', { jobId: choice.id, targetId: choice.candidates[0].id });
  await flush();
  assert.equal(intact.calls.filter(value => value === 'confirm').length, 2);
  assert.ok(intact.calls.indexOf('chip-checked') >= 0);
  assert.ok(intact.calls.indexOf('chip-checked') < intact.calls.indexOf('write'));
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

test('reviewed RK verifies its same-port model, board platform and completed boot without a permanent build fingerprint', async () => {
  const profile = sessionProfiles.find(value => value.platform === 'rk');
  const p = { platform: 'rk', profile, sessionReview: {} };
  const target = { vid: '2207', serial: 'rk-serial', identity: 'rk-adb-device', location: 'selected-port' };
  let properties = 'IFPD3576_Pro\nrk3576\n1\n', transport = 7;
  const queryUsb = async () => ({ ok: true, adb: [target] });
  const runAdb = async args => {
    if (args[0] === 'devices') return { ok: true, stdout: `List of devices attached\nrk-serial device product:IFPD3576_Pro transport_id:${transport}\n` };
    assert.deepEqual(args, ['-t', '7', 'shell', 'getprop ro.product.model; getprop ro.board.platform; getprop sys.boot_completed']);
    return { ok: true, stdout: properties };
  };
  const candidate = { location: target.location };
  assert.equal(await verifyBoot(p, candidate, { queryUsb, runAdb, retries: 1 }), true);
  assert.equal(await verifyBoot(p, { location: 'different-port' }, { queryUsb, runAdb, retries: 1 }), false);
  properties = 'IFPD3576_Pro\nrk3588\n1\n';
  assert.equal(await verifyBoot(p, candidate, { queryUsb, runAdb, retries: 1 }), false);
  properties = 'IFPD3576_Pro\nrk3576\n0\n';
  assert.equal(await verifyBoot(p, candidate, { queryUsb, runAdb, retries: 1 }), false);
  properties = 'IFPD3576_Pro\nrk3576\n1\n';
  assert.equal(await verifyBoot(p, candidate, { queryUsb, retries: 1, runAdb: async args => {
    const result = await runAdb(args);
    if (args[2] === 'shell') transport = 8;
    return result;
  } }), false);
});
