const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { MTK_VERSION, buildMtkFlashArgs } = require('../electron/lib/firmware-direct-mtk.cjs');
const { writeElevatedMtk } = require('../electron/lib/firmware-direct-elevated.cjs');

const pid = 3100;
const oldDump = 'SP_FT_V6_Dump_11-24-2026-16-41-07';
const newDump = 'SP_FT_V6_Dump_11-24-2026-16-42-07';
const tool = { version: MTK_VERSION, sha256: 'a'.repeat(64), executable: 'D:\\路径 fi&xl\\SPFlashToolV6.exe', cwd: 'D:\\路径 fi&xl' };
const target = { stage: 'preloader', port: 'COM3', verified: true };
const args = buildMtkFlashArgs({
  executableVersion: MTK_VERSION, target, mode: 'download-only',
  firmware: { verified: true, manifestPath: 'D:/isolated stage/download_agent/flash.xml' },
});
const request = { tool, target, args };
const line = (text, source = 'Connection', id = pid) =>
  '11/24/2026 16:42:07.187 SPFlashToolV6[' + id + '][3232][D]: ' + text + '(' + source + '.cpp,72)\r\n';
const modeLine = value => line('ConsoleMode::CommandSetting::createCmdSettingFromArgs(): current input command name: ' + value, 'CommandSetting');
const scan = (port, vendorMode = 'download') => [
  vendorMode === null ? '' : modeLine(vendorMode),
  line('Connection::scan_com_port(): scan device START, timeout set as 120000 ms.'),
  line('Connection::scan_com_port(): com port clue: COM://' + port + '.'),
].join('');
const echo = port => line('ConsoleModeCallBack::cb_com_port_status(): com port friendly name: COM://usb#fixture@MediaTek PreLoader USB VCOM (Android) (' + port + ')@fixture', 'ConsoleModeCallBack');
const nativeEcho = usb => line('ConsoleModeCallBack::cb_com_port_status(): com port friendly name: COM://\\\\?\\usb#vid_0e8d&pid_2000#' + usb + '#{a5dcbf10-6530-11d2-901f-00c04fb951ed}@MediaTek PreLoader USB VCOM (Android) (COM3)@' + usb, 'ConsoleModeCallBack');
const commandResult = (name, successful = true) => line('CmdExecutor::execute(): CMD:' + name + (successful ? ' command execute successed.' : ' command execute failed, return error code: -3'), 'CmdExecutor');
const terminal = line('ConsoleMode::ConsoleModeEntry::run(): All command exec done!', 'ConsoleModeEntry');
const erase = (partition = 'ALL', successful = true) => [
  line('CmdExecutor::execute(): current command name: CMD:ERASE-FLASH, command XML:', 'CmdExecutor'),
  '<da>\r\n<command>CMD:ERASE-FLASH</command>\r\n<arg>\r\n<partition>' + partition + '</partition>\r\n<offset>0x0</offset>\r\n<length>MAX</length>\r\n</arg>\r\n</da>\r\n',
  commandResult('ERASE-FLASH', successful),
].join('');
const forMode = (mode, permitFormatAll = false) => ({
  tool, target, mode, permitFormatAll, args: buildMtkFlashArgs({
    executableVersion: MTK_VERSION, target, mode, permitFormatAll,
    firmware: { verified: true, manifestPath: 'D:/isolated stage/download_agent/flash.xml' },
  }),
});
const done = [
  line('ConsoleMode::ConsoleModeRunner::cbDownloadProgress(): 31% of [super [23/24]] data has been sent (about 1.97G)', 'ConsoleModeRunner'),
  line('CmdExecutor::execute(): CMD:WRITE-PARTITIONS command execute successed.', 'CmdExecutor'),
  line('ConsoleMode::ConsoleModeEntry::run(): All command exec done!', 'ConsoleModeEntry'),
].join('');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mtk-elevated-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logfile = name => path.join(root, name, 'QT_FLASH_TOOL_V6.log');
  async function add(text, name = newDump) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.appendFile(logfile(name), text);
  }
  return { logRoot: root, pollMs: 3, add };
}

