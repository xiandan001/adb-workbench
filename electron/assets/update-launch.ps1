param([string]$PayloadBase64 = '')

$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $false; code = 'INVALID_INPUT' }
$exitCode = 2
$installerFile = $null
$readyEvent = $null
$installer = $null

function Read-LaunchPayload {
    if (-not $PayloadBase64 -or $PayloadBase64.Length -gt 32768) { throw 'INVALID_INPUT' }
    $bytes = [Convert]::FromBase64String($PayloadBase64)
    $payload = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($bytes))
    if ($null -eq $payload -or $payload -isnot [pscustomobject]) { throw 'INVALID_INPUT' }
    $names = @($payload.PSObject.Properties.Name)
    if ($names.Count -ne 5 -or @($names | Where-Object { $_ -notin @('installerPath', 'parentPid', 'locale', 'readyToken', 'sha512') }).Count) { throw 'INVALID_INPUT' }
    if ($payload.installerPath -isnot [string] -or $payload.installerPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or $payload.installerPath.Contains([char]0)) { throw 'INVALID_INPUT' }
    if ([IO.Path]::GetExtension($payload.installerPath) -ine '.exe') { throw 'INVALID_INPUT' }
    if (($payload.parentPid -isnot [int] -and $payload.parentPid -isnot [long]) -or $payload.parentPid -lt 1 -or $payload.parentPid -gt 2147483647) { throw 'INVALID_INPUT' }
    if ($payload.locale -isnot [string] -or $payload.locale -cnotin @('en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR')) { throw 'INVALID_INPUT' }
    if ($payload.readyToken -isnot [string] -or $payload.readyToken -cnotmatch '^[a-f0-9]{32}$') { throw 'INVALID_INPUT' }
    if ($payload.sha512 -isnot [string] -or $payload.sha512 -cnotmatch '^[A-Za-z0-9+/]{86}==$' -or [Convert]::FromBase64String($payload.sha512).Length -ne 64) { throw 'INVALID_INPUT' }
    $payload.installerPath = [IO.Path]::GetFullPath($payload.installerPath)
    return $payload
}

function New-ReadyEvent([string]$Token) {
    $security = [Security.AccessControl.EventWaitHandleSecurity]::new()
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    foreach ($identity in @($currentUser, $system)) {
        $security.AddAccessRule([Security.AccessControl.EventWaitHandleAccessRule]::new($identity, [Security.AccessControl.EventWaitHandleRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    }
    $adminRights = [Security.AccessControl.EventWaitHandleRights]::Modify -bor [Security.AccessControl.EventWaitHandleRights]::Synchronize
    $security.AddAccessRule([Security.AccessControl.EventWaitHandleAccessRule]::new($administrators, $adminRights, [Security.AccessControl.AccessControlType]::Allow))
    $created = $false
    $event = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, ('Local\Veylo.Update.Ready.' + $Token), [ref]$created, $security)
    if (-not $created) { $event.Dispose(); throw 'PROTOCOL_ERROR' }
    return $event
}

function Wait-InstallerReady($Process, $Event, [int]$TimeoutMs) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt $TimeoutMs) {
        $Process.Refresh()
        if ($Process.HasExited) { return @{ ok = $false; code = 'INSTALLER_EXITED'; installerPid = $Process.Id } }
        $remaining = [Math]::Max(0, $TimeoutMs - [int]$clock.ElapsedMilliseconds)
        if ($Event.WaitOne([Math]::Min(100, $remaining))) {
            $Process.Refresh()
            if ($Process.HasExited) { return @{ ok = $false; code = 'INSTALLER_EXITED'; installerPid = $Process.Id } }
            return @{ ok = $true; code = 'READY'; installerPid = $Process.Id }
        }
    }
    return @{ ok = $false; code = 'READY_TIMEOUT'; installerPid = $Process.Id }
}

function Test-UacCancelled($Exception) {
    while ($null -ne $Exception) {
        if ($Exception -is [ComponentModel.Win32Exception] -and $Exception.NativeErrorCode -eq 1223) { return $true }
        $Exception = $Exception.InnerException
    }
    return $false
}

try {
    $payload = Read-LaunchPayload
    $result.code = 'INVALID_INSTALLER'
    # A read-only share keeps the verified file from being changed or deleted until handoff completes.
    $installerFile = [IO.FileStream]::new($payload.installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($installerFile.Length -lt 2 -or $installerFile.ReadByte() -ne 77 -or $installerFile.ReadByte() -ne 90) { throw 'INVALID_INSTALLER' }
    $installerFile.Position = 0
    $hash = [Security.Cryptography.SHA512]::Create()
    try { $actualHash = [Convert]::ToBase64String($hash.ComputeHash($installerFile)) } finally { $hash.Dispose() }
    if ($actualHash -cne $payload.sha512) { $result.code = 'CHECKSUM_MISMATCH'; throw 'CHECKSUM_MISMATCH' }
    $result.code = 'PROTOCOL_ERROR'
    $readyEvent = New-ReadyEvent $payload.readyToken
    $arguments = @('--updated', '--force-run', ('--veylo-ready-token=' + $payload.readyToken),
        ('--veylo-update-pid=' + $payload.parentPid), ('--veylo-language=' + $payload.locale))
    $result.code = 'START_FAILED'
    try {
        # The installer is the visible interactive surface; the launcher itself remains hidden.
        $installer = Start-Process -FilePath $payload.installerPath -ArgumentList $arguments -Verb RunAs -PassThru -ErrorAction Stop
    } catch {
        if (Test-UacCancelled $_.Exception) { $result.code = 'UAC_CANCELLED' }
        throw
    }
    if ($null -eq $installer -or $installer.Id -lt 1) { throw 'START_FAILED' }
    $result = Wait-InstallerReady $installer $readyEvent 30000
    $exitCode = $(if ($result.ok) { 0 } else { 1 })
} catch {
    # Only fixed typed codes leave this process; exceptions can contain private paths and tokens.
    $result.ok = $false
} finally {
    if ($null -ne $installer) { $installer.Dispose() }
    if ($null -ne $readyEvent) { $readyEvent.Dispose() }
    if ($null -ne $installerFile) { $installerFile.Dispose() }
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
exit $exitCode
