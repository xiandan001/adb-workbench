const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const encode = script => Buffer.from(script, 'utf16le').toString('base64');
function buildLaunchScript({ executable, args }) { return `$ErrorActionPreference = 'Stop'\n& ${[executable, ...args].map(quote).join(' ')}\n`; }

function buildTerminalScript({ executable, args, cwd, pipeName, nonce, title }) {
  return `$ErrorActionPreference = 'Stop'
$awbAllowed = $false
$awbPipe = $null
$awbWriter = $null
$awbExitCode = 173
$awbParent = 0
try {
  $awbPipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', ${quote(pipeName)}, [System.IO.Pipes.PipeDirection]::InOut)
  $awbPipe.Connect(5000)
  $awbWriter = [System.IO.StreamWriter]::new($awbPipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
  $awbWriter.AutoFlush = $true
  $awbReader = [System.IO.StreamReader]::new($awbPipe, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
  $awbParent = (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID)).ParentProcessId
  Set-Location -LiteralPath ${quote(cwd)}
  if (-not (Test-Path -LiteralPath ${quote(executable)} -PathType Leaf)) { throw 'CLI path unavailable' }
  $awbInput = -not [Console]::IsInputRedirected
  $awbOutput = -not [Console]::IsOutputRedirected
  if (-not $awbInput -or -not $awbOutput) { throw 'Interactive console unavailable' }
  [Console]::BackgroundColor = [ConsoleColor]::Black
  [Console]::ForegroundColor = [ConsoleColor]::Gray
  [Console]::Clear()
  $Host.UI.RawUI.WindowTitle = ${quote(title)}
  $awbWriter.WriteLine((@{ nonce = ${quote(nonce)}; state = 'ready'; pid = $PID; parentPid = $awbParent; inputTTY = $awbInput; outputTTY = $awbOutput } | ConvertTo-Json -Compress))
  if ($awbReader.ReadLine() -cne 'launch') { throw 'Launch was cancelled' }
  $awbAllowed = $true
  $awbReader.Dispose()
  $awbWriter.Dispose()
  $awbWriter = $null
  $awbPipe.Dispose()
  $awbPipe = $null
  $global:LASTEXITCODE = 0
  ${buildLaunchScript({ executable, args })}
  $awbExitCode = 0
  if ($LASTEXITCODE -ne 0) { $awbExitCode = 1; Write-Host ('CLI 退出码：{0}。请查看上方 CLI 输出。' -f $LASTEXITCODE) -ForegroundColor Red }
} catch {
  if (-not $awbAllowed -and $null -ne $awbWriter) {
    try { $awbWriter.WriteLine((@{ nonce = ${quote(nonce)}; state = 'failed'; pid = $PID; parentPid = $awbParent } | ConvertTo-Json -Compress)) } catch {}
  }
  if ($awbAllowed) { $awbExitCode = 1 }
  Write-Host 'CLI 未能启动或已中止，请检查安装、项目目录与上方输出。不会自动重试。' -ForegroundColor Red
} finally {
  if ($null -ne $awbWriter) { $awbWriter.Dispose() }
  if ($null -ne $awbPipe) { $awbPipe.Dispose() }
}
exit $awbExitCode
`;
}

function buildBootstrapScript({ host, terminal, terminalScript, cwd, keepOpen = true }) {
  const args = `/D /${keepOpen ? 'K' : 'C'} ""${terminal}" -NoLogo -NoProfile -EncodedCommand ${encode(terminalScript)} & if errorlevel 173 exit"`;
  return `$ErrorActionPreference = 'Stop'
try {
  $awbTerminal = Start-Process -FilePath ${quote(host)} -ArgumentList ${quote(args)} -WorkingDirectory ${quote(cwd)} -WindowStyle Normal -PassThru
  @{ pid = $awbTerminal.Id } | ConvertTo-Json -Compress
} catch {
  Write-Output '{"error":true}'
  exit 1
}
`;
}

module.exports = { buildLaunchScript, buildTerminalScript, buildBootstrapScript, encode };
