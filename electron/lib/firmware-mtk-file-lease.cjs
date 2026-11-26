const { spawn } = require('node:child_process');
const path = require('node:path').win32;

const maxFiles = 520;
const ready = 'VEYLO_MTK_LEASE_READY';
const unavailable = 'firmware-staging-unavailable';
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$leases = [Collections.Generic.List[IO.FileStream]]::new()
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $files = @((Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $line).files)
    if (!$files.Count -or ($leases.Count + $files.Count) -gt 520) { throw 'Invalid lease request' }
    foreach ($file in $files) {
      $leases.Add([IO.File]::Open([string]$file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
    }
    [Console]::WriteLine('VEYLO_MTK_LEASE_READY')
  }
} catch {
  exit 1
} finally {
  foreach ($lease in $leases) { $lease.Dispose() }
}
`;
const encoded = Buffer.from(script, 'utf16le').toString('base64');
const error = code => Object.assign(new Error(code), { code });

function leasePaths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxFiles) throw error(unavailable);
  const files = value.map(file => {
    if (typeof file !== 'string' || file.length > 1024 || !/^[a-z]:[\\/]/i.test(file) ||
        /[<>:"|?*\x00-\x1f\x7f]/.test(file.slice(2)) ||
        file.slice(3).split(/[\\/]/).some(part => !part || /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw error(unavailable);
    return path.normalize(file);
  });
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) throw error(unavailable);
  return files;
}

async function openMtkFileLease(paths, { signal } = {}) {
  if (signal?.aborted) throw error('cancelled');
  const initial = leasePaths(paths);
  if (process.platform !== 'win32') throw error(unavailable);
  let child;
  try {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const system = path.join(root, 'System32');
    const powershell = path.join(system, 'WindowsPowerShell/v1.0');
    child = spawn(path.join(powershell, 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        cwd: system, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        env: { SystemRoot: root, windir: root, PATH: [system, root].join(';'), PSModulePath: path.join(powershell, 'Modules') },
      });
  } catch { throw error(unavailable); }

  let stopping = false, active = false, count = 0, pending, tail = '', killTimer;
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  function finishRequest(failure) {
    if (!pending) return;
    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    pending = undefined;
    if (failure) reject(error(failure));
    else resolve();
  }
  function stop(failure = unavailable) {
    if (stopping) return;
    stopping = true;
    active = false;
    finishRequest(failure);
    child.stdin.end();
    killTimer = setTimeout(() => child.kill(), 2000);
    killTimer.unref?.();
  }
  const abort = () => stop('cancelled');
  child.once('error', () => stop());
  child.stdin.on('error', () => stop());
  child.once('close', () => {
    stopping = true;
    active = false;
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    finishRequest(signal?.aborted ? 'cancelled' : unavailable);
    closed();
  });
  child.stdout.setEncoding('ascii').on('data', value => {
    if (stopping) return;
    tail += value;
    if (tail.length > 64) { stop(); return; }
    const end = tail.indexOf('\n');
    if (end === -1) return;
    if (!pending || end !== tail.length - 1 || tail.slice(0, end).replace(/\r$/, '') !== ready) { stop(); return; }
    tail = '';
    active = true;
    finishRequest();
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function request(files) {
    if (signal?.aborted) return Promise.reject(error('cancelled'));
    if (stopping || pending || count + files.length > maxFiles) return Promise.reject(error(unavailable));
    return new Promise((resolve, reject) => {
      count += files.length;
      const timer = setTimeout(() => stop(), 10000);
      timer.unref?.();
      pending = { resolve, reject, timer };
      child.stdin.write(JSON.stringify({ files }) + '\n', 'utf8');
    });
  }
  try { await request(initial); }
  catch (failure) {
    stop();
    await done;
    throw failure;
  }
  return {
    add: async files => {
      try { await request(leasePaths(files)); }
      catch (failure) {
        stop();
        await done;
        throw failure;
      }
    },
    isActive: () => active && !pending && !stopping && child.exitCode === null && child.signalCode === null,
    release: () => { stop(); return done; },
  };
}

module.exports = { openMtkFileLease };
