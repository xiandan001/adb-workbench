const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectRkTool } = require('./firmware-direct-rk.cjs');

const source = 'https://raw.githubusercontent.com/ArmSoM/rockchip-tools/9737320c3a906fc4bcf25edf222258e80fc00c5b/downloads/upgrade-tool/upgrade_tool_v2.46.zip';
const archiveBytes = 727727;
const archiveHash = 'de1dc7ce00ed5cfdaa0432f1c7e3efaf096e5dbb7e0ad851345739f6342c06dc';
const extractScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:VEYLO_RK_ARCHIVE)
try {
  foreach ($name in @('config.ini', 'upgrade_tool.exe')) {
    $entries = @($zip.Entries | Where-Object { $_.FullName -ceq "upgrade_tool_v2.46_for_window/$name" })
    if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt 2MB) { throw 'Invalid package entry' }
    $target = Join-Path $env:VEYLO_RK_EXTRACT $name
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $target)
  }
} finally { $zip.Dispose() }
`;

async function downloadArchive(fetchArchive, signal) {
  const response = await fetchArchive(source, { redirect: 'error', credentials: 'omit', signal });
  if (!response.ok || !response.body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const part of response.body) {
    bytes += part.byteLength;
    if (bytes > archiveBytes) return null;
    chunks.push(part);
  }
  if (bytes !== archiveBytes) return null;
  const archive = Buffer.concat(chunks, bytes);
  return createHash('sha256').update(archive).digest('hex') === archiveHash ? archive : null;
}

function extractArchive(archive, destination, signal) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(extractScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 12000, maxBuffer: 16384, signal,
      env: { ...process.env, VEYLO_RK_ARCHIVE: archive, VEYLO_RK_EXTRACT: destination },
    }, error => error ? reject(error) : resolve());
  });
}

async function installRkDirectTool(destination, { signal, fetchArchive = (...args) => require('electron').net.fetch(...args),
  extract = extractArchive } = {}) {
  if (process.platform !== 'win32' || signal?.aborted || !path.isAbsolute(destination)) return false;
  if ((await inspectRkTool(destination)).ok) return true;
  const bounded = AbortSignal.timeout(35000);
  const operation = signal ? AbortSignal.any([signal, bounded]) : bounded;
  let scratch;
  try {
    const archive = await downloadArchive(fetchArchive, operation);
    if (!archive || operation.aborted) return false;
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    scratch = await fs.mkdtemp(path.join(parent, 'rk-setup-'));
    const zipFile = path.join(scratch, 'source.zip');
    const payload = path.join(scratch, 'tool');
    await fs.mkdir(payload);
    await fs.writeFile(zipFile, archive, { flag: 'wx' });
    await extract(zipFile, payload, operation);
    if (!(await inspectRkTool(payload)).ok || operation.aborted) return false;
    // Another app can reuse a verified cache, but setup never overwrites its files.
    try { await fs.rename(payload, destination); }
    catch (error) { if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error; }
    return (await inspectRkTool(destination)).ok;
  } catch { return false; }
  finally { if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

module.exports = { installRkDirectTool };
