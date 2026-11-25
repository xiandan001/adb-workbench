const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MTK_VERSION, buildMtkFlashArgs, mtkProgress, parseMtkFlashLine, parseMtkTraceLine, updateMtkEvidence, finishMtkFlash,
} = require('../electron/lib/firmware-direct-mtk.cjs');

const request = Object.freeze({
  executableVersion: MTK_VERSION,
  target: { verified: true, stage: 'preloader', port: 'com4' },
  firmware: { verified: true, manifestPath: 'D:/approved image/download_agent/flash.xml' },
  mode: 'download-only',
});

test('MTK 6.2444 gets one fixed argv with a verified manifest and exact Windows COM', () => {
  assert.deepEqual(buildMtkFlashArgs(request), [
    '-c', 'download', '-f', 'D:\\approved image\\download_agent\\flash.xml', '-p', 'COM4', '-t', 'auto', '-r',
  ]);
  assert.deepEqual(buildMtkFlashArgs({
    ...request, mode: 'firmware-upgrade', battery: 'without', reboot: true,
    target: { verified: true, stage: 'brom', port: 'COM4', daPort: 'COM6', sameDeviceVerified: true },
    authenticationFile: { verified: true, path: 'D:/approved image/auth/vendor.auth' },
    certificateFile: { verified: true, path: 'D:/approved image/auth/vendor.cert' },
  }), [
    '-c', 'firmware-upgrade', '-f', 'D:\\approved image\\download_agent\\flash.xml',
    '-p', 'COM4+COM6', '-t', 'without', '-r',
    '-a', 'D:\\approved image\\auth\\vendor.auth', '-e', 'D:\\approved image\\auth\\vendor.cert', '-b',
  ]);
});

test('MTK rejects unstated modes, writes outside the allowlist and format without distinct permission', () => {
  assert.throws(() => buildMtkFlashArgs({ ...request, executableVersion: '6.9999.00.000' }), { code: 'MTK_VERSION_UNSUPPORTED' });
  for (const mode of ['format', 'write-efuse', 'toString', '-c download', ['download-only']]) {
    assert.throws(() => buildMtkFlashArgs({ ...request, mode }), { code: 'MTK_MODE_UNSUPPORTED' });
  }
  assert.throws(() => buildMtkFlashArgs({ ...request, mode: 'format-all-download', permitFormatAll: 'true' }), { code: 'MTK_FORMAT_NOT_CONFIRMED' });
  assert.equal(buildMtkFlashArgs({ ...request, mode: 'format-all-download', permitFormatAll: true })[1], 'format-download');
  assert.throws(() => buildMtkFlashArgs({ ...request, battery: '--file' }), { code: 'MTK_OPTIONS_INVALID' });
  assert.throws(() => buildMtkFlashArgs({ ...request, reboot: 'true' }), { code: 'MTK_OPTIONS_INVALID' });
});

test('MTK needs main-owned preloader COM or a verified connection and DA port pair', () => {
  const { target } = request;
  for (const port of ['', 'COM0', 'COM4097', 'COM04', 'COM4+COM6', '--b', 'COM4\n']) {
    assert.throws(() => buildMtkFlashArgs({ ...request, target: { ...target, port } }), { code: 'MTK_TARGET_UNVERIFIED' });
  }
  assert.throws(() => buildMtkFlashArgs({ ...request, target: { ...target, verified: false } }), { code: 'MTK_TARGET_UNVERIFIED' });
  for (const stage of [{ stage: 'brom' }, { stage: 'brom', daPort: 'COM6' }, { stage: 'brom', daPort: 'COM4', sameDeviceVerified: true }, { stage: 'unknown' }]) {
    assert.throws(() => buildMtkFlashArgs({ ...request, target: { ...target, ...stage } }), { code: 'MTK_PORT_MAPPING_UNVERIFIED' });
  }
});

test('MTK argument validation declines unverified files and disallows external paths and alternate data streams', () => {
  for (const manifestPath of [
    'flash.xml', 'D:flash.xml', '\\\\host\\share\\flash.xml', 'D:/pkg/../flash.xml',
    'D:/pkg/CON.xml', 'D:/pkg/manifest:payload.xml', 'D:/pkg/"flash.xml', 'D:/pkg/flash.txt',
  ]) {
    assert.throws(() => buildMtkFlashArgs({ ...request, firmware: { verified: true, manifestPath } }), { code: 'MTK_MANIFEST_UNVERIFIED' });
  }
  assert.throws(() => buildMtkFlashArgs({ ...request, firmware: { ...request.firmware, verified: false } }), { code: 'MTK_MANIFEST_UNVERIFIED' });
  assert.throws(() => buildMtkFlashArgs({ ...request, authenticationFile: { path: 'D:/v.auth' } }), { code: 'MTK_AUTH_UNVERIFIED' });
  assert.throws(() => buildMtkFlashArgs({ ...request, certificateFile: { verified: true, path: 'D:/v.auth' } }), { code: 'MTK_CERT_UNVERIFIED' });
});

