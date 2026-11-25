const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { createDirectFlashBackends } = require('../electron/lib/firmware-direct-backends.cjs');
const { MTK_VERSION } = require('../electron/lib/firmware-direct-mtk.cjs');
const { mtk: knownMtk } = require('../electron/lib/firmware-tools-vendor.json');

const root = path.resolve('approved tools');
const rkDir = path.join(root, 'RK', 'Windows_Upgrade_Tool_v2.46');
const rkRunDir = path.join(root, 'private-writer');
const mtkDir = path.join(root, 'MTK', 'SP_Flash_Tool_V6');
const rkTarget = { locationId: '1a2', vid: '2207', pid: '350e', mode: 'maskrom' };
const mtkTarget = { port: 'COM4', stage: 'preloader', verified: true };
const rkFirmware = { path: path.join(root, 'selected update.img') };
const mtkFirmware = { path: 'D:\\approved image\\download_agent\\flash.xml' };
const mtkOptions = { mode: 'download-only' };
const guardedTarget = { ...rkTarget, identity: 'rockusb-live-at-start', location: 'PCIROOT(0)#USBROOT(0)#USB(3)' };
const verifiedRkFirmware = { ...rkFirmware, chip: '0x33353736', sha256: 'f'.repeat(64), files: [{}] };
const chipInfo = 'Chip Info: 36 37 35 33 00 00 00 00 00 00 00 00 00 00 00 00';
const flashInfo = 'Flash Info:\r\tFlash Size: 118000MB,value=0xe678000\r\tBlock Size: 512KB,value=1024';
const guardedSuccess = 'Check Chip Success\rDownload Image... (30%)\rDownload Firmware Success\rUpgrade firmware ok.';

function rkImageFixture() {
  const image = Buffer.alloc(256);
  image.write('RKFW');
  image.writeUInt16LE(102, 4);
  image.writeUInt32LE(0x33353736, 21);
  image.writeUInt32LE(102, 25);
  image.writeUInt32LE(64, 29);
  image.writeUInt32LE(166, 33);
  image.writeUInt32LE(58, 37);
  image.write('LDR ', 102);
  return image;
}

