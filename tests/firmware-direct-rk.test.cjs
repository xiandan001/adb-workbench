const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  inspectRkTool,
  rkListArgs,
  parseRkDeviceList,
  buildRkFlashArgs,
  parseRkReadInfo,
  parseRkProgressLine,
  classifyRkResult,
} = require('../electron/lib/firmware-direct-rk.cjs');

const row = 'DevNo=1 Vid=0x2207,Pid=0x350e,LocationID=01A2    Mode=Maskrom    SerialNo=';
const target = { locationId: '1a2', vid: '2207', pid: '350e', mode: 'maskrom', serial: '' };
const imagePath = path.resolve('中文 带空格', 'update.img');

test('read-only list parses the documented Windows location and device attributes', () => {
  assert.deepEqual(rkListArgs(), ['ld']);
  assert.deepEqual(parseRkDeviceList('Upgrade Tool v2.46\r\nList of rockusb connected(1)\r\n' + row + '\r\n'),
    { ok: true, devices: [target] });
  assert.deepEqual(parseRkDeviceList('List of rockusb connected(1)\n' + row.replace('Mode=Maskrom    SerialNo=', 'Loader    SerialNo=unit42')),
    { ok: true, devices: [{ ...target, mode: 'loader', serial: 'unit42' }] });
  assert.deepEqual(parseRkDeviceList('No found any rockusb device,please plug device in!'), { ok: true, devices: [] });
});

test('a partial, malformed, contradictory, duplicate or excessive device list fails closed', () => {
  const first = 'List of rockusb connected(1)\n';
  const two = 'List of rockusb connected(2)\n';
  for (const output of ['', 'Windows runtime loading', two + row, first + row.replace('2207', '0e8d'),
    first + row.replace('Mode=Maskrom', 'Mode=Msc'), first + row + '\nNo found any rockusb device,please plug device in!',
    first + row + '\nList of rockusb connected(1)', 'X'.repeat(64 * 1024 + 1)]) {
    assert.equal(parseRkDeviceList(output).ok, false, output.slice(0, 100));
  }
  assert.deepEqual(parseRkDeviceList(two + row + '\n' + row.replace('DevNo=1', 'DevNo=2').replace('01A2', '1a2')),
    { ok: false, code: 'rk-ambiguous-device-list' });
});

test('full image launch plan has no default target and permits only documented argv', () => {
  assert.deepEqual(buildRkFlashArgs({ target, imagePath }), ['-s', '1a2', 'uf', imagePath]);
  assert.deepEqual(buildRkFlashArgs({ target, imagePath, reboot: false }), ['-s', '1a2', 'uf', imagePath, '-noreset']);
  for (const invalid of [undefined, { ...target, locationId: '1;rd' }, { ...target, locationId: '-1' },
    { ...target, vid: '0e8d' }, { ...target, mode: 'msc' }]) {
    assert.throws(() => buildRkFlashArgs({ target: invalid, imagePath }), { code: 'rk-target-invalid' });
  }
  for (const invalid of ['update.img', path.resolve('update.bin'), '\\\\server\\update.img', imagePath.replace(/update/, 'bad"')]) {
    assert.throws(() => buildRkFlashArgs({ target, imagePath: invalid }), { code: 'rk-firmware-invalid' });
  }
});

test('known progress, target and failure messages never constitute image completion', () => {
  assert.deepEqual(parseRkProgressLine('\rDownload Image... (58%)'), { type: 'progress', percent: 58 });
  assert.deepEqual(parseRkProgressLine('Current Device Location ID:01A2'), { type: 'target', locationId: '1a2' });
  assert.deepEqual(parseRkProgressLine('Check Chip Success'), { type: 'stage', stage: 'check-chip-success' });
  assert.deepEqual(parseRkProgressLine('Download Firmware Success'), { type: 'stage', stage: 'download-firmware-success' });
  assert.deepEqual(parseRkProgressLine('Check Chip Fail'), { type: 'failure' });
  assert.deepEqual(parseRkProgressLine('No found specific rockusb device!'), { type: 'failure' });
  assert.deepEqual(parseRkProgressLine('Upgrade firmware ok.'), { type: 'success' });
  assert.equal(parseRkProgressLine('Download Image... (109%)'), null);
  assert.equal(parseRkProgressLine('progress from arbitrary user data: 100%'), null);
  assert.deepEqual(classifyRkResult({ exitCode: 0 }), { ok: false, code: 'rk-write-unconfirmed' });
  assert.deepEqual(classifyRkResult({ exitCode: 5, successMarker: true }), { ok: false, code: 'rk-write-failed' });
  assert.deepEqual(classifyRkResult({ exitCode: 0, successMarker: true, failureMarker: true }), { ok: false, code: 'rk-write-failed' });
  assert.deepEqual(classifyRkResult({ exitCode: null, signal: 'SIGTERM' }), { ok: false, code: 'rk-write-interrupted' });
  assert.deepEqual(classifyRkResult({ exitCode: 0, successMarker: true }), { ok: true, code: 'rk-tool-reported-success' });
});

test('RK3576 verified reads require full hex chip response and consistent raw capacity', () => {
  const chip = 'Chip Info: 36 37 35 33 00 00 00 00 00 00 00 00 00 00 00 00';
  const flash = 'Flash Info:\r\n\tFlash Size: 118000MB,value=0xe678000';
  assert.deepEqual(parseRkReadInfo('rci', chip, '1a2'), { ok: true, chip: '0x33353736' });
  assert.deepEqual(parseRkReadInfo('rfi', flash, '1a2'), { ok: true, capacityBytes: 118000 * 1024 ** 2 });
  for (const output of [flash.replace('118000', '1'), flash + '\n' + flash, flash.replace('0xe678000', '0x0')]) {
    assert.equal(parseRkReadInfo('rfi', output, '1a2').ok, false);
  }
  for (const output of [chip.slice(0, -3), chip + '\nRead Chip Info Fail!', chip + '\n' + chip]) {
    assert.equal(parseRkReadInfo('rci', output, '1a2').ok, false);
  }
  assert.deepEqual(parseRkReadInfo('rci', 'Current Device Location ID:FFFF\r' + chip, '1a2'),
    { ok: false, code: 'rk-target-mismatch' });
});

test('unconfigured or changed CLI files never pass the Windows SDK fingerprint check', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-rk-cli-'));
  t.after(async () => {
    await fs.unlink(path.join(directory, 'upgrade_tool.exe')).catch(() => {});
    await fs.unlink(path.join(directory, 'config.ini')).catch(() => {});
    await fs.rmdir(directory);
  });
  assert.deepEqual(await inspectRkTool('relative'), { ok: false, code: 'rk-tool-unavailable' });
  assert.deepEqual(await inspectRkTool(directory), { ok: false, code: 'rk-tool-unavailable' });
  await fs.writeFile(path.join(directory, 'upgrade_tool.exe'), 'harmless test fixture');
  await fs.writeFile(path.join(directory, 'config.ini'), '# fixture');
  assert.deepEqual(await inspectRkTool(directory), { ok: false, code: 'rk-tool-untrusted' });
});
