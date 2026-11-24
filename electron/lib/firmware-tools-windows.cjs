const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { signedDriverInfName } = require('./firmware-driver-package.cjs');

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

const driverStoreProbe = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class FirmwareDriverStoreProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SignerInfo {
    public uint size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string catalog;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string signer;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string version;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct InfContext {
    public IntPtr inf, currentInf;
    public uint section, line;
  }
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)]
  private static extern bool SetupGetInfPublishedName(string inf, StringBuilder name, uint capacity, out uint required);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)]
  private static extern bool SetupVerifyInfFile(string inf, IntPtr platform, ref SignerInfo info);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr SetupOpenInfFile(string name, string infClass, uint style, IntPtr errorLine);
  [DllImport("setupapi.dll")]
  private static extern void SetupCloseInfFile(IntPtr inf);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)]
  private static extern bool SetupFindFirstLine(IntPtr inf, string section, string key, out InfContext context);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)]
  private static extern bool SetupGetStringField(ref InfContext context, uint field, StringBuilder value, uint capacity, out uint required);

  public static bool VerifyCatalog(string inf, string expectedCatalog) {
    var signature = new SignerInfo { size = (uint)Marshal.SizeOf(typeof(SignerInfo)) };
    return SetupVerifyInfFile(inf, IntPtr.Zero, ref signature) &&
      String.Equals(Path.GetFileName(signature.catalog), expectedCatalog, StringComparison.OrdinalIgnoreCase);
  }

  public static string[] Query(string inf) {
    uint required;
    var published = new StringBuilder(1024);
    if (!SetupGetInfPublishedName(inf, published, (uint)published.Capacity, out required)) return null;
    var name = Path.GetFileName(published.ToString());
    if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^oem\d+\.inf$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return null;
    var signature = new SignerInfo { size = (uint)Marshal.SizeOf(typeof(SignerInfo)) };
    if (!SetupVerifyInfFile(inf, IntPtr.Zero, ref signature)) return null;
    var handle = SetupOpenInfFile(inf, null, 2, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return null;
    try {
      InfContext providerLine;
      var provider = new StringBuilder(256);
      if (!SetupFindFirstLine(handle, "Version", "Provider", out providerLine) ||
          !SetupGetStringField(ref providerLine, 1, provider, (uint)provider.Capacity, out required)) return null;
      return new[] { Path.GetFileName(inf), provider.ToString(), name, signature.signer };
    } finally { SetupCloseInfFile(handle); }
  }
}
'@
`;

function queryWindowsDrivers() {
  return powershell(String.raw`${driverStoreProbe}