test('elevated Download Only announces only current exact COM readiness, not another PID or stale trace', async t => {
  const f = await setup(t);
  await f.add(scan('COM3') + echo('COM3') + done, oldDump);
  const readiness = [], progress = [];
  let showReady;
  const ready = new Promise(resolve => { showReady = resolve; });
  const result = await writeElevatedMtk(request, {
    onReady(value) { readiness.push(value); showReady(); },
    onProgress(value, part) { progress.push([value, part]); },
  }, {
    ...f,
    async launch(seenTool, seenArgs, onPid) {
      assert.deepEqual(seenTool, tool);
      assert.deepEqual(seenArgs, args);
      onPid(pid);
      await f.add(scan('COM3').replaceAll('[' + pid + ']', '[2900]'));
      await delay(14);
      assert.deepEqual(readiness, []);
      await f.add(scan('COM3'));
      await Promise.race([ready, delay(1000).then(() => { throw new Error('targeted scan should announce'); })]);
      await f.add(echo('COM3') + done);
      return { exitCode: 0 };
    },
  });
  assert.deepEqual(readiness, [{ port: 'COM3', timeoutMs: 120000 }]);
  assert.deepEqual(progress, [
    [null, { stage: 'connecting' }],
    [null, { stage: 'writing', part: 23, total: 24, partPercent: 31 }],
    [null, { stage: 'finalizing' }],
  ]);
  assert.deepEqual(result, { transferCompleted: true, code: 'mtk-tool-reported-success' });
});

test('elevated formatting percent and numbered partition percent never become total percent', async t => {
  const f = await setup(t);
  const progress = [];
  const result = await writeElevatedMtk(forMode('format-all-download', true), {
    onProgress: (value, details) => progress.push([value, details]),
  }, {
    ...f,
    async launch(_tool, _args, onPid) {
      onPid(pid);
      const format = line('ConsoleMode::ConsoleModeRunner::cbFormatProgress(): 100% of flash has been formatted(about 3s).', 'ConsoleModeRunner');
      const write = line('ConsoleMode::ConsoleModeRunner::cbDownloadProgress(): 34% of [super [23/24]] data has been sent (about 2G)', 'ConsoleModeRunner');
      await f.add(scan('COM3', 'format-download') + echo('COM3') + erase().replace(commandResult('ERASE-FLASH'), format + commandResult('ERASE-FLASH')) +
        write + commandResult('FLASH-ALL') + terminal);
      return { exitCode: 0 };
    },
  });
  assert.equal(result.transferCompleted, true);
  assert.deepEqual(progress, [
    [null, { stage: 'connecting' }],
    [null, { stage: 'formatting' }],
    [null, { stage: 'formatting', stagePercent: 100 }],
    [null, { stage: 'writing', part: 23, total: 24, partPercent: 34 }],
    [null, { stage: 'finalizing' }],
  ]);
});

test('elevated Download Only rejects stale markers, generic scans, wrong target and a full erase', async t => {
  const cases = [
    [null, 'mtk-write-unverified'],
    [scan('') + echo('COM3') + done, 'mtk-target-mismatch'],
    [scan('COM3') + echo('COM5') + done, 'mtk-target-mismatch'],
    [scan('COM3') + echo('COM3') + line('CmdExecutor::execute(): current command name: CMD:ERASE-FLASH, command XML:', 'CmdExecutor') + '<partition>ALL</partition>\r\n' + done, 'mtk-mode-mismatch'],
    [scan('COM3') + done, 'mtk-write-unverified'],
    [scan('COM3') + echo('COM3') + line('ConsoleMode::ConsoleModeEntry::run(): All command exec done!', 'ConsoleModeEntry'), 'mtk-write-unverified'],
    [scan('COM3', null) + echo('COM3') + done, 'mtk-write-unverified'],
    [scan('COM3', null) + modeLine('download') + echo('COM3') + done, 'mtk-write-unverified'],
    [scan('COM3', 'format-download') + echo('COM3') + done, 'mtk-mode-mismatch'],
    [scan('COM3') + echo('COM3') + commandResult('FLASH-ALL') + terminal, 'mtk-mode-mismatch'],
  ];
  for (const [trace, code] of cases) {
    const f = await setup(t);
    await f.add(scan('COM3') + echo('COM3') + done, oldDump);
    const result = await writeElevatedMtk(request, {}, {
      ...f,
      async launch(toolArg, argsArg, onPid) {
        onPid(pid);
        if (trace) await f.add(trace);
        return { exitCode: 0 };
      },
    });
    assert.deepEqual(result, { transferCompleted: false, code });
  }
});