test('MTK reports preparation, connection and writes separately and never forwards arbitrary log text', () => {
  assert.deepEqual(parseMtkFlashLine('Begin verify load images checksum'), { phase: 'preparing' });
  assert.deepEqual(parseMtkFlashLine('100% of DA data has been sent(about 2s)'), { phase: 'connecting', percentage: 100 });
  assert.deepEqual(parseMtkFlashLine('50% of flash has been formatted(about 3s).'), { phase: 'formatting', percentage: 50 });
  assert.deepEqual(parseMtkFlashLine('27% of [system_a] data has been sent (about 4s)'), { phase: 'writing', percentage: 27 });
  assert.deepEqual(parseMtkFlashLine('31% of [super [23/24]] data has been sent (about 1.97G)'), { phase: 'writing', percentage: 31, part: 23, total: 24 });
  assert.deepEqual(mtkProgress(parseMtkFlashLine('31% of [super [23/24]] data has been sent (about 1.97G)')),
    [null, { stage: 'writing', part: 23, total: 24, partPercent: 31 }]);
  assert.deepEqual(mtkProgress(parseMtkFlashLine('100% of [super [1/1]] data has been sent')), [100, { stage: 'writing', part: 1, total: 1, partPercent: 100 }]);
  assert.deepEqual(mtkProgress(parseMtkFlashLine('8% of [system_a] data has been sent')), [null, { stage: 'writing', partPercent: 8 }]);
  assert.deepEqual(mtkProgress(parseMtkFlashLine('98% of image data has been sent')), [98, { stage: 'writing' }]);
  for (const line of ['1000% of image data has been sent', 'about to process All command exec done!', 'file D:/private.auth', 'x'.repeat(2049)]) {
    assert.equal(parseMtkFlashLine(line), null);
  }
});

test('V6 trace parses exact current PID, COM scanner scope, host echo and written marker', () => {
  const line = (body, source) => '11/24/2026 16:42:07.187 SPFlashToolV6[2100][2101][D]: ' + body + '(' + source + '.cpp,72)';
  const scanner = body => line('Connection::scan_com_port(): ' + body, 'Connection');
  const mode = value => line('ConsoleMode::CommandSetting::createCmdSettingFromArgs(): current input command name: ' + value, 'CommandSetting');
  for (const command of ['download', 'firmware-upgrade', 'format-download']) {
    assert.deepEqual(parseMtkTraceLine(mode(command), 2100), { phase: 'input-mode', command });
  }
  assert.deepEqual(parseMtkTraceLine(scanner('scan device START, timeout set as 120000 ms.'), 2100), { phase: 'scan', timeoutMs: 120000 });
  assert.equal(parseMtkTraceLine(scanner('scan device START, timeout set as 120000 ms.'), 2101), null);
  assert.deepEqual(parseMtkTraceLine(scanner('com port clue: COM://COM3.'), 2100), { phase: 'clue', port: 'COM3' });
  assert.deepEqual(parseMtkTraceLine(scanner('com port clue: COM://.'), 2100), { phase: 'clue', port: null });
  assert.deepEqual(parseMtkTraceLine(line('ConsoleModeCallBack::cb_com_port_status(): com port friendly name: COM://usb#fixture@MediaTek PreLoader USB VCOM (Android) (COM3)@fixture', 'ConsoleModeCallBack'), 2100), { phase: 'tool-target', port: 'COM3' });
  assert.deepEqual(parseMtkTraceLine(line('CmdExecutor::execute(): CMD:WRITE-PARTITIONS command execute successed.', 'CmdExecutor'), 2100), { phase: 'device-command', command: 'WRITE-PARTITIONS', outcome: 'success' });
  assert.deepEqual(parseMtkTraceLine(line('CmdExecutor::execute(): current command name: CMD:ERASE-FLASH,	command XML:', 'CmdExecutor'), 2100), { phase: 'device-command', command: 'ERASE-FLASH', outcome: 'request' });
  assert.deepEqual(parseMtkTraceLine(line('CmdExecutor::execute(): CMD:FLASH-UPDATE command execute failed, return error code: -3', 'CmdExecutor'), 2100), { phase: 'device-command', command: 'FLASH-UPDATE', outcome: 'failure' });
  assert.deepEqual(parseMtkTraceLine(line('CmdExecutor::execute(): CMD:FLASH-ALL command execute successed.', 'CmdExecutor'), 2100), { phase: 'device-command', command: 'FLASH-ALL', outcome: 'success' });
  assert.deepEqual(parseMtkTraceLine(line('ConsoleMode::ConsoleModeRunner::cbFormatProgress(): 100% of flash has been formatted(about 3s).', 'ConsoleModeRunner'), 2100),
    { phase: 'formatting', percentage: 100 });
  assert.deepEqual(parseMtkTraceLine(line('ConsoleMode::ConsoleModeEntry::run(): All command exec done!', 'ConsoleModeEntry'), 2100), { phase: 'tool-completed' });
  assert.equal(parseMtkTraceLine(line('CmdExecutor::execute(): CMD:GET-SYS-PROPERTY@DA.DUI command execute failed, return error code: -3', 'CmdExecutor'), 2100), null);
});

test('MTK requires a clean exit, writing evidence and an uncontradicted terminal marker', () => {
  const record = (...lines) => lines.map(parseMtkFlashLine).reduce(updateMtkEvidence, null);
  const write = '100% of image data has been sent (about 4s)';
  const marker = 'All command exec done!';
  assert.deepEqual(finishMtkFlash({ exitCode: 0, evidence: record(write, marker) }), { ok: true, status: 'tool-completed' });
  assert.deepEqual(finishMtkFlash({ exitCode: 0, evidence: record(write) }), { ok: false, status: 'unverified' });
  assert.deepEqual(finishMtkFlash({ exitCode: 0, evidence: record('100% of DA data has been sent', marker) }), { ok: false, status: 'unverified' });
  assert.deepEqual(finishMtkFlash({ exitCode: 1, evidence: record(write, marker) }), { ok: false, status: 'failed' });
  assert.deepEqual(finishMtkFlash({ exitCode: 0, evidence: record(write, 'Operation failed!', marker) }), { ok: false, status: 'failed' });
  assert.deepEqual(finishMtkFlash({ exitCode: null, signal: 'SIGTERM', evidence: record(write, marker) }), { ok: false, status: 'interrupted' });
});
