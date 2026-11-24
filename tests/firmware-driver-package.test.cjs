const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { inspectSignedDriver, signedDriverInfName } = require('../electron/lib/firmware-driver-package.cjs');
const { installWindowsDriver } = require('../electron/lib/firmware-tools-windows.cjs');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-driver-package-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

test('signed driver profiles accept only known platform names and local absolute directories', async () => {
  assert.equal(signedDriverInfName('rk'), 'rockusb.inf');
  assert.equal(signedDriverInfName('mtk'), 'cdc-acm.inf');
  const io = { realpath: () => assert.fail('invalid input must not reach the filesystem') };
  assert.equal(signedDriverInfName('constructor'), null);
  assert.deepEqual(await inspectSignedDriver('rk', 'relative', io), []);
  assert.deepEqual(await inspectSignedDriver('mtk', '//server/shared', io), []);
  assert.deepEqual(await inspectSignedDriver('constructor', path.resolve('.'), io), []);
});

test('installer names without the expected hash and driver package layout are not trusted', async t => {
  const directory = await temporaryDirectory(t);
  await fs.mkdir(path.join(directory, 'x64'));
  for (const relative of ['rockusb.inf', 'rockusb.cat', 'rockusb.sys', 'cdc-acm.inf', 'cdc-acm.cat', 'x64/usb2ser.sys']) {
    await fs.writeFile(path.join(directory, relative), 'not an approved driver payload');
  }
  assert.deepEqual(await inspectSignedDriver('rk', directory), []);
  assert.deepEqual(await inspectSignedDriver('mtk', directory), []);
});

test('neither firmware profile starts Windows elevation for an INF lacking the locked catalog', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporaryDirectory(t);
  const marker = 'benign non-installable fixture';
  const sha256 = createHash('sha256').update(marker).digest('hex');
  for (const platform of ['rk', 'mtk']) {
    const filename = path.join(directory, signedDriverInfName(platform));
    await fs.writeFile(filename, marker);
    assert.deepEqual(await installWindowsDriver(platform, [{ path: filename, sha256 }]), { ok: false, code: 'untrusted-package' });
  }
});

const execFileAsync = promisify(execFile);

function driverSignatureFixture(primary, fallback, elevationExpected) {
  return async script => {
    const replacements = [
      ['$signatureStatus = Get-DriverCatalogStatus $catalog', primary ? `$signatureStatus = '${primary}'` : "throw 'MOCK_MODULE_UNAVAILABLE'"],
      ["$signatureStatus = if ([FirmwareDriverStoreProbe]::VerifyCatalog($primary, $payload.catalogName)) { 'valid' } else { 'invalid' }",
        fallback ? `$signatureStatus = '${fallback}'` : "throw 'MOCK_NATIVE_VERIFIER_UNAVAILABLE'"],
    ];
    for (const [before, after] of replacements) {
      assert.ok(script.includes(before), `Missing fixture intercept: ${before}`);
      script = script.replace(before, after);
    }
    const stub = String.raw`
$ErrorActionPreference = 'Stop'
$runAsCount = 0
function Add-Type { param($TypeDefinition) }
function Start-Process {
  param($FilePath, $WorkingDirectory, $Verb, [switch]$PassThru, [switch]$Wait, $ArgumentList, $WindowStyle, $ErrorAction)
  $script:runAsCount++
  if ($Verb -ne 'RunAs' -or !$Wait -or !$PassThru -or $WindowStyle -ne 'Hidden' -or
      $FilePath -ne (Join-Path $env:SystemRoot 'System32\pnputil.exe') -or
      $ArgumentList.Count -ne 3 -or $ArgumentList[0] -ne '/add-driver' -or $ArgumentList[2] -ne '/install') {
    throw 'UNEXPECTED_PNP_ARGUMENTS'
  }
  $mock = [PSCustomObject]@{ ExitCode = 0 }
  $mock | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  return $mock
}
`;
    const source = stub + script + `\nif ($runAsCount -ne ${elevationExpected ? 1 : 0}) { throw 'UNEXPECTED_ELEVATION' }`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000 });
    return JSON.parse(stdout.trim());
  };
}

test('only unavailable signature verification may fall back; an invalid or unavailable signature never elevates', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporaryDirectory(t);
  const files = [];
  for (const name of ['rockusb.inf', 'rockusb.cat', 'rockusb.sys']) {
    const target = path.join(directory, name);
    await fs.writeFile(target, name);
    files.push({ path: target, sha256: createHash('sha256').update(name).digest('hex') });
  }
  const simulate = (primary, fallback, elevationExpected, packageFiles = files) => installWindowsDriver('rk', packageFiles,
    { runPowerShell: driverSignatureFixture(primary, fallback, elevationExpected) });
  assert.deepEqual(await simulate('valid', 'invalid', true), { ok: true, code: 'installer-exited', exitCode: 0 });
  assert.deepEqual(await simulate(null, 'valid', true), { ok: true, code: 'installer-exited', exitCode: 0 });
  assert.deepEqual(await simulate('invalid', 'valid', false), { ok: false, code: 'untrusted-package' });
  assert.deepEqual(await simulate(null, 'invalid', false), { ok: false, code: 'untrusted-package' });
  assert.deepEqual(await simulate(null, null, false), { ok: false, code: 'signature-check-unavailable' });
  assert.deepEqual(await simulate('valid', 'valid', false, [files[0], { ...files[1], sha256: files[0].sha256 }, files[2]]),
    { ok: false, code: 'untrusted-package' });
});