test('firmware upgrade accepts only the exact mode and the distinct FLASH-UPDATE result', async t => {
  const request = forMode('firmware-upgrade');
  for (const [commands, expected] of [
    [commandResult('FLASH-UPDATE'), { transferCompleted: true, code: 'mtk-tool-reported-success' }],
    [commandResult('WRITE-PARTITIONS'), { transferCompleted: false, code: 'mtk-mode-mismatch' }],
    [commandResult('FLASH-ALL'), { transferCompleted: false, code: 'mtk-mode-mismatch' }],
    [erase() + commandResult('FLASH-UPDATE'), { transferCompleted: false, code: 'mtk-mode-mismatch' }],
    [commandResult('FLASH-UPDATE', false), { transferCompleted: false, code: 'mtk-write-failed' }],
  ]) {
    const f = await setup(t);
    const result = await writeElevatedMtk(request, {}, {
      ...f,
      async launch(toolArg, argsArg, onPid) {
        assert.equal(argsArg[1], 'firmware-upgrade');
        onPid(pid);
        await f.add(scan('COM3', 'firmware-upgrade') + echo('COM3') + commands + terminal);
        return { exitCode: 0 };
      },
    });
    assert.deepEqual(result, expected);
  }
});

test('format-download needs literal permission, complete full erase, distinct image write, and clean completion', async t => {
  const request = forMode('format-all-download', true);
  const f = await setup(t);
  for (const permitFormatAll of [undefined, false, 1, 'true']) {
    assert.deepEqual(await writeElevatedMtk({ ...request, permitFormatAll }, {}, {
      ...f,
      launch: () => { assert.fail('must not request UAC for unapproved formatting'); },
    }), { transferCompleted: false, code: 'mtk-tool-start-failed' });
  }
  for (const [commands, expected] of [
    [erase() + commandResult('FLASH-ALL'), { transferCompleted: true, code: 'mtk-tool-reported-success' }],
    [erase(), { transferCompleted: false, code: 'mtk-write-unverified' }],
    [commandResult('FLASH-ALL'), { transferCompleted: false, code: 'mtk-write-unverified' }],
    [erase('userdata') + commandResult('FLASH-ALL'), { transferCompleted: false, code: 'mtk-write-unverified' }],
    [erase('ALL', false) + commandResult('FLASH-ALL'), { transferCompleted: false, code: 'mtk-write-failed' }],
    [commandResult('FLASH-ALL') + erase(), { transferCompleted: false, code: 'mtk-write-unverified' }],
    [erase() + commandResult('FLASH-ALL') + erase(), { transferCompleted: false, code: 'mtk-mode-mismatch' }],
    [erase() + commandResult('FLASH-ALL', false), { transferCompleted: false, code: 'mtk-write-failed' }],
    [erase() + commandResult('WRITE-PARTITIONS'), { transferCompleted: false, code: 'mtk-mode-mismatch' }],
  ]) {
    const logs = await setup(t);
    const result = await writeElevatedMtk(request, {}, {
      ...logs,
      async launch(toolArg, argsArg, onPid) {
        assert.equal(argsArg[1], 'format-download');
        onPid(pid);
        await logs.add(scan('COM3', 'format-download') + echo('COM3') + commands + terminal);
        return { exitCode: 0 };
      },
    });
    assert.deepEqual(result, expected);
  }
});