$driverStore = Join-Path $env:SystemRoot 'System32\DriverStore\FileRepository'
$packages = @(
  foreach ($entry in [IO.Directory]::EnumerateDirectories($driverStore)) {
    $name = [IO.Path]::GetFileName($entry)
    if ($name -notmatch '^(rockusb\.inf|cdc-acm\.inf|mtk_sp_usb2ser\.inf|mtk_usb[a-z0-9_]*\.inf|usbvcom[a-z0-9_]*\.inf)_') { continue }
    $values = [FirmwareDriverStoreProbe]::Query((Join-Path $entry $Matches[1]))
    if ($values) { [ordered]@{ inf = $values[0]; provider = $values[1]; published = $values[2]; signer = $values[3] } }
  }
)
$matchingUsb = "Present = TRUE AND (PNPDeviceID LIKE '%VID_2207&PID_%' OR PNPDeviceID LIKE '%VID_0E8D&PID_%')"
$devices = @(
  Get-CimInstance -ClassName Win32_PnPEntity -Filter $matchingUsb -Property Name,PNPDeviceID,ConfigManagerErrorCode,Service |
    Where-Object { $_.PNPDeviceID -match '^USB\\VID_(2207|0E8D)&PID_[0-9A-F]{4}\\' } |
    Select-Object -First 32 |
    ForEach-Object {
      $device = $_
      $inf = Get-PnpDeviceProperty -InstanceId $device.PNPDeviceID -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction SilentlyContinue
      [ordered]@{ hardwareId = ($device.PNPDeviceID -split '\\')[1]; name = $device.Name
        problemCode = $device.ConfigManagerErrorCode; driverInf = $inf.Data; service = $device.Service }
    }
)
[ordered]@{ packages = $packages; devices = $devices } | ConvertTo-Json -Depth 4 -Compress
`, 25_000);
}

async function installWindowsDriver(platform, files, { runPowerShell = powershell } = {}) {
  const infName = signedDriverInfName(platform);
  if (!infName || !files?.length) return { ok: false, code: 'untrusted-package' };
  const catalogName = infName.replace(/\.inf$/, '.cat');
  const data = Buffer.from(JSON.stringify({ platform, infName, catalogName, files }), 'utf8').toString('base64');
  return runPowerShell("$data = '" + data + "'\n" + String.raw`
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) | ConvertFrom-Json
function Get-DriverCatalogStatus([string]$catalog) {
  $manifest = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  Import-Module -Name $manifest -ErrorAction Stop
  $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $catalog -ErrorAction Stop
  if ($null -eq $signature) { throw 'NO_SIGNATURE_RESULT' }
  if ($signature.Status -eq 'Valid') { 'valid' } else { 'invalid' }
}
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
  $name = [IO.Path]::GetFileName($primary)
  $signedInf = $name -eq $payload.infName
  if ($signedInf) {
    $catalog = Join-Path $folder $payload.catalogName
    if ($catalog -notin $payload.files.path) { throw 'MISSING_CHECKED_CATALOG' }
    try {
      $signatureStatus = Get-DriverCatalogStatus $catalog
    } catch {
      $signatureStatus = 'unavailable'
      try {
${driverStoreProbe}
        $signatureStatus = if ([FirmwareDriverStoreProbe]::VerifyCatalog($primary, $payload.catalogName)) { 'valid' } else { 'invalid' }
      } catch {}
    }
    if ($signatureStatus -is [string] -and $signatureStatus -ceq 'invalid') { throw 'UNTRUSTED_CATALOG' }
    if ($signatureStatus -isnot [string] -or $signatureStatus -cne 'valid') {
      $result.code = 'signature-check-unavailable'
      throw 'SIGNATURE_CHECK_UNAVAILABLE'
    }
    $executable = Join-Path $env:SystemRoot 'System32\pnputil.exe'
    $arguments = @('/add-driver', ('"' + $primary + '"'), '/install')
  } elseif ($payload.platform -eq 'mtk' -and $name -eq 'DriverInstall.exe') {
    $executable = $primary
    $arguments = @()
  } else { throw 'UNSUPPORTED_PLATFORM' }

  $result.code = 'install-failed'
  $options = @{ FilePath = $executable; WorkingDirectory = $folder; Verb = 'RunAs'; PassThru = $true; Wait = $true; ErrorAction = 'Stop' }
  if ($arguments.Count -gt 0) { $options.ArgumentList = $arguments }
  if ($signedInf) { $options.WindowStyle = 'Hidden' }
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

const toolStartupMs = 900;
const shellFallbackErrors = new Set(['EINVAL', 'UNKNOWN']);
const toolLaunchError = code => Object.assign(new Error(code), { code });

function spawnVendorTool(executable, spawnProcess, startupMs) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false });
    let ready;
    child.once('error', error => {
      clearTimeout(ready);
      reject(error);
    });
    child.once('spawn', () => {
      ready = setTimeout(() => { child.unref(); resolve(); }, startupMs);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(ready);
      if (code === 0 && !signal) resolve();
      else reject(toolLaunchError('tool-exited-early'));
    });
  });
}

async function shellOpenVendorTool(executable, runPowerShell) {
  const payload = Buffer.from(executable, 'utf8').toString('base64');
  return runPowerShell("$data = '" + payload + "'\n" + String.raw`
$executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data))
$workingDirectory = [IO.Path]::GetDirectoryName($executable)
$child = $null
$result = [ordered]@{ ok = $false; code = 'tool-launch-failed' }
try {
  $child = Start-Process -FilePath $executable -WorkingDirectory $workingDirectory -Verb Open -WindowStyle Normal -PassThru
  if ($child.WaitForExit(900) -and $child.ExitCode -ne 0) { $result.code = 'tool-exited-early' }
  else { $result.ok = $true }
} catch {
  for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {
    if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in @(5, 740, 1223, 1260)) {
      $result.code = 'tool-access-denied'
      break
    }
  }
} finally {
  if ($child) { $child.Dispose() }
}
$result | ConvertTo-Json -Compress
`);
}

async function launchWindowsTool(executable, { spawnProcess = spawn, runPowerShell = powershell, startupMs = toolStartupMs } = {}) {
  try { await spawnVendorTool(executable, spawnProcess, startupMs); }
  catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw toolLaunchError('tool-access-denied');
    if (error.code === 'ENOENT') throw toolLaunchError('tool-unavailable');
    if (!shellFallbackErrors.has(error.code)) throw error;
    const result = await shellOpenVendorTool(executable, runPowerShell);
    if (!result?.ok) throw toolLaunchError(result?.code || 'tool-launch-failed');
  }
}

module.exports = { queryWindowsDrivers, installWindowsDriver, launchWindowsTool };
