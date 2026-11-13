$ErrorActionPreference = 'Stop'
$mutex = $null
try {
    $mutex = [Threading.Mutex]::OpenExisting('Global\Veylo.adb-workbench.Install.v1', [Security.AccessControl.MutexRights]::Synchronize)
    [Console]::Out.WriteLine('{"ok":true,"active":true}')
    exit 0
} catch [Threading.WaitHandleCannotBeOpenedException] {
    [Console]::Out.WriteLine('{"ok":true,"active":false}')
    exit 0
} catch {
    [Console]::Out.WriteLine('{"ok":false,"active":true,"code":"PROBE_UNAVAILABLE"}')
    exit 1
} finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
}