test('elevated runner fences mode and argv before calling the launcher, and reports one UAC cancellation', async t => {
  const f = await setup(t);
  let calls = 0;
  const launch = async () => { calls++; return { cancelled: true }; };
  for (const extra of [
    { args: args.map(item => item === 'download' ? 'format-download' : item) },
    { args: args.map(item => item === 'COM3' ? 'COM5' : item) },
    { args: [...args, '-a', 'D:\\any.auth'] },
    { target: { ...target, stage: 'brom' } },
  ]) {
    assert.deepEqual(await writeElevatedMtk({ ...request, ...extra }, {}, { ...f, launch }),
      { transferCompleted: false, code: 'mtk-tool-start-failed' });
  }
  assert.deepEqual(await writeElevatedMtk(request, {}, { ...f, launch }), { transferCompleted: false, code: 'mtk-uac-cancelled' });
  assert.equal(calls, 1);
});

test('an unclean Windows exit cannot report write success even with all trace signals', async t => {
  const f = await setup(t);
  const result = await writeElevatedMtk(request, {}, {
    ...f,
    async launch(toolArg, argsArg, onPid) { onPid(pid); await f.add(scan('COM3') + echo('COM3') + done); return { exitCode: 12 }; },
  });
  assert.deepEqual(result, { transferCompleted: false, code: 'mtk-write-failed' });
});

test('same COM is not accepted when V6 acquires a missing or different USB instance', async t => {
  const bound = { ...request, target: { ...target, instanceId: 'USB\\VID_0E8D&PID_2000\\8&AABB&0&1' } };
  for (const [actual, transferCompleted] of [[nativeEcho('8&aabb&0&1'), true], [nativeEcho('8&ccdd&0&1'), false], [echo('COM3'), false]]) {
    const f = await setup(t);
    const result = await writeElevatedMtk(bound, {}, {
      ...f,
      async launch(toolArg, argsArg, onPid) {
        onPid(pid);
        await f.add(scan('COM3') + actual + done);
        return { exitCode: 0 };
      },
    });
    assert.deepEqual(result, { transferCompleted, code: transferCompleted ? 'mtk-tool-reported-success' : 'mtk-write-unverified' });
  }
});

test('Windows launcher passes a literal argv to one native consent request and reads only typed PID/exit status', async t => {
  const f = await setup(t);
  let spawns = 0;
  const result = await writeElevatedMtk(request, {}, {
    ...f, spawnProcess(executable, options, config) {
      spawns++;
      assert.match(executable, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
      assert.equal(config.shell, false);
      assert.equal(config.windowsHide, true);
      const decoded = Buffer.from(options.at(-1), 'base64').toString('utf16le');
      assert.match(decoded, /-WindowStyle Hidden -Verb RunAs -PassThru/);
      const data = /FromBase64String\("([A-Za-z0-9+=/]+)"\)/.exec(decoded)[1];
      const invocation = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      assert.equal(invocation.executable, tool.executable);
      assert.equal(invocation.cwd, tool.cwd);
      assert.equal(invocation.argumentLine, args.map(arg => '"' + arg + '"').join(' '));
      const process = new EventEmitter();
      process.stdout = new EventEmitter();
      queueMicrotask(async () => {
        process.stdout.emit('data', Buffer.from('VEYLO_MTK_PI'));
        process.stdout.emit('data', Buffer.from('D:' + pid + '\r\n'));
        await f.add(scan('COM3') + echo('COM3') + done);
        process.stdout.emit('data', Buffer.from('VEYLO_MTK_EXIT:0\r\n'));
        process.emit('close', 0);
      });
      return process;
    },
  });
  assert.equal(spawns, 1);
  assert.deepEqual(result, { transferCompleted: true, code: 'mtk-tool-reported-success' });
});
