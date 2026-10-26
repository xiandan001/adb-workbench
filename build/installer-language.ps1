$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stream = $null
try {
    $file = [Environment]::GetEnvironmentVariable('VEYLO_INSTALLER_SETTINGS_FILE')
    if ([string]::IsNullOrWhiteSpace($file) -or -not [IO.Path]::IsPathRooted($file)) { return }
    $maximumBytes = 262144
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    if ($stream.Length -gt $maximumBytes) { return }
    $bytes = New-Object byte[] ($maximumBytes + 1)
    $count = 0
    do {
        $read = $stream.Read($bytes, $count, $bytes.Length - $count)
        $count += $read
    } while ($read -gt 0 -and $count -lt $bytes.Length)
    if ($count -gt $maximumBytes) { return }
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $text = $utf8.GetString($bytes, 0, $count).TrimStart([char]0xFEFF)
    $settings = ConvertFrom-Json -InputObject $text
    if ($settings -isnot [System.Management.Automation.PSCustomObject]) { return }
    $locale = $settings.locale
    if ($locale -is [string] -and @('zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR') -ccontains $locale) {
        [Console]::Write($locale)
    }
} catch {
    # Missing, malformed or unreadable settings use the existing installer receipt.
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
