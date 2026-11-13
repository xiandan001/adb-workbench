param(
    [string]$Mode = 'StopTools',
    [string]$PayloadBase64 = '',
    [switch]$EnvOnlyMode
)

$ErrorActionPreference = 'Stop'
$status = [ordered]@{ ok = $false; mode = $Mode; stopped = @(); skipped = @(); parent = 'not-requested'; applications = 'not-checked' }
$exitCode = 2
$allowedNames = @('adb.exe', 'scrcpy.exe', 'fastboot.exe', 'hdc.exe')

function Read-Payload {
    if (-not $PayloadBase64) { return [pscustomobject]@{} }
    if ($PayloadBase64.Length -gt 32768) { throw 'Process cleanup payload is too large.' }
    $bytes = [Convert]::FromBase64String($PayloadBase64)
    $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $payload = ConvertFrom-Json -InputObject $json
    if ($null -eq $payload -or $payload -isnot [pscustomobject]) { throw 'Process cleanup payload must be an object.' }
    return $payload
}

function Get-AbsolutePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)') {
        throw 'Process cleanup requires an absolute filesystem path.'
    }
    return [IO.Path]::GetFullPath($Value)
}

function Test-SamePath([string]$Left, [string]$Right) {
    return $Left -and $Right -and [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Timeout($Payload, [int]$DefaultValue) {
    if (-not $Payload.PSObject.Properties['timeoutMs']) { return $DefaultValue }
    $value = $Payload.timeoutMs
    $maximum = $(if ($Mode -eq 'PrepareInstall') { 60000 } else { 15000 })
    if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 1 -or $value -gt $maximum) {
        throw 'Process cleanup timeout is outside the allowed range.'
    }
    return [int]$value
}

function Initialize-NativeApi {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Veylo {
    public sealed class UpdateProcessHandle : IDisposable {
        private IntPtr handle;
        private readonly bool canTerminate;
        public readonly int Id;
        private UpdateProcessHandle(IntPtr value, int id, bool terminate) { handle = value; Id = id; canTerminate = terminate; }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint length, uint flags);

        public static UpdateProcessHandle Open(int id, bool allowTerminate) {
            // Keep this handle through image verification and wait/stop to avoid PID reuse races.
            const uint readAccess = 0x1000u | 0x100000u;
            IntPtr value = OpenProcess(readAccess | (allowTerminate ? 1u : 0u), false, id);
            bool canTerminate = allowTerminate && value != IntPtr.Zero;
            if (value == IntPtr.Zero && allowTerminate) { value = OpenProcess(readAccess, false, id); }
            return value == IntPtr.Zero ? null : new UpdateProcessHandle(value, id, canTerminate);
        }
        public string ImagePath() {
            int length = 32768;
            StringBuilder image = new StringBuilder(length);
            return QueryFullProcessImageNameW(handle, 0, image, ref length) ? image.ToString() : null;
        }
        public bool Wait(int milliseconds) {
            uint result = WaitForSingleObject(handle, (uint)milliseconds);
            if (result == 0xffffffff) { throw new InvalidOperationException("Unable to wait for process exit."); }
            return result == 0;
        }
        public void Stop() {
            if (!Wait(0) && (!canTerminate || (!TerminateProcess(handle, 0) && !Wait(0)))) {
                throw new InvalidOperationException("Unable to stop verified bundled tool.");
            }
        }
        public static string CanonicalPath(string path) {
            IntPtr file = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (file == new IntPtr(-1)) { return null; }
            try {
                StringBuilder result = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(file, result, (uint)result.Capacity, 0);
                if (length == 0 || length >= result.Capacity) { return null; }
                string value = result.ToString();
                if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) { return @"\\" + value.Substring(8); }
                return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value;
            } finally { CloseHandle(file); }
        }
        public void Dispose() {
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        }
    }
}
'@
}

