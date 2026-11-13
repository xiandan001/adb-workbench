const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../electron/lib/update-installer-launch.cjs'), 'utf8');
const content = Buffer.from('MZ isolated installer fixture');
const checksum = data => crypto.createHash('sha512').update(data).digest('base64');

function fixture({ bytes = content, missing = false, missingScript = false, packaged = false,
  platform = 'win32', reply = { ok: true, code: 'READY', installerPid: 9001 }, error = null, rawOutput } = {}) {
  const calls = [], trace = [];
  const root = "C:\\Tools\\Veylo's app";
  const executable = "C:\\cache\\Veylo's 设备 & $(ignored).exe";
  const module = { exports: {} };
  const stats = () => ({ isFile: () => true, size: bytes.length, dev: 1, ino: 1, mtimeMs: 1 });
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    __dirname: path.win32.join(root, packaged ? 'resources/app.asar/electron/lib' : 'electron/lib'),
    process: { platform, resourcesPath: packaged ? path.win32.join(root, 'resources') : undefined,
      env: { SystemRoot: 'C:\\Windows' } },
    require(name) {
      if (name === 'node:fs') return { existsSync: value => !value.includes('Sysnative') && !(missingScript && value.endsWith('.ps1')),
        promises: { async open() {
          if (missing) throw Object.assign(new Error(executable), { code: 'ENOENT' });
          return { stat: async () => stats(), async read(target) { bytes.copy(target, 0, 0, 2); return { bytesRead: Math.min(2, bytes.length) }; },
            createReadStream: () => (async function* () { yield bytes; })(), async close() { trace.push('file-closed'); } };
        } } };
      if (name === 'node:path') return path.win32;
      if (name === 'node:crypto') return crypto;
      if (name === 'node:child_process') return { execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        queueMicrotask(() => callback(error, rawOutput === undefined ? JSON.stringify(reply) : rawOutput, executable));
        return { stdin: { end() {} } };
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: 'update-installer-launch.cjs' });
  return { calls, trace, root, executable, launch: overrides => module.exports.launchUpdateInstaller({
    installerPath: executable, parentPid: 4242, locale: 'zh-CN', sha512: checksum(bytes), ...overrides,
  }) };
}

const payload = call => JSON.parse(Buffer.from(call.args[call.args.indexOf('-PayloadBase64') + 1], 'base64').toString('utf8'));

test('verified installers launch through a fixed script and data-only payload with a random 32-hex ready token', async () => {
  const f = fixture();
  const result = await f.launch();
  assert.deepEqual({ ...result }, { ok: true, code: 'READY', installerPid: 9001, helperExitCode: 0 });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0], data = payload(call);
  assert.equal(call.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(call.args[call.args.indexOf('-File') + 1], path.win32.join(f.root, 'electron/assets/update-launch.ps1'));
  assert.ok(!call.args.includes('-Command') && !call.args.includes('-EncodedCommand'));
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.timeout, 90000);
  assert.deepEqual(Object.keys(data).sort(), ['installerPath', 'locale', 'parentPid', 'readyToken', 'sha512'].sort());
  assert.equal(data.installerPath, f.executable); assert.equal(data.parentPid, 4242);
  assert.equal(data.sha512, checksum(content)); assert.equal(data.locale, 'zh-CN');
  assert.match(data.readyToken, /^[a-f0-9]{32}$/);
  assert.deepEqual(f.trace, ['file-closed']);
  await f.launch(); assert.notEqual(payload(f.calls[1]).readyToken, data.readyToken);
});

test('packaged launch selects its unpacked resource and supports all five fixed locale values', async () => {
  const f = fixture({ packaged: true });
  for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR']) {
    assert.equal((await f.launch({ locale })).ok, true);
    assert.equal(payload(f.calls.at(-1)).locale, locale);
  }
  const call = f.calls[0];
  assert.equal(call.args[call.args.indexOf('-File') + 1], path.win32.join(f.root, 'resources/app.asar.unpacked/electron/assets/update-launch.ps1'));
});

test('missing, empty and non-MZ files or checksum mismatches never invoke the launch helper', async () => {
  for (const f of [fixture({ missing: true }), fixture({ bytes: Buffer.alloc(0) }), fixture({ bytes: Buffer.from('not executable') })]) {
    assert.equal((await f.launch()).code, 'INVALID_INSTALLER'); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.launch({ sha512: checksum(Buffer.from('other')) })).code, 'CHECKSUM_MISMATCH');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.trace, ['file-closed']);
});

test('invalid inputs, unsupported platforms and absent scripts produce typed failures without launching', async () => {
  for (const value of [{ parentPid: 0 }, { parentPid: 1.5 }, { locale: 'en-US --other' },
    { installerPath: 'relative.exe' }, { installerPath: 'C:\\cache\\data.txt' }, { sha512: 'invalid' }]) {
    const f = fixture(); assert.equal((await f.launch(value)).code, 'INVALID_INPUT'); assert.equal(f.calls.length, 0);
  }
  const missing = fixture({ missingScript: true });
  assert.equal((await missing.launch()).code, 'SCRIPT_UNAVAILABLE'); assert.equal(missing.calls.length, 0);
  const other = fixture({ platform: 'linux' });
  assert.equal((await other.launch()).code, 'UNSUPPORTED_PLATFORM'); assert.equal(other.calls.length, 0);
});

test('cancellation, launch failure, early exit and ready timeout preserve typed helper failures without sensitive output', async () => {
  for (const code of ['UAC_CANCELLED', 'START_FAILED', 'INSTALLER_EXITED', 'READY_TIMEOUT', 'CHECKSUM_MISMATCH']) {
    const f = fixture({ reply: { ok: false, code, installerPid: 9001, error: 'private path and token' },
      error: Object.assign(new Error('private path and token'), { code: 1 }) });
    const result = await f.launch();
    assert.deepEqual({ ...result }, { ok: false, code, installerPid: 9001, helperExitCode: 1 });
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('helper deadline, failed helper success output and malformed protocol cannot become successful handoffs', async () => {
  const timed = fixture({ error: Object.assign(new Error('private'), { killed: true, signal: 'SIGTERM' }), rawOutput: '' });
  assert.equal((await timed.launch()).code, 'HELPER_TIMEOUT');
  for (const options of [{ rawOutput: 'invalid JSON' }, { reply: null }, { reply: { ok: true, code: 'READY', installerPid: 0 } },
    { reply: { ok: true, code: 'READY', installerPid: 9001 }, error: Object.assign(new Error('failed'), { code: 1 }) },
    { reply: { ok: false, code: 'unexpected path' } }]) {
    const result = await fixture(options).launch();
    assert.equal(result.ok, false); assert.equal(result.code, 'PROTOCOL_ERROR');
  }
});

test('launch script remains ASCII/LF, uses RunAs and an explicitly secured manual-reset event without process termination', () => {
  const script = fs.readFileSync(path.join(__dirname, '../electron/assets/update-launch.ps1'), 'utf8');
  assert.ok(!script.includes('\r')); assert.ok([...script].every(value => value.charCodeAt(0) < 128));
  assert.match(script, /EventResetMode\]::ManualReset/);
  assert.match(script, /EventWaitHandleSecurity/);
  assert.match(script, /Start-Process[^\n]+-Verb RunAs[^\n]+-PassThru/);
  assert.match(script, /FileShare\]::Read/); assert.match(script, /ComputeHash/);
  assert.doesNotMatch(script, /Stop-Process|TerminateProcess|taskkill|kill-server/i);
});
