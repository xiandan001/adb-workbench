const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { StringDecoder } = require('node:string_decoder');
const { MTK_VERSION, buildMtkFlashArgs, parseMtkTraceLine } = require('./firmware-direct-mtk.cjs');

const dumpName = /^SP_FT_V6_Dump_\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}$/;
const traceFile = 'QT_FLASH_TOOL_V6.log';
const maxTraceBytes = 2 * 1024 * 1024;
const winPath = path.win32;
const failure = code => ({ transferCompleted: false, code });
const notify = (callback, ...args) => { try { callback?.(...args); } catch { /* UI cannot stop the flasher. */ } };

function isApprovedInvocation(tool, args, target) {
  const local = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) &&
    value.length <= 1024 && !/[\x00-\x1f\x7f"<>|?*]/.test(value) && !value.slice(2).includes(':');
  if (tool?.version !== MTK_VERSION || !/^[a-f0-9]{64}$/.test(tool.sha256) ||
      !local(tool.executable) || !local(tool.cwd) || winPath.basename(tool.executable) !== 'SPFlashToolV6.exe' ||
      winPath.dirname(winPath.normalize(tool.executable)).toLowerCase() !== winPath.normalize(tool.cwd).toLowerCase() ||
      target?.stage !== 'preloader' || !Array.isArray(args) ||
      (target.instanceId !== undefined && (typeof target.instanceId !== 'string' ||
        !/^USB\\VID_0E8D&PID_2000(?:&MI_[a-f0-9]{2})?\\[a-z0-9._&-]{1,160}$/i.test(target.instanceId)))) return false;
  try {
    const expected = buildMtkFlashArgs({
      executableVersion: tool.version, target, mode: 'download-only', battery: args[7],
      firmware: { verified: true, manifestPath: args[3] }, reboot: args[9] === '-b',
    });
    return expected.length === args.length && expected.every((token, index) => token === args[index]);
  } catch { return false; }
}

function elevatedCommand(tool, args) {
  // argv is already a fixed allowlist, with double quotes and controls rejected.
  const argumentLine = args.map(item => '"' + item + '"').join(' ');
  const encoded = Buffer.from(JSON.stringify({ executable: tool.executable, cwd: tool.cwd, argumentLine }), 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = "Stop"',
    '$vendor = $null',
    'try {',
    '  $bytes = [Convert]::FromBase64String("' + encoded + '")',
    '  $cfg = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json',
    '  $vendor = Start-Process -FilePath $cfg.executable -ArgumentList $cfg.argumentLine -WorkingDirectory $cfg.cwd -WindowStyle Hidden -Verb RunAs -PassThru',
    '  [Console]::WriteLine("VEYLO_MTK_PID:" + $vendor.Id)',
    '  $vendor.WaitForExit()',
    '  [Console]::WriteLine("VEYLO_MTK_EXIT:" + $vendor.ExitCode)',
    '} catch {',
    '  if ($vendor) {',
    '    while (Get-Process -Id $vendor.Id -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }',
    '  } else {',
    '    for ($ex = $_.Exception; $ex; $ex = $ex.InnerException) {',
    '      if ($ex.NativeErrorCode -eq 1223 -or $ex.HResult -eq -2147023673) {',
    '        [Console]::WriteLine("VEYLO_MTK_UAC_CANCELLED"); return',
    '      }',
    '    }',
    '  }',
    '  [Console]::WriteLine("VEYLO_MTK_LAUNCH_ERROR")',
    '}',
  ].join('\r\n');
}

function launchWindows(tool, args, onPid, spawnProcess = spawn) {
  return new Promise(resolve => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const shell = winPath.join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const encoded = Buffer.from(elevatedCommand(tool, args), 'utf16le').toString('base64');
    const env = { SystemRoot: systemRoot, windir: systemRoot, PATH: [winPath.join(systemRoot, 'System32'), systemRoot].join(';') };
    for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawnProcess(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: winPath.join(systemRoot, 'System32'), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    let pid = null, exitCode = null, cancelled = false, startFailed = false, tail = '';
    function record(line) {
      const seenPid = /^VEYLO_MTK_PID:(\d{1,10})$/.exec(line);
      const seenExit = /^VEYLO_MTK_EXIT:(-?\d{1,10})$/.exec(line);
      if (seenPid && !pid) { pid = Number(seenPid[1]); onPid(pid); }
      if (seenExit && pid) exitCode = Number(seenExit[1]);
      if (line === 'VEYLO_MTK_UAC_CANCELLED') cancelled = true;
      if (line === 'VEYLO_MTK_LAUNCH_ERROR') startFailed = true;
    }
    child.stdout.on('data', block => {
      const lines = (tail + block.toString('ascii')).split(/\r?\n/);
      tail = (lines.pop() || '').slice(-128);
      for (const line of lines) record(line);
    });
    child.once('error', () => { if (!pid) resolve({ startFailed: true }); });
    child.once('close', async () => {
      record(tail);
      // If the helper was unexpectedly interrupted, the elevated child can still own USB.
      if (pid && exitCode === null) {
        for (;;) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') break; }
          await delay(500);
        }
      }
      resolve({ startFailed: startFailed || !pid, cancelled, exitCode });
    });
  });
}

