const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../electron/lib/android-tool-cleanup.cjs'), 'utf8');

function fixture({ packaged = false, reply = { ok: true }, failure = null, missingScript = false } = {}) {
  const calls = [];
  const root = "C:\\Tools\\Veylo's app";
  const resourcesPath = packaged ? path.win32.join(root, 'resources') : undefined;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, setTimeout,
    __dirname: packaged ? path.win32.join(resourcesPath, 'app.asar', 'electron', 'lib') : path.win32.join(root, 'electron', 'lib'),
    process: { platform: 'win32', resourcesPath, execPath: path.win32.join(root, 'Veylo.exe'), env: { SystemRoot: 'C:\\Windows' } },
    require(name) {
      if (name === 'fs') return { existsSync: file => !file.includes('Sysnative') && !(missingScript && file.endsWith('.ps1')),
        statSync: () => ({ isFile: () => true, size: 1 }) };
      if (name === 'path') return path.win32;
      if (name === 'child_process') return { execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        queueMicrotask(() => callback(failure, JSON.stringify(reply), ''));
        return { stdin: { end() {} } };
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: 'android-tool-cleanup.cjs' });
  return { api: module.exports, calls, root };
}

function payload(call) {
  return JSON.parse(Buffer.from(call.args[call.args.indexOf('-PayloadBase64') + 1], 'base64').toString('utf8'));
}

test('cleanup invokes the fixed script with data-only full executable paths', async () => {
  const f = fixture();
  const result = await f.api.cleanupAndroidToolProcesses({ includeScrcpy: true, includeFastboot: true, settleMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(call.args[call.args.indexOf('-File') + 1], path.win32.join(f.root, 'electron/assets/update-processes.ps1'));
  assert.equal(call.args[call.args.indexOf('-Mode') + 1], 'StopTools');
  assert.ok(!call.args.includes('-Command') && !call.args.includes('-EncodedCommand'));
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(payload(call).targets, ['adb.exe', 'scrcpy.exe', 'fastboot.exe'].map(name => path.win32.join(f.root, 'scrcpy-win64', name)));
  assert.ok(payload(call).targets.every(target => !target.includes('\\\\')));
  assert.ok(!call.args.some(arg => arg.includes('kill-server')));
});

test('normal quit excludes HDC and update cleanup can explicitly include its bundled path', async () => {
  const f = fixture();
  await f.api.cleanupAndroidToolProcesses({ settleMs: 0 });
  assert.deepEqual(payload(f.calls[0]).targets, [path.win32.join(f.root, 'scrcpy-win64', 'adb.exe')]);
  await f.api.cleanupAndroidToolProcesses({ includeHdc: true, settleMs: 0 });
  assert.deepEqual(payload(f.calls[1]).targets, [path.win32.join(f.root, 'scrcpy-win64', 'adb.exe'), path.win32.join(f.root, 'hdc', 'hdc.exe')]);
});

test('packaged cleanup selects the unpacked PowerShell resource', async () => {
  const f = fixture({ packaged: true });
  await f.api.cleanupAndroidToolProcesses({ settleMs: 0 });
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-File') + 1], path.win32.join(f.root, 'resources/app.asar.unpacked/electron/assets/update-processes.ps1'));
});

test('nonzero script failures and missing resources cannot report prepared success', async () => {
  const f = fixture({ reply: { ok: false, error: 'Timed out waiting for tool exit' }, failure: new Error('Command failed') });
  const result = await f.api.cleanupAndroidToolProcesses({ settleMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Timed out/);
  const absent = fixture({ missingScript: true });
  assert.equal((await absent.api.cleanupAndroidToolProcesses({ settleMs: 0 })).ok, false);
  assert.equal(absent.calls.length, 0);
});

test('legacy explicit server stop remains opt-in and is never part of update flags', async () => {
  const f = fixture();
  await f.api.cleanupAndroidToolProcesses({ stopAdbServer: true, settleMs: 0 });
  assert.deepEqual(Array.from(f.calls[0].args), ['kill-server']);
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('-Mode') + 1], 'StopTools');
});

test('shared PowerShell asset is ASCII/LF and retains exact path and bounded identity checks', () => {
  const script = fs.readFileSync(path.join(__dirname, '../electron/assets/update-processes.ps1'), 'utf8');
  assert.ok(!script.includes('\r'));
  assert.ok([...script].every(character => character.charCodeAt(0) < 128));
  assert.match(script, /GetFinalPathNameByHandleW/);
  assert.match(script, /QueryFullProcessImageNameW/);
  assert.match(script, /WaitForSingleObject/);
  assert.match(script, /EnvOnlyMode/);
  assert.doesNotMatch(script, /kill-server|Stop-Process\s+-Name|taskkill\s+\/IM/i);
});
