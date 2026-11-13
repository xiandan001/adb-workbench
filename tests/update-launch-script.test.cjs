const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const script = fs.readFileSync(path.join(__dirname, '../electron/assets/update-launch.ps1'), 'utf8');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const digest = value => crypto.createHash('sha512').update(value).digest('base64');

const harness = `
$ErrorActionPreference = 'Stop'
function Invoke-FixtureStartProcess {
    [CmdletBinding()]
    param([string]$FilePath, [string[]]$ArgumentList, [string]$Verb, [switch]$PassThru)
    if ($FilePath -cne $env:VEYLO_FIXTURE_INSTALLER -or $Verb -cne 'RunAs' -or -not $PassThru -or $ArgumentList.Count -ne 5) { throw 'Invalid fixture launch protocol' }
    if ($ArgumentList[0] -cne '--updated' -or $ArgumentList[1] -cne '--force-run' -or $ArgumentList[2] -cnotmatch '^--veylo-ready-token=[a-f0-9]{32}$' -or $ArgumentList[3] -cne '--veylo-update-pid=4242' -or $ArgumentList[4] -cne '--veylo-language=ja-JP') { throw 'Unsafe fixture argument' }
    $writeBlocked = $false
    try { $writer = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $writer.Dispose() } catch [IO.IOException] { $writeBlocked = $true }
    if (-not $writeBlocked) { throw 'Verified installer must remain locked against writes' }
    [Console]::Error.WriteLine('fixture-start-called-with-read-lock')
    if ($env:VEYLO_FIXTURE_SCENARIO -eq 'cancel') { throw [ComponentModel.Win32Exception]::new(1223) }
    if ($env:VEYLO_FIXTURE_SCENARIO -eq 'start-failed') { throw 'Sensitive fixture exception that must not escape' }
    $process = [pscustomobject]@{ Id = 9001; HasExited = ($env:VEYLO_FIXTURE_SCENARIO -eq 'exited') }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    $token = $ArgumentList[2].Substring('--veylo-ready-token='.Length)
    $event = [Threading.EventWaitHandle]::OpenExisting('Local\\Veylo.Update.Ready.' + $token)
    try { [void]$event.Set() } finally { $event.Dispose() }
    return $process
}
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VEYLO_FIXTURE_SCRIPT))
if ($source -match '(?m)^\\s*[^#\\r\\n]*\\bStart-Process\\b') { throw 'Real Start-Process must be unreachable in this fixture' }
& ([ScriptBlock]::Create($source)) -PayloadBase64 $env:VEYLO_FIXTURE_PAYLOAD
`;

function runFixture(t, scenario, { wrongHash = false } = {}) {
  const temporaryParent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, 'veylo-launch-script-test-'));
  assert.equal(path.dirname(root), temporaryParent);
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.relative(temporaryParent, root).startsWith('veylo-launch-script-test-'));
    fs.rmSync(root, { recursive: true });
  });
  // These bytes are not a runnable PE; the only launch dependency below is replaced with a pure function.
  const installer = path.join(root, "fixture installer's 设备.exe");
  const bytes = Buffer.from('MZ non-runnable owned fixture');
  fs.writeFileSync(installer, bytes, { flag: 'wx' });
  const token = crypto.randomBytes(16).toString('hex');
  const payload = { installerPath: installer, parentPid: 4242, locale: 'ja-JP', readyToken: token,
    sha512: digest(wrongHash ? Buffer.from('wrong') : bytes) };
  const calls = script.match(/Start-Process -FilePath/g) || [];
  assert.equal(calls.length, 1, 'only the fixed launch call may be replaced for this unit fixture');
  const mocked = script.replace('Start-Process -FilePath', 'Invoke-FixtureStartProcess -FilePath');
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, VEYLO_FIXTURE_INSTALLER: installer, VEYLO_FIXTURE_SCENARIO: scenario,
      VEYLO_FIXTURE_SCRIPT: Buffer.from(mocked, 'utf8').toString('base64'),
      VEYLO_FIXTURE_PAYLOAD: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') },
  });
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, value: JSON.parse(result.stdout.trim()), stderr: result.stderr };
}

test('PowerShell launch unit uses a locked file and only succeeds after a real ready event for its fake live process',
  { skip: process.platform !== 'win32' }, t => {
    const result = runFixture(t, 'ready');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.value, { ok: true, code: 'READY', installerPid: 9001 });
    assert.match(result.stderr, /fixture-start-called-with-read-lock/);
  });

test('PowerShell launch unit converts simulated UAC cancellation and launch errors into sanitized failures',
  { skip: process.platform !== 'win32' }, t => {
    for (const [scenario, code] of [['cancel', 'UAC_CANCELLED'], ['start-failed', 'START_FAILED']]) {
      const result = runFixture(t, scenario);
      assert.notEqual(result.status, 0); assert.equal(result.value.ok, false); assert.equal(result.value.code, code);
      assert.ok(!JSON.stringify(result.value).includes('Sensitive'));
    }
  });

test('PowerShell launch unit rejects a signaled event when the fake installer already exited',
  { skip: process.platform !== 'win32' }, t => {
    const result = runFixture(t, 'exited');
    assert.notEqual(result.status, 0); assert.equal(result.value.ok, false); assert.equal(result.value.code, 'INSTALLER_EXITED');
  });

test('PowerShell checksum revalidation fails before its mocked Start-Process can run',
  { skip: process.platform !== 'win32' }, t => {
    const result = runFixture(t, 'ready', { wrongHash: true });
    assert.notEqual(result.status, 0); assert.equal(result.value.code, 'CHECKSUM_MISMATCH');
    assert.ok(!result.stderr.includes('fixture-start-called'));
  });

test('the actual ready-wait function rejects an unsignaled event on a short isolated timeout',
  { skip: process.platform !== 'win32' }, () => {
    const waitFunction = /function Wait-InstallerReady\([^]*?\n}/.exec(script)?.[0];
    assert.ok(waitFunction);
    assert.ok(!waitFunction.includes('Start-Process'));
    const code = `${waitFunction}
$process = [pscustomobject]@{ Id = 9001; HasExited = $false }
$process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
$event = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset)
try { $result = Wait-InstallerReady $process $event 5; [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)) } finally { $event.Dispose() }
`;
    const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).code, 'READY_TIMEOUT');
  });
