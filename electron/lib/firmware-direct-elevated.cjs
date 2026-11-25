const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { StringDecoder } = require('node:string_decoder');
const { MTK_VERSION, buildMtkFlashArgs, mtkProgress, parseMtkTraceLine } = require('./firmware-direct-mtk.cjs');

const dumpName = /^SP_FT_V6_Dump_\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}$/;
const traceFile = 'QT_FLASH_TOOL_V6.log';
const maxTraceBytes = 2 * 1024 * 1024;
const winPath = path.win32;
const writeCommand = Object.freeze({
  'download-only': 'WRITE-PARTITIONS',
  'firmware-upgrade': 'FLASH-UPDATE',
  'format-all-download': 'FLASH-ALL',
});
const formatMode = 'format-all-download';
const progressStageOrder = Object.freeze({ connecting: 1, formatting: 2, writing: 3, finalizing: 4 });
const failure = code => ({ transferCompleted: false, code });
const notify = (callback, ...args) => { try { callback?.(...args); } catch { /* UI cannot stop the flasher. */ } };

function isApprovedInvocation(tool, args, target, mode, permitFormatAll) {
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
      executableVersion: tool.version, target, mode, permitFormatAll, battery: args[7],
      firmware: { verified: true, manifestPath: args[3] }, reboot: args[9] === '-b',
    });
    return expected.length === args.length && expected.every((token, index) => token === args[index]);
  } catch { return false; }
}

// Only accept a full-format XML block that directly follows this PID's erase command.
// Do not retain or forward payload filenames or other vendor log content.
function traceEvent(line, pid, tail) {
  const event = parseMtkTraceLine(line, pid);
  if (event?.command === 'ERASE-FLASH' && event.outcome === 'request') {
    tail.erase = { remaining: 14, fields: new Map() };
    return event;
  }
  if (!tail.erase) return event;
  if (event || / SPFlashToolV6\[/.test(line) || tail.erase.remaining-- <= 0) {
    tail.erase = undefined;
    return event;
  }
  const xml = line.trim();
  const member = /^<(command|partition|offset|length)>([a-z0-9_-]{1,48})<\/\1>$/i.exec(xml);
  if (member) {
    const fields = tail.erase.fields;
    fields.set(member[1], fields.has(member[1]) ? null : member[2]);
  } else if (xml === '<command>CMD:ERASE-FLASH</command>') {
    tail.erase.fields.set('erase-command', true);
  } else if (xml === '</da>') {
    const fields = tail.erase.fields;
    tail.erase = undefined;
    return {
      phase: 'erase-scope',
      full: fields.get('erase-command') === true && fields.get('partition') === 'ALL' &&
        fields.get('offset') === '0x0' && fields.get('length') === 'MAX',
    };
  }
  return null;
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
        const lines = await readTrace(name);
        const state = seen.get(name);
        const current = lines.map(line => traceEvent(line, pid, state)).filter(Boolean);
        if (current.length && selected && selected !== name) throw traceError('ambiguous-traces');
        if (current.length) { selected = name; events.push(...current); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return events;
  };
}

function watchEvidence(port, instanceId, mode, expectedMode, { onReady, onProgress } = {}) {
  let scan, modeConfirmed = false, ready = false, actual = false, written = false, completed = false, reason;
  let fullErase = false, formatted = false;
  let lastUpdate = 0, lastProgress;
  function publishProgress(percent, details) {
    if (!actual || reason || (lastProgress && progressStageOrder[details.stage] < progressStageOrder[lastProgress.stage])) return;
    const timestamp = Date.now();
    const current = details.partPercent ?? details.stagePercent ?? percent;
    if (lastProgress?.stage === details.stage && lastProgress.part === details.part) {
      const previous = lastProgress.partPercent ?? lastProgress.stagePercent ?? lastProgress.percent;
      if (current === null || previous !== null && (current <= previous || current < 100 && timestamp - lastUpdate < 250)) return;
    }
    lastProgress = { ...details, percent };
    lastUpdate = timestamp;
    notify(onProgress, percent, details);
  }
  function deviceCommand(event) {
    if (completed || (written && event.command === 'ERASE-FLASH')) {
      reason = 'mtk-mode-mismatch';
      return;
    }
    if (event.command === 'ERASE-FLASH') {
      if (mode !== formatMode) reason = 'mtk-mode-mismatch';
      else if (event.outcome === 'request') {
        fullErase = false;
        formatted = false;
        publishProgress(null, { stage: 'formatting' });
      } else if (event.outcome === 'failure') reason ||= 'mtk-write-failed';
      else formatted = actual && fullErase && !reason;
      return;
    }
    if (event.command !== writeCommand[mode]) reason = 'mtk-mode-mismatch';
    else if (event.outcome === 'failure') reason ||= 'mtk-write-failed';
    else if (event.outcome === 'request') {
      written = false;
      publishProgress(null, { stage: 'writing' });
    } else if (event.outcome === 'success') {
      written = actual && !reason && (mode !== formatMode || formatted);
      if (written) publishProgress(null, { stage: 'finalizing' });
    }
  }

  function consume(events, running) {
    for (const event of events) {
      switch (event.phase) {
        case 'input-mode':
          if (event.command !== expectedMode) reason = 'mtk-mode-mismatch';
          else modeConfirmed = true;
          break;
        case 'scan': scan = modeConfirmed && event.timeoutMs > 0 && event.timeoutMs <= 300000 ? event.timeoutMs : undefined; break;
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
          else if (ready && !actual && !reason) {
            actual = true;
            // Once the target appears, stop asking for another power cycle even before write progress.
            publishProgress(null, { stage: 'connecting' });
          }
          break;
        case 'erase-scope': fullErase = event.full; break;
        case 'device-command': deviceCommand(event); break;
        case 'tool-error': reason ||= 'mtk-write-failed'; break;
        case 'formatting':
          if (mode !== formatMode) reason = 'mtk-mode-mismatch';
          else publishProgress(...mtkProgress(event));
          break;
        case 'writing':
          publishProgress(...mtkProgress(event));
          break;
        case 'tool-completed': completed = written; break;
      }
    }
  }
  return { consume, result: () => ({ confirmed: modeConfirmed && ready && actual && written && completed, reason }) };
}

async function writeElevatedMtk({ tool, args, target, mode = 'download-only', permitFormatAll } = {}, callbacks = {}, {
  io = fs, launch,
  spawnProcess,
  logRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', 'SP_FT_V6_Logs'),
  pollMs = 250,
} = {}) {
  if (!isApprovedInvocation(tool, args, target, mode, permitFormatAll)) return failure('mtk-tool-start-failed');
  let previous;
  try { previous = new Set(await traceDirectories(io, logRoot)); }
  catch { return failure('mtk-write-unverified'); }
  const tail = createTraceTail(io, logRoot, previous);
  const evidence = watchEvidence(args[5], target.instanceId, mode, args[1], callbacks);
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