function backend(events = [], { elevatedMtk, image = rkImageFixture(), writerValid = true } = {}) {
  const calls = [];
  const writerStages = [];
  const loaderFiles = new Map();
  let blocked = false;
  const instance = createDirectFlashBackends({
    host: 'win32', arch: 'x64',
    io: {
      async realpath(directory) {
        if (directory === mtkDir) return directory;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      async stat() { return { isDirectory: () => true }; },
      async open(file) {
        assert.equal(file, rkFirmware.path);
        return {
          async stat() { return { isFile: () => true, size: image.length }; },
          async read(out, offset, length, position) { return { bytesRead: image.copy(out, offset, position, position + length) }; },
          async close() {},
        };
      },
      async writeFile(file, data, options) {
        assert.deepEqual(options, { flag: 'wx', mode: 0o600 });
        assert.equal(loaderFiles.has(file), false);
        loaderFiles.set(file, data);
      },
      async unlink(file) { loaderFiles.delete(file); },
    },
    elevatedMtk, waitForRk: async () => {},
    stageRkTool: async original => {
      writerStages.push('stage');
      assert.equal(original.cwd, rkDir);
      return {
        tool: { ...original, cwd: rkRunDir, executable: path.join(rkRunDir, 'upgrade_tool.exe') },
        async validate() { writerStages.push('validate'); return writerValid; },
        async release() { writerStages.push('release'); },
      };
    },
    revalidateRkFirmware: async firmware => firmware === verifiedRkFirmware,
    async verifyRk(directory) {
      return directory !== rkDir ? { ok: false, code: 'rk-tool-unavailable' }
        : blocked ? { ok: false, code: 'rk-tool-untrusted' }
          : { ok: true, executable: path.join(rkDir, 'upgrade_tool.exe'), cwd: rkDir, version: '2.46', sha256: 'a'.repeat(64) };
    },
    async verifyMtkFiles(directory, executable, files) {
      assert.equal(directory, mtkDir);
      assert.equal(executable, 'SPFlashToolV6.exe');
      assert.equal(files[executable], knownMtk[executable]);
      assert.ok(Object.keys(knownMtk).every(file => files[file] === knownMtk[file]));
      assert.match(files['console_mode.xsd'], /^[0-9a-f]{64}$/);
      assert.match(files['usb_settings.xml'], /^[0-9a-f]{64}$/);
      return blocked ? { code: 'untrusted-package' } : { path: path.join(directory, executable) };
    },
    spawnProcess(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => assert.fail('no simulated process should be killed');
      calls.push({ executable, args, spawnOptions });
      queueMicrotask(() => {
        child.emit('spawn');
        for (const [kind, data, signal] of typeof events === 'function' ? events(args, loaderFiles, child) : events) {
          if (kind === 'stdout' || kind === 'stderr') child[kind].emit('data', Buffer.from(data));
          else if (kind === 'error') child.emit(kind, new Error(data));
          else child.emit('close', data, signal);
        }
      });
      return child;
    },
  });
  return { instance, calls, loaderFiles, writerStages, disableTrust() { blocked = true; } };
}

async function rkWrite(events, { onProgress } = {}) {
  const { instance, calls } = backend(events);
  const { tool } = await instance.inspect('rk', root);
  const result = await instance.write({
    platform: 'rk', tool, target: rkTarget, firmware: rkFirmware, options: { reboot: false },
  }, { onProgress });
  return { result, calls };
}

async function mtkWrite(events, { onProgress, options = mtkOptions } = {}) {
  const { instance, calls } = backend(events);
  const { tool } = await instance.inspect('mtk', root);
  const result = await instance.write({
    platform: 'mtk', tool, target: mtkTarget, firmware: mtkFirmware, options,
  }, { onProgress });
  return { result, calls };
}

test('inspect resolves only exact pinned package layouts and rechecks a tool receipt before invocation', async () => {
  const { instance, calls, disableTrust } = backend();
  const result = await instance.inspect('mtk', root);
  assert.deepEqual(result, { ok: true, tool: {
    executable: path.join(mtkDir, 'SPFlashToolV6.exe'), cwd: mtkDir, version: MTK_VERSION,
    sha256: knownMtk['SPFlashToolV6.exe'],
  } });
  assert.deepEqual(await instance.inspect('rk', 'relative'), { ok: false, code: 'rk-tool-unavailable' });
  assert.deepEqual(await instance.inspect('other', root), { ok: false, code: 'flash-backend-unavailable' });
  assert.deepEqual(await instance.inspect('mtk', mtkDir), result);
  const { tool: rkTool } = await instance.inspect('rk', root);
  assert.deepEqual(await instance.listRk({ ...rkTool, sha256: '0'.repeat(64) }), { ok: false, code: 'rk-tool-untrusted' });
  disableTrust();
  assert.deepEqual(await instance.write({ platform: 'mtk', tool: result.tool, target: mtkTarget, firmware: mtkFirmware }),
    { transferCompleted: false, code: 'mtk-tool-untrusted' });
  assert.equal(calls.length, 0);
});

test('both vendor writes stop before spawning when the last USB identity check fails', async () => {
  const { instance, calls } = backend();
  let checks = 0;
  const beforeDispatch = async () => { checks++; return false; };
  for (const [platform, target, firmware, options] of [['rk', rkTarget, rkFirmware, { reboot: false }], ['mtk', mtkTarget, mtkFirmware, mtkOptions]]) {
    const { tool } = await instance.inspect(platform, root);
    assert.deepEqual(await instance.write({ platform, tool, target, firmware, options }, { beforeDispatch }),
      { transferCompleted: false, code: 'flash-plan-changed' });
  }
  assert.equal(checks, 2);
  assert.deepEqual(calls, []);
});

test('RK listing uses read-only ld without interpreting oversized, malformed or nonzero outputs as empty lists', async () => {
  const row = 'DevNo=1 Vid=0x2207,Pid=0x350e,LocationID=01A2 Mode=Maskrom SerialNo=';
  const normal = backend([['stdout', 'List of rockusb connected(1)\r'], ['stdout', '\n' + row], ['close', 0]]);
  const { tool } = await normal.instance.inspect('rk', root);
  assert.deepEqual(await normal.instance.listRk(tool), { ok: true, devices: [{ ...rkTarget, serial: '' }] });
  assert.deepEqual(normal.calls[0].args, ['ld']);
  assert.equal(normal.calls[0].spawnOptions.shell, false);
  for (const events of [
    [['stdout', 'List of rockusb connected(0)'], ['close', 1]],
    [['stdout', 'x'.repeat(65 * 1024)], ['stdout', '\rList of rockusb connected(0)'], ['close', 0]],
    [['stdout', 'List of rockusb connec'], ['close', 0]],
  ]) {
    const { instance } = backend(events);
    assert.equal((await instance.listRk(tool)).ok, false);
  }
});

test('RK accepts framed progress and success only after the actual LocationID matches the selected target', async () => {
  const progress = [];
  const { result, calls } = await rkWrite([
    ['stdout', 'Current Device Location I'], ['stdout', 'D:01A2\rDownload Image... (35%)\r'],
    ['stdout', 'Download Image... (100%)\r\nUpgrade firmware ok.'], ['close', 0],
  ], { onProgress: value => progress.push(value) });
  assert.deepEqual(result, { transferCompleted: true, code: 'rk-tool-reported-success' });
  assert.deepEqual(progress, [35, 100]);
  assert.deepEqual(calls[0].args, ['-s', '1a2', 'uf', rkFirmware.path, '-noreset']);
  assert.equal(calls[0].spawnOptions.shell, false);
  assert.equal(calls[0].spawnOptions.cwd, rkRunDir);
  assert.equal(calls[0].executable, path.join(rkRunDir, 'upgrade_tool.exe'));
  for (const [log, code] of [
    ['Current Device Location ID:BBBB\rUpgrade firmware ok.', 'rk-target-mismatch'],
    ['Upgrade firmware ok.', 'rk-write-unconfirmed'],
    ['Current Device Location ID:01A2\rDownload Image... (100%)', 'rk-write-unconfirmed'],
    ['Current Device Location ID:01A2\rUpgrade firmware ok.\rCheck Chip Fail', 'rk-write-failed'],
    ['Current Device Location ID:01A2\rUpgrade firmware ok.\r' + 'x'.repeat(2050), 'rk-write-unconfirmed'],
    ['Current Device Location ID:01A2\rDownload Image... (20%)Upgrade firmware ok.', 'rk-write-unconfirmed'],
  ]) {
    assert.deepEqual((await rkWrite([['stdout', log], ['close', 0]])).result, { transferCompleted: false, code });
  }
});

test('RK delivers complete adjacent progress frames before returning from a still-running process', async () => {
  const progress = [];
  let spawnChild;
  const started = new Promise(resolve => { spawnChild = resolve; });
  const { instance } = backend((_args, _files, child) => {
    spawnChild(child);
    return [['stdout', 'Current Device Location ID:01A2\r']];
  });
  const { tool } = await instance.inspect('rk', root);
  let closed = false;
  const running = instance.write({
    platform: 'rk', tool, target: rkTarget, firmware: rkFirmware,
  }, { onProgress: (value, detail) => progress.push([value, detail]) }).then(result => { closed = true; return result; });
  const child = await started;
  child.stdout.emit('data', Buffer.from('\x1b[2K\x08Download Image... (1'));
  assert.deepEqual(progress, []);
  child.stdout.emit('data', Buffer.from('2%)Download Image... ('));
  assert.deepEqual(progress, [[12, { stage: 'writing' }]]);
  child.stdout.emit('data', Buffer.from('13%)' + 'Download Image... (14%)'.repeat(140) + 'Download Image... (15%)'));
  assert.deepEqual(progress.map(([value]) => value), [12, 13, 14, 15]);
  assert.equal(closed, false);
  child.stdout.emit('data', Buffer.from('\rUpgrade firmware ok.\r'));
  child.emit('close', 0);
  assert.deepEqual(await running, { transferCompleted: true, code: 'rk-tool-reported-success' });
});

test('RK never spawns if the private writer copy fails trust validation', async () => {
  const { instance, calls, writerStages } = backend([], { writerValid: false });
  const { tool } = await instance.inspect('rk', root);
  const outcome = await instance.write({ platform: 'rk', tool, target: rkTarget, firmware: rkFirmware });
  assert.deepEqual(outcome, { transferCompleted: false, code: 'flash-tool-unavailable' });
  assert.deepEqual(calls, []);
  assert.deepEqual(writerStages, ['stage', 'validate', 'release']);
});

test('MTK reports write percentage only, requires a clean exit and rejects a conflicting COM identity', async () => {
  const progress = [];
  const writeLine = '98% of image data has been sent (about 1s)';
  const endLine = 'All command exec done!';
  const normal = await mtkWrite([
    ['stdout', 'com port friendly name: MediaTek PreLoader USB VCOM (COM4)\r'],
    ['stdout', '100% of DA data has been sent\r50% of flash has been formatted\r98% of image data'],
    ['stdout', ' has been sent (about 1s)\r'], ['stderr', endLine], ['close', 0],
  ], { onProgress: value => progress.push(value) });
  assert.deepEqual(normal.result, { transferCompleted: true, code: 'mtk-tool-reported-success' });
  assert.deepEqual(progress, [98]);
  assert.deepEqual(normal.calls[0].args, ['-c', 'download', '-f', mtkFirmware.path, '-p', 'COM4', '-t', 'auto', '-r']);
  for (const [chunk, exit, code] of [
    [endLine, 0, 'mtk-write-unverified'],
    [writeLine, 0, 'mtk-write-unverified'],
    [writeLine + '\r' + endLine, 2, 'mtk-write-failed'],
    [writeLine + '\r' + endLine + '\rOperation failed!', 0, 'mtk-write-failed'],
    ['com port friendly name: MediaTek (COM6)\r' + writeLine + '\r' + endLine, 0, 'mtk-target-mismatch'],
  ]) {
    assert.deepEqual((await mtkWrite([['stderr', chunk], ['close', exit]])).result, { transferCompleted: false, code });
  }
  const rejected = await mtkWrite([], { options: { mode: 'format-all-download' } });
  assert.equal(rejected.result.code, 'MTK_FORMAT_NOT_CONFIRMED');
  assert.equal(rejected.calls.length, 0);
});

test('a runtime process error does not turn into confirmed success or cause a write retry', async () => {
  const { result, calls } = await rkWrite([
    ['error', 'temporarily unreadable pipe'], ['stdout', 'Current Device Location ID:1a2\rUpgrade firmware ok.'], ['close', 0],
  ]);
  assert.deepEqual(result, { transferCompleted: false, code: 'rk-write-unconfirmed' });
  assert.equal(calls.length, 1);
});

test('RK no-echo completion needs fresh chip and storage evidence, exact file, recheck and one-use result', async () => {
  const progress = [];
  const { instance, calls } = backend(args => [
    ['stdout', args[2] === 'rci' ? chipInfo : args[2] === 'rfi' ? flashInfo : guardedSuccess], ['close', 0],
  ]);
  const tool = (await instance.inspect('rk', root)).tool;
  const prepared = await instance.prepareRk({
    tool, target: guardedTarget, firmware: verifiedRkFirmware, scanTarget: async () => guardedTarget,
    beforeRamBoot: async () => assert.fail('already verified without RAM boot'),
  });
  assert.deepEqual(prepared, { ok: true, target: { ...guardedTarget, preWriteChipVerified: true } });
  assert.deepEqual(calls.map(call => call.args), [['-s', '1a2', 'rci'], ['-s', '1a2', 'rfi']]);
  const request = { platform: 'rk', tool, target: prepared.target, firmware: verifiedRkFirmware };
  const callbacks = { beforeDispatch: async () => true, onProgress: (value, details) => progress.push([value, details]) };
  const outcome = await instance.write(request, callbacks);
  assert.deepEqual(outcome, { transferCompleted: true, code: 'rk-tool-reported-success' });
  assert.deepEqual(progress, [[null, { stage: 'connecting' }], [30, { stage: 'writing' }], [null, { stage: 'finalizing' }]]);
  assert.deepEqual(await instance.write(request, callbacks), { transferCompleted: false, code: 'flash-plan-changed' });
  assert.equal(calls.length, 3);
});

test('RK Maskrom authorizes one exact RAM loader, rebinds the topology, and accepts verified readback even if still labeled Maskrom', async () => {
  let ramBooted = false;
  let allowed = false;
  const afterRam = { ...guardedTarget, identity: 'appeared-after-ram', locationId: 'a04' };
  const wrongPath = { ...afterRam, location: 'different USB port' };
  const { instance, calls, loaderFiles } = backend((args, files) => {
    if (args[2] === 'db') {
      assert.equal(allowed, true);
      assert.deepEqual(files.get(args[3]), rkImageFixture().subarray(102, 166));
      ramBooted = true;
      return [['stdout', 'Download boot ok.'], ['close', 0]];
    }
    return [['stdout', !ramBooted ? 'Read Chip Info Fail!' : args[2] === 'rci' ? chipInfo : flashInfo], ['close', 0]];
  });
  const tool = (await instance.inspect('rk', root)).tool;
  let scansAfterRam = 0;
  const prepared = await instance.prepareRk({
    tool, target: guardedTarget, firmware: verifiedRkFirmware,
    scanTarget: async () => !ramBooted ? guardedTarget : scansAfterRam++ === 0 ? wrongPath : afterRam,
    beforeRamBoot: async target => {
      assert.equal(target, guardedTarget);
      allowed = true;
      return true;
    },
  });
  assert.deepEqual(prepared, { ok: true, target: { ...afterRam, preWriteChipVerified: true } });
  assert.deepEqual(calls.map(call => call.args.slice(0, 3)), [
    ['-s', '1a2', 'rci'], ['-s', '1a2', 'db'], ['-s', 'a04', 'rci'], ['-s', 'a04', 'rfi'],
  ]);
  assert.equal(loaderFiles.size, 0);
});

test('RK blocks RAM on wrong silicon, refuses malformed firmware or stale approval, and never retries RAM', async () => {
  for (const [log, expected] of [
    [chipInfo.replace('36 37', '37 37'), 'rk-chip-mismatch'],
    ['Current Device Location ID:ffff\r' + chipInfo, 'rk-target-mismatch'],
    ['Read Chip Info Fail!', 'flash-plan-changed'],
  ]) {
    const { instance, calls, loaderFiles } = backend([['stdout', log], ['close', 0]]);
    const tool = (await instance.inspect('rk', root)).tool;
    assert.deepEqual(await instance.prepareRk({
      tool, target: guardedTarget, firmware: verifiedRkFirmware, scanTarget: async () => guardedTarget,
      beforeRamBoot: async () => false,
    }), { ok: false, code: expected });
    assert.deepEqual(calls.map(call => call.args[2]), ['rci']);
    assert.equal(loaderFiles.size, 0);
  }
  const malformed = rkImageFixture();
  malformed.write('RAW!');
  const { instance, calls } = backend([], { image: malformed });
  const tool = (await instance.inspect('rk', root)).tool;
  assert.deepEqual(await instance.prepareRk({
    tool, target: guardedTarget, firmware: verifiedRkFirmware, scanTarget: async () => guardedTarget,
    beforeRamBoot: async () => true,
  }), { ok: false, code: 'rk-firmware-invalid' });
  assert.deepEqual(calls, []);
});

test('RK full guarded evidence rejects wrong selector and missing authoritative success stages', async () => {
  for (const [log, expected] of [
    ['Current Device Location ID:bbbb\r' + guardedSuccess, 'rk-target-mismatch'],
    ['Check Chip Success\rUpgrade firmware ok.', 'rk-write-unconfirmed'],
    ['Download Firmware Success\rCheck Chip Success\rUpgrade firmware ok.', 'rk-write-unconfirmed'],
  ]) {
    const { instance } = backend(args => [
      ['stdout', args[2] === 'rci' ? chipInfo : args[2] === 'rfi' ? flashInfo : log], ['close', 0],
    ]);
    const tool = (await instance.inspect('rk', root)).tool;
    const { target } = await instance.prepareRk({
      tool, target: guardedTarget, firmware: verifiedRkFirmware, scanTarget: async () => guardedTarget,
      beforeRamBoot: async () => false,
    });
    assert.deepEqual(await instance.write({ platform: 'rk', tool, target, firmware: verifiedRkFirmware }, { beforeDispatch: async () => true }),
      { transferCompleted: false, code: expected });
  }
});

test('MTK elevation delegates only after parent revalidation and uses exact argv and helper-ready callback', async () => {
  let readinessChecks = 0;
  let progress = null;
  let readyEvent;
  const { instance, calls } = backend([], { elevatedMtk: async ({ tool, args, target }, callbacks) => {
    assert.equal(tool.version, MTK_VERSION);
    assert.equal(target, mtkTarget);
    assert.deepEqual(args, ['-c', 'download', '-f', mtkFirmware.path, '-p', 'COM4', '-t', 'auto', '-r']);
    callbacks.onReady({ port: 'COM4' });
    callbacks.onProgress(52);
    return { transferCompleted: true, code: 'elevated-result' };
  } });
  const tool = (await instance.inspect('mtk', root)).tool;
  const request = { platform: 'mtk', tool, target: mtkTarget, firmware: mtkFirmware, options: { ...mtkOptions, elevated: true } };
  assert.deepEqual(await instance.write(request), { transferCompleted: false, code: 'flash-plan-changed' });
  const result = await instance.write(request, {
    beforeDispatch: async () => { readinessChecks++; return true; }, onReady: value => { readyEvent = value; },
    onProgress: value => { progress = value; },
  });
  assert.deepEqual(result, { transferCompleted: true, code: 'elevated-result' });
  assert.equal(readinessChecks, 1);
  assert.deepEqual(readyEvent, { port: 'COM4' });
  assert.equal(progress, 52);
  assert.deepEqual(calls, []);
});