async function traceDirectories(io, root) {
  try {
    const entries = await io.readdir(root, { withFileTypes: true });
    return entries.filter(item => item.isDirectory() && dumpName.test(item.name)).map(item => item.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function createTraceTail(io, root, previous) {
  const traceError = code => new Error(code);
  const seen = new Map();
  let selected;
  async function readTrace(name) {
    const file = path.join(root, name, traceFile);
    const stat = await io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const state = seen.get(name) || { offset: 0, carry: '', decoder: new StringDecoder('utf8') };
    seen.set(name, state);
    if (stat.size > maxTraceBytes || state.offset > stat.size) throw traceError('invalid-trace-size');
    if (state.offset === stat.size) return [];
    const handle = await io.open(file, 'r');
    try {
      const block = Buffer.alloc(Math.min(128 * 1024, stat.size - state.offset));
      const { bytesRead } = await handle.read(block, 0, block.length, state.offset);
      state.offset += bytesRead;
      const lines = (state.carry + state.decoder.write(block.subarray(0, bytesRead))).split(/\r?\n/);
      state.carry = lines.pop() || '';
      if (state.carry.length > 8192) throw traceError('invalid-trace-line');
      return lines;
    } finally { await handle.close(); }
  }
  return async pid => {
    const names = selected ? [selected] : (await traceDirectories(io, root)).filter(name => !previous.has(name));
    if (names.length > 16) throw traceError('ambiguous-traces');
    const events = [];
    for (const name of names) {
      try {
        const current = (await readTrace(name)).map(line => parseMtkTraceLine(line, pid)).filter(Boolean);
        if (current.length && selected && selected !== name) throw traceError('ambiguous-traces');
        if (current.length) { selected = name; events.push(...current); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return events;
  };
}

function watchEvidence(port, instanceId, { onReady, onProgress } = {}) {
  let scan, ready = false, actual = false, written = false, completed = false, reason;
  let lastUpdate = 0, lastPart = 0;
  function consume(events, running) {
    for (const event of events) {
      switch (event.phase) {
        case 'scan': scan = event.timeoutMs > 0 && event.timeoutMs <= 300000 ? event.timeoutMs : undefined; break;
        case 'clue':
          if (event.port !== port) reason = 'mtk-target-mismatch';
          else if (scan && !ready && !reason) {
            ready = true;
            if (running) notify(onReady, { port, timeoutMs: scan });
          }
          break;
        case 'tool-target':
          if (event.port !== port) reason = 'mtk-target-mismatch';
          else if (instanceId && event.instanceId !== instanceId.toUpperCase()) reason = 'mtk-write-unverified';
          else if (ready) actual = true;
          break;
        case 'mode-mismatch': reason = 'mtk-mode-mismatch'; break;
        case 'tool-error': reason ||= 'mtk-write-failed'; break;
        case 'writing':
          if (actual && !reason && (event.part !== lastPart || Date.now() - lastUpdate >= 250)) {
            lastPart = event.part;
            lastUpdate = Date.now();
            notify(onProgress, event.total === 1 ? Math.min(event.percentage, 99) : null,
              { part: event.part, total: event.total, partPercent: event.percentage });
          }
          break;
        case 'partitions-written': written = actual && !reason; break;
        case 'tool-completed': completed = written; break;
      }
    }
  }
  return { consume, result: () => ({ confirmed: ready && actual && written && completed, reason }) };
}

async function writeElevatedMtk({ tool, args, target } = {}, callbacks = {}, {
  io = fs, launch,
  spawnProcess,
  logRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', 'SP_FT_V6_Logs'),
  pollMs = 250,
} = {}) {
  if (!isApprovedInvocation(tool, args, target)) return failure('mtk-tool-start-failed');
  let previous;
  try { previous = new Set(await traceDirectories(io, logRoot)); }
  catch { return failure('mtk-write-unverified'); }
  const tail = createTraceTail(io, logRoot, previous);
  const evidence = watchEvidence(args[5], target.instanceId, callbacks);
  const stopPolling = new AbortController();
  let pid, end, damagedTrace = false;
  const vendor = launch || ((exe, argv, register) => launchWindows(exe, argv, register, spawnProcess));
  const outcome = Promise.resolve().then(() => vendor(tool, args, value => {
    if (Number.isInteger(value) && value > 0 && pid === undefined) pid = value;
  })).catch(() => ({ startFailed: true })).then(result => {
    end = result || { startFailed: true };
    stopPolling.abort();
  });
  async function readEvents() {
    if (!pid || damagedTrace) return;
    try { evidence.consume(await tail(pid), !end); }
    catch { damagedTrace = true; }
  }
  while (!end) {
    await readEvents();
    if (!end) await delay(pollMs, undefined, { signal: stopPolling.signal }).catch(() => {});
  }
  await outcome;
  // Flush bounded final sequence after the child's log/file handles have closed.
  for (let count = 0; count < maxTraceBytes / (128 * 1024); count++) await readEvents();
  if (end.cancelled) return failure('mtk-uac-cancelled');
  const verdict = evidence.result();
  if (verdict.reason) return failure(verdict.reason);
  if (end.startFailed && !pid) return failure('mtk-tool-start-failed');
  if (Number.isInteger(end.exitCode) && end.exitCode !== 0) return failure('mtk-write-failed');
  if (end.exitCode !== 0 || damagedTrace || !verdict.confirmed) return failure('mtk-write-unverified');
  return { transferCompleted: true, code: 'mtk-tool-reported-success' };
}

module.exports = { writeElevatedMtk };
