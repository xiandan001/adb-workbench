const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const system32 = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function powershell(script, timeout = 12_000) {
  const absolutePath = path.join(system32(), 'WindowsPowerShell/v1.0/powershell.exe');
  const source = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + script;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(absolutePath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else {
          try { resolve(JSON.parse(stdout.trim())); }
          catch (failure) { reject(failure); }
        }
      });
    child.stdin?.end();
  });
}

function queryWindowsDrivers() {
  return powershell(String.raw`
$registry = 'HKLM:\SYSTEM\DriverDatabase\DriverPackages'
$packages = @(
  foreach ($entry in (Get-ChildItem -LiteralPath $registry -ErrorAction Stop)) {
    if ($entry.PSChildName -notmatch '^(rockusb|cdc-acm|mtk_sp_usb2ser|mtk_usb|usbvcom).*\.inf_') { continue }
    $value = Get-ItemProperty -LiteralPath $entry.PSPath
    [ordered]@{ inf = $value.InfName; provider = $value.Provider; published = $value.'(default)'; signer = $value.SignerName }
  }
)
$devices = @(
  Get-PnpDevice -PresentOnly -ErrorAction Stop |
    Where-Object { $_.InstanceId -match '^USB\\VID_(2207|0E8D)&PID_[0-9A-F]{4}\\' } |
    Select-Object -First 32 |
    ForEach-Object {
      $instance = $_.InstanceId
      $name = $_.FriendlyName
      $properties = @{}
      Get-PnpDeviceProperty -InstanceId $instance -KeyName @('DEVPKEY_Device_DriverInfPath','DEVPKEY_Device_Service','DEVPKEY_Device_ProblemCode') -ErrorAction SilentlyContinue |
        ForEach-Object { if ($null -ne $_.Data) { $properties[$_.KeyName] = $_.Data } }
      [ordered]@{ hardwareId = ($instance -split '\\')[1]; name = $name
        problemCode = $properties['DEVPKEY_Device_ProblemCode']; driverInf = $properties['DEVPKEY_Device_DriverInfPath']
        service = $properties['DEVPKEY_Device_Service'] }
    }
)
[ordered]@{ packages = $packages; devices = $devices } | ConvertTo-Json -Depth 4 -Compress
`, 25_000);
}

async function installWindowsDriver(platform, files) {
  const data = Buffer.from(JSON.stringify({ platform, files }), 'utf8').toString('base64');
  return powershell("$data = '" + data + "'\n" + String.raw`
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) | ConvertFrom-Json
$held = @()
$child = $null
$result = [ordered]@{ ok = $false; code = 'untrusted-package' }
try {
  foreach ($entry in $payload.files) {
    $file = [IO.FileStream]::new($entry.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $held += $file
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($file)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($hash -cne $entry.sha256) { throw 'CHECKSUM_MISMATCH' }
  }
  $primary = $payload.files[0].path
  $folder = [IO.Path]::GetDirectoryName($primary)
  if ($payload.platform -eq 'rk') {
    $catalog = Join-Path $folder 'rockusb.cat'
    if ((Get-AuthenticodeSignature -LiteralPath $catalog).Status -ne 'Valid') { throw 'UNTRUSTED_CATALOG' }
    $executable = Join-Path $env:SystemRoot 'System32\pnputil.exe'
    $arguments = @('/add-driver', ('"' + $primary + '"'), '/install')
  } elseif ($payload.platform -eq 'mtk') {
    $executable = $primary
    $arguments = @()
  } else { throw 'UNSUPPORTED_PLATFORM' }

  $result.code = 'install-failed'
  $options = @{ FilePath = $executable; WorkingDirectory = $folder; Verb = 'RunAs'; PassThru = $true; Wait = $true; ErrorAction = 'Stop' }
  if ($arguments.Count -gt 0) { $options.ArgumentList = $arguments }
  if ($payload.platform -eq 'rk') { $options.WindowStyle = 'Hidden' }
  $child = Start-Process @options
  $result.exitCode = $child.ExitCode
  $result.ok = $result.exitCode -in @(0, 3010)
  $result.code = if ($result.exitCode -eq 0) { 'installer-exited' } elseif ($result.exitCode -eq 3010) { 'restart-required' } elseif ($result.exitCode -eq 1602) { 'uac-cancelled' } else { 'install-failed' }
} catch {
  for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {
    if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { $result.code = 'uac-cancelled'; break }
  }
} finally {
  if ($child) { $child.Dispose() }
  foreach ($file in $held) { $file.Dispose() }
}
$result | ConvertTo-Json -Compress
`, 30 * 60 * 1000);
}

function launchWindowsTool(executable) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false });
    process.once('error', reject);
    process.once('spawn', () => { process.unref(); resolve(); });
  });
}

module.exports = { queryWindowsDrivers, installWindowsDriver, launchWindowsTool };