function Get-ToolTargets($Payload) {
    if (-not $Payload.PSObject.Properties['targets'] -or $Payload.targets -isnot [array] -or $Payload.targets.Count -gt 16) {
        throw 'Process cleanup requires an array of at most 16 tool paths.'
    }
    foreach ($target in $Payload.targets) {
        if ($target -isnot [string]) { throw 'Tool targets must be filesystem paths.' }
        $absolute = Get-AbsolutePath $target
        if ($allowedNames -notcontains [IO.Path]::GetFileName($absolute)) { throw 'Tool executable name is not allowed.' }
        $absolute
    }
}

function Get-InstallTargets {
    $root = (Get-AbsolutePath $env:VEYLO_INSTALLER_ROOT).TrimEnd('\', '/')
    if (Test-SamePath ($root + '\') ([IO.Path]::GetPathRoot($root + '\'))) { throw 'Installation root must be an application directory.' }
    $appPath = Get-AbsolutePath $env:VEYLO_INSTALLER_APP_EXE
    if (-not (Test-SamePath ([IO.Path]::GetDirectoryName($appPath)) $root)) { throw 'Application executable must be directly inside the installation root.' }
    $script:canonicalRoot = [Veylo.UpdateProcessHandle]::CanonicalPath($root)
    $script:canonicalApp = [Veylo.UpdateProcessHandle]::CanonicalPath($appPath)
    foreach ($relative in @('scrcpy-win64\adb.exe', 'scrcpy-win64\scrcpy.exe', 'scrcpy-win64\fastboot.exe', 'hdc\hdc.exe')) {
        [IO.Path]::Combine($root, $relative)
    }
}

function Wait-ForUpdateParent([int]$TimeoutMs) {
    if ($EnvOnlyMode -or -not $env:VEYLO_UPDATE_PID) { return }
    $parentId = 0
    if (-not [int]::TryParse($env:VEYLO_UPDATE_PID, [ref]$parentId) -or $parentId -le 0) {
        $status.parent = 'identity-mismatch'; throw 'Updater process identity is invalid.'
    }
    $parent = [Veylo.UpdateProcessHandle]::Open($parentId, $false)
    if ($null -eq $parent) { $status.parent = 'unavailable'; return }
    try {
        if ($parent.Wait(0)) { $status.parent = 'exited'; return }
        $handoff = $null
        try { $handoff = [Veylo.UpdateProcessHandle]::CanonicalPath((Get-AbsolutePath $env:VEYLO_UPDATE_EXE)) } catch { }
        $image = [Veylo.UpdateProcessHandle]::CanonicalPath($parent.ImagePath())
        if (-not (Test-SamePath $handoff $script:canonicalApp) -or -not (Test-SamePath $image $script:canonicalApp)) {
            $status.parent = 'identity-mismatch'; throw 'Updater process image does not match the application executable.'
        }
        $status.parent = 'waiting'
        if (-not $parent.Wait($TimeoutMs)) { $status.parent = 'timeout'; throw 'Timed out waiting for the verified application to exit.' }
        $status.parent = 'exited'
    } finally { $parent.Dispose() }
}

function Wait-ForInstallApplications([int]$TimeoutMs) {
    if ($EnvOnlyMode -or -not $script:canonicalApp) { return }
    $handles = [Collections.Generic.List[Veylo.UpdateProcessHandle]]::new()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $name = [IO.Path]::GetFileNameWithoutExtension($script:canonicalApp)
        foreach ($candidate in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $main = [Veylo.UpdateProcessHandle]::Open($candidate.Id, $false)
            if ($null -eq $main) {
                if (-not (Get-Process -Id $candidate.Id -ErrorAction SilentlyContinue)) { continue }
                throw 'Unable to verify an application process before installation.'
            }
            try {
                if ($main.Wait(0)) { $main.Dispose(); continue }
                $image = [Veylo.UpdateProcessHandle]::CanonicalPath($main.ImagePath())
                if (-not $image) {
                    if ($main.Wait(0)) { $main.Dispose(); continue }
                    throw 'Unable to verify an application image before installation.'
                }
                if (-not (Test-SamePath $image $script:canonicalApp)) { $main.Dispose(); continue }
                $handles.Add($main)
            } catch { $main.Dispose(); throw }
        }
        $status.applications = 'waiting'
        foreach ($main in $handles) {
            $remaining = [Math]::Max(0, $TimeoutMs - [int]$clock.ElapsedMilliseconds)
            if (-not $main.Wait($remaining)) {
                $status.applications = 'timeout'; $script:exitCode = 3
                throw 'Close the application before installing; it will not be force-terminated.'
            }
        }
        $status.applications = 'exited'
    } finally { foreach ($main in $handles) { $main.Dispose() } }
}

function Stop-ToolTargets([string[]]$Targets, [int]$TimeoutMs) {
    $canonicalTargets = @()
    foreach ($target in $Targets) {
        $canonical = [Veylo.UpdateProcessHandle]::CanonicalPath($target)
        if (-not $canonical -or -not (Test-SamePath ([IO.Path]::GetFileName($canonical)) ([IO.Path]::GetFileName($target)))) { continue }
        if ($Mode -eq 'PrepareInstall' -and (-not $script:canonicalRoot -or -not $canonical.StartsWith(($script:canonicalRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase))) { continue }
        $canonicalTargets += $canonical
    }
    if (-not $canonicalTargets.Count) { return }
    $handles = [Collections.Generic.List[Veylo.UpdateProcessHandle]]::new()
    try {
        $candidates = @(Get-Process -Name 'adb', 'scrcpy', 'fastboot', 'hdc' -ErrorAction SilentlyContinue)
        foreach ($candidate in $candidates) {
            $tool = [Veylo.UpdateProcessHandle]::Open($candidate.Id, $true)
            if ($null -eq $tool) { $status.skipped += $candidate.Id; continue }
            $image = [Veylo.UpdateProcessHandle]::CanonicalPath($tool.ImagePath())
            if (-not $image -or -not @($canonicalTargets | Where-Object { Test-SamePath $_ $image }).Count) {
                $status.skipped += $candidate.Id; $tool.Dispose(); continue
            }
            $handles.Add($tool)
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        foreach ($tool in $handles) { $tool.Stop() }
        foreach ($tool in $handles) {
            $remaining = [Math]::Max(0, $TimeoutMs - [int]$clock.ElapsedMilliseconds)
            if (-not $tool.Wait($remaining)) { throw 'Timed out waiting for a verified bundled tool to exit.' }
            $status.stopped += $tool.Id
        }
    } finally { foreach ($tool in $handles) { $tool.Dispose() } }
}

try {
    if ($Mode -notin @('StopTools', 'PrepareInstall')) { throw 'Unknown process cleanup mode.' }
    $payload = Read-Payload
    $timeout = Get-Timeout $payload $(if ($Mode -eq 'PrepareInstall') { 60000 } else { 5000 })
    if ($Mode -eq 'StopTools') { $targets = @(Get-ToolTargets $payload) }
    Initialize-NativeApi
    if ($Mode -eq 'PrepareInstall') {
        $targets = @(Get-InstallTargets)
        $applicationClock = [Diagnostics.Stopwatch]::StartNew()
        try { Wait-ForUpdateParent $timeout }
        catch { if ($status.parent -eq 'timeout') { $exitCode = 3 }; throw }
        Wait-ForInstallApplications ([Math]::Max(0, $timeout - [int]$applicationClock.ElapsedMilliseconds))
    }
    $exitCode = 1
    Stop-ToolTargets $targets ([Math]::Min($timeout, 5000))
    $status.ok = $true
    $exitCode = 0
} catch {
    $status.error = $_.Exception.Message
}
[Console]::Out.WriteLine(($status | ConvertTo-Json -Depth 4 -Compress))
exit $exitCode
