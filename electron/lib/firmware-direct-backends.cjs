const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { setTimeout: delay } = require('node:timers/promises');
const { inspectVendorFiles } = require('./firmware-tools.cjs');
const { mtk: mtkVendorFiles } = require('./firmware-tools-vendor.json');
const {
  RK3576_CHIP, inspectRkTool, rkListArgs, parseRkDeviceList, buildRkFlashArgs, rkReadArgs, rkBootArgs,
  parseRkReadInfo, readRkFirmware, stageRkWriter, rkProgressFraming, parseRkProgressLine, classifyRkResult,
} = require('./firmware-direct-rk.cjs');
const { revalidateDirectFirmware } = require('./firmware-direct-receipt.cjs');
const { MTK_VERSION, buildMtkFlashArgs, mtkProgress, parseMtkFlashLine, updateMtkEvidence, finishMtkFlash } = require('./firmware-direct-mtk.cjs');

const mtkExecutable = 'SPFlashToolV6.exe';
const mtkFiles = Object.freeze({
  ...mtkVendorFiles,
  'console_mode.xsd': '1dab084afb39b6aeee5c2911f264e9195d1f219edb8ec0f93bc491b03404eb27',
  'usb_settings.xml': 'a36b2fb8897d33c9faf52b37261aea2d48696000833a4dc093e1af8827e0a57b',
});
const maxLineLength = 2048;
const maxListingBytes = 64 * 1024;
const maxWriteOutputBytes = 8 * 1024 * 1024;
const readTimeoutMs = 10_000;
const ramScanAttempts = 6;
const error = code => ({ ok: false, code });
const failure = code => ({ transferCompleted: false, code });

function localDirectory(value) {
  return typeof value === 'string' && value.length <= 1024 && path.isAbsolute(value) && !/^[\\/]{2}|[\x00-\x1f\x7f"<>|?*]/.test(value);
}

function samePath(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sameTool(first, second) {
  return first && second && first.version === second.version && first.sha256 === second.sha256 &&
    typeof first.executable === 'string' && typeof first.cwd === 'string' &&
    samePath(first.executable, second.executable) && samePath(first.cwd, second.cwd);
}

function toolEnvironment() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  // Qt plugin and DLL lookup must stay within the verified package and system paths.
  const env = { SystemRoot: systemRoot, windir: systemRoot, PATH: [path.join(systemRoot, 'System32'), systemRoot].join(';') };
  for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function createLineReader(onLine, budget, framing) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let emittedFrames = false;
  let skipLine = false;
  let exceeded = false;
  let remaining = budget;
  function finishLine() {
    if (tail && !skipLine) {
      if (!emittedFrames) onLine(tail);
      // Only progress frames can create virtual separators. Do not turn
      // adjacent text into a separate trusted target or completion marker.
      else if (!framing.isPadding(tail)) exceeded = true;
    }
    tail = '';
    emittedFrames = false;
    skipLine = false;
  }
  function add(text) {
    const parts = text.split(/[\r\n]/);
    const last = parts.length - 1;
    for (let index = 0; index <= last; index++) {
      const part = parts[index];
      if (!skipLine) {
        tail += part;
        if (framing) {
          let frame;
          while ((frame = framing.take(tail)) !== null) {
            onLine(frame.line);
            tail = tail.slice(frame.length);
            emittedFrames = true;
          }
        }
        if (tail.length > maxLineLength) {
          exceeded = true;
          skipLine = true;
          tail = '';
        }
      }
      if (index < last) finishLine();
    }
  }
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > remaining) {
        exceeded = true;
        remaining = 0;
        tail = '';
        skipLine = true;
        return;
      }
      remaining -= bytes.length;
      add(decoder.write(bytes));
    },
    finish() {
      add(decoder.end());
      finishLine();
      return exceeded;
    },
  };
}

function runVendor(spawnProcess, tool, args, { onLine, outputBytes, timeout, framing }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnProcess(tool.executable, args, {
        cwd: tool.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: toolEnvironment(),
      });
    } catch {
      resolve({ startFailed: true });
      return;
    }
    const stdout = createLineReader(onLine, outputBytes, framing);
    const stderr = createLineReader(onLine, outputBytes, framing);
    let started = false;
    let processError = false;
    let timedOut = false;
    let timer;
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.once('spawn', () => { started = true; });
    child.on('error', () => {
      processError = true;
      if (!started && !timedOut) {
        clearTimeout(timer);
        resolve({ startFailed: true });
      }
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutTruncated = stdout.finish();
      const stderrTruncated = stderr.finish();
      resolve({ exitCode, signal, processError, timedOut, truncated: stdoutTruncated || stderrTruncated });
    });
    // Only read-only RK commands have a timeout. A transfer is held until close.
    if (timeout) timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* The probe has no writes to interrupt. */ }
      resolve({ timedOut });
    }, timeout);
  });
}

function reportProgress(onProgress, percent, details) {
  try { onProgress?.(percent, details); } catch { /* A UI observer cannot interrupt a flash. */ }
}

async function inspectMtk(directory, io, verifyFiles) {
  try {
    const canonical = await io.realpath(directory);
    if (!localDirectory(canonical) || !samePath(path.resolve(directory), canonical) ||
      !(await io.stat(canonical)).isDirectory()) return error('mtk-tool-untrusted');
    const result = await verifyFiles(canonical, mtkExecutable, mtkFiles, io);
    if (!result.path) return error(result.code === 'missing-file' ? 'mtk-tool-unavailable' : 'mtk-tool-untrusted');
    return { ok: true, executable: result.path, cwd: canonical, version: MTK_VERSION, sha256: mtkFiles[mtkExecutable] };
  } catch (failure) {
    return error(['ENOENT', 'ENOTDIR'].includes(failure.code) ? 'mtk-tool-unavailable' : 'mtk-tool-untrusted');
  }
}

function toolDirectories(platform, root) {
  const platformRoot = path.join(root, platform.toUpperCase());
  const names = platform === 'rk' ? ['upgrade_tool', 'Windows_Upgrade_Tool', 'Windows_Upgrade_Tool_v2.46', 'upgrade_tool_v2.46_for_window']
    : ['SP_Flash_Tool_V6'];
  return [root, platformRoot, ...names.flatMap(name => [path.join(root, name), path.join(platformRoot, name)])];
}

function rkSnapshotMatches(anchor, candidate, exact = false) {
  return Boolean(anchor?.location && typeof candidate?.identity === 'string' && candidate.identity &&
    anchor.location === candidate.location && anchor.vid === candidate.vid && anchor.pid === candidate.pid &&
    (!anchor.serial || candidate.serial === anchor.serial) &&
    (!exact || (anchor.identity === candidate.identity && anchor.locationId === candidate.locationId && anchor.mode === candidate.mode)));
}

const usableResult = result => result.exitCode === 0 && !result.signal && !result.processError && !result.truncated;

async function readRkProbe(spawnProcess, tool, target, operation) {
  let output = '';
  let excessive = false;
  const args = rkReadArgs(target, operation);
  const result = await runVendor(spawnProcess, tool, args, {
    timeout: readTimeoutMs, outputBytes: maxListingBytes, onLine(line) {
      if (output.length + line.length + 1 > maxListingBytes) excessive = true;
      else if (!excessive) output += line + '\n';
    },
  });
  const info = parseRkReadInfo(operation, output, args[1]);
  if (info.code === 'rk-target-mismatch' || (info.chip && info.chip !== RK3576_CHIP)) return info;
  return usableResult(result) && !excessive ? info : error('rk-probe-unavailable');
}

async function verifyRkChipAndStorage(spawnProcess, tool, target, size) {
  const info = await readRkProbe(spawnProcess, tool, target, 'rci');
  if (!info.ok) return info;
  if (info.chip !== RK3576_CHIP) return error('rk-chip-mismatch');
  const storage = await readRkProbe(spawnProcess, tool, target, 'rfi');
  if (!storage.ok) return storage;
  return storage.capacityBytes >= size ? storage : error('rk-storage-mismatch');
}

async function bootRkRam(spawnProcess, tool, target, loader) {
  const args = rkBootArgs(target, loader);
  let done = false;
  let failed = false;
  const result = await runVendor(spawnProcess, tool, args, { outputBytes: maxListingBytes, onLine(line) {
    const event = parseRkProgressLine(line);
    if (/^Download boot ok\.$/i.test(line.trim())) done = true;
    if (/^Download boot fail/i.test(line.trim()) || event?.type === 'failure' ||
      (event?.type === 'target' && event.locationId !== args[1])) failed = true;
  } });
  return usableResult(result) && done && !failed;
}

async function writeRk(spawnProcess, tool, args, onProgress, guarded) {
  const evidence = { successMarker: false, failureMarker: false, sawTarget: false, mismatchedTarget: false, chip: false, downloaded: false };
  const location = args[1];
  let phase, lastPercent = -1;
  function publishStage(stage) {
    if (phase === stage || phase === 'finalizing' || phase === 'writing' && stage === 'connecting') return;
    phase = stage;
    reportProgress(onProgress, null, { stage });
  }
  const result = await runVendor(spawnProcess, tool, args, { framing: rkProgressFraming, outputBytes: maxWriteOutputBytes, onLine(line) {
    const event = parseRkProgressLine(line);
    if (event?.type === 'success') evidence.successMarker = true;
    if (event?.type === 'failure') evidence.failureMarker = true;
    if (event?.type === 'target') {
      if (event.locationId === location) evidence.sawTarget = true;
      else evidence.mismatchedTarget = true;
    }
    if (event?.type === 'stage' && event.stage === 'check-chip-success') evidence.chip = true;
    if (event?.type === 'stage' && event.stage === 'download-firmware-success' && evidence.chip) evidence.downloaded = true;
    if (!event || evidence.mismatchedTarget || evidence.failureMarker) return;
    if (event.type === 'stage' && (guarded || evidence.sawTarget)) {
      if (event.stage === 'download-firmware-start') publishStage('writing');
      else if (event.stage === 'download-firmware-success') publishStage('finalizing');
      else publishStage('connecting');
    }
    if (event.type === 'progress' && phase !== 'finalizing' && (evidence.sawTarget || (guarded && evidence.chip)) && event.percent > lastPercent) {
      lastPercent = event.percent;
      phase = 'writing';
      reportProgress(onProgress, event.percent, { stage: phase });
    }
  } });
  if (result.startFailed) return failure('rk-tool-start-failed');
  if (evidence.mismatchedTarget) return failure('rk-target-mismatch');
  const verdict = classifyRkResult({ ...evidence, exitCode: result.exitCode, signal: result.signal });
  if (!verdict.ok) return failure(verdict.code);
  if ((!evidence.sawTarget && !(guarded && evidence.downloaded)) || result.truncated || result.processError) return failure('rk-write-unconfirmed');
  return { transferCompleted: true, code: verdict.code };
}

async function writeMtk(spawnProcess, tool, args, onProgress) {
  let evidence;
  let mismatchedTarget = false;
  const ports = new Set(args[args.indexOf('-p') + 1].split('+'));
  const result = await runVendor(spawnProcess, tool, args, { outputBytes: maxWriteOutputBytes, onLine(line) {
    const event = parseMtkFlashLine(line);
    if (event?.phase === 'tool-target' && !ports.has(event.port)) mismatchedTarget = true;
    if (!mismatchedTarget && (event?.phase === 'writing' || event?.phase === 'formatting' && args[1] === 'format-download')) {
      reportProgress(onProgress, ...mtkProgress(event));
    }
    evidence = updateMtkEvidence(evidence, event);
  } });
  if (result.startFailed) return failure('mtk-tool-start-failed');
  if (mismatchedTarget) return failure('mtk-target-mismatch');
  const verdict = finishMtkFlash({ exitCode: result.exitCode, signal: result.signal, evidence });
  if (!verdict.ok) return failure('mtk-write-' + verdict.status);
  if (result.truncated || result.processError) return failure('mtk-write-unverified');
  return { transferCompleted: true, code: 'mtk-tool-reported-success' };
}

function createDirectFlashBackends({
  spawnProcess = spawn, io = fs, host = process.platform, arch = process.arch,
  verifyRk = inspectRkTool, verifyMtkFiles = inspectVendorFiles,
  stageRkTool = stageRkWriter,
  revalidateRkFirmware = revalidateDirectFirmware, waitForRk = () => delay(350),
  elevatedMtk = (...args) => require('./firmware-direct-elevated.cjs').writeElevatedMtk(...args),
} = {}) {
  const preparedRk = new WeakMap();
  const supported = platform => host === 'win32' && arch === 'x64' && ['rk', 'mtk'].includes(platform);
  const inspectExact = (platform, directory) => platform === 'rk' ? verifyRk(directory, io) : inspectMtk(directory, io, verifyMtkFiles);

  async function inspect(platform, root) {
    if (!supported(platform)) return error('flash-backend-unavailable');
    if (!localDirectory(root)) return error(platform + '-tool-unavailable');
    for (const directory of toolDirectories(platform, root)) {
      const { ok, ...value } = await inspectExact(platform, directory);
      if (ok) return { ok: true, tool: value };
      if (value.code !== platform + '-tool-unavailable') return error(value.code);
    }
    return error(platform + '-tool-unavailable');
  }

  async function readTool(platform, tool) {
    if (!supported(platform) || !localDirectory(tool?.cwd)) return null;
    const { ok, ...fresh } = await inspectExact(platform, tool.cwd);
    return ok && sameTool(tool, fresh) ? fresh : null;
  }

  async function listRk(tool) {
    const fresh = await readTool('rk', tool);
    if (!fresh) return error('rk-tool-untrusted');
    let listing = '';
    let excessive = false;
    const result = await runVendor(spawnProcess, fresh, rkListArgs(), {
      timeout: readTimeoutMs, outputBytes: maxListingBytes, onLine(line) {
        if (listing.length + line.length + 1 > maxListingBytes) excessive = true;
        else if (!excessive) listing += line + '\n';
      },
    });
    if (result.startFailed) return error('rk-tool-start-failed');
    if (result.timedOut) return error('rk-device-list-timeout');
    if (result.exitCode !== 0 || result.signal || result.processError || result.truncated || excessive) return error('rk-device-list-failed');
    return parseRkDeviceList(listing);
  }

  async function prepareRk({ tool, target, firmware, scanTarget, beforeRamBoot } = {}) {
    if (typeof scanTarget !== 'function' || typeof beforeRamBoot !== 'function' || !rkSnapshotMatches(target, target, true)) {
      return error('rk-target-invalid');
    }
    const freshTool = await readTool('rk', tool);
    if (!freshTool) return error('rk-tool-untrusted');
    const accept = (candidate, capacityBytes) => {
      const prepared = Object.freeze({ ...candidate, preWriteChipVerified: true });
      preparedRk.set(prepared, { tool: freshTool, path: firmware.path, sha256: firmware.sha256, capacityBytes });
      return { ok: true, target: prepared };
    };
    try {
      if (!await revalidateRkFirmware(firmware)) return error('rk-firmware-invalid');
      const { size } = await readRkFirmware(firmware, { io });
      const current = await scanTarget(target);
      if (!rkSnapshotMatches(target, current, true)) return error('flash-plan-changed');
      const evidence = await verifyRkChipAndStorage(spawnProcess, freshTool, current, size);
      if (evidence.ok) return rkSnapshotMatches(current, await scanTarget(current), true)
        ? accept(current, evidence.capacityBytes) : error('flash-plan-changed');
      if (current.mode !== 'maskrom' || evidence.code !== 'rk-probe-unavailable') return evidence;
      const { boot } = await readRkFirmware(firmware, { io, withBoot: true });
      // The parent flow owns the private staging directory and deletes all its files.
      const loader = path.join(path.dirname(firmware.path), 'veylo-rk-ram-loader.bin');
      await io.writeFile(loader, boot, { flag: 'wx', mode: 0o600 });
      try {
        const readyTool = await readTool('rk', tool);
        if (!readyTool) return error('rk-tool-untrusted');
        if (!await revalidateRkFirmware(firmware) || !rkSnapshotMatches(current, await scanTarget(current), true) ||
          await beforeRamBoot(current) !== true) return error('flash-plan-changed');
        if (!await bootRkRam(spawnProcess, readyTool, current, loader)) return error('rk-ram-loader-failed');
      } finally {
        await io.unlink(loader).catch(() => {});
      }
      for (let i = 0; i < ramScanAttempts; i++) {
        await waitForRk();
        const candidate = await scanTarget(current);
        if (!rkSnapshotMatches(current, candidate)) continue;
        const checked = await verifyRkChipAndStorage(spawnProcess, freshTool, candidate, size);
        if (checked.ok) return rkSnapshotMatches(candidate, await scanTarget(candidate), true)
          ? accept(candidate, checked.capacityBytes) : error('flash-plan-changed');
        if (checked.code !== 'rk-probe-unavailable') return checked;
      }
      return error('rk-probe-unavailable');
    } catch (cause) {
      return error(cause.code?.startsWith('rk-') ? cause.code : 'rk-preparation-failed');
    }
  }

  async function write({ platform, tool, target, firmware, options = {} } = {}, { onProgress, beforeDispatch, onReady } = {}) {
    if (!supported(platform)) return failure('flash-backend-unavailable');
    if (options.protectedFiles !== undefined && (platform !== 'mtk' || options.elevated !== true)) return failure('flash-plan-changed');
    const fresh = await readTool(platform, tool);
    if (!fresh) return failure(platform + '-tool-untrusted');
    let args;
    try {
      args = platform === 'rk' ? buildRkFlashArgs({ target, imagePath: firmware?.path, reboot: options.reboot })
        : buildMtkFlashArgs({
          executableVersion: fresh.version, target, firmware: { verified: true, manifestPath: firmware?.path },
          mode: options.mode, battery: options.battery, reboot: options.reboot, permitFormatAll: options.permitFormatAll,
          permitAutoPort: options.elevated === true,
          authenticationFile: firmware?.authenticationFile, certificateFile: firmware?.certificateFile,
        });
    } catch (error) { return failure(error.code || 'flash-arguments-invalid'); }
    const prepared = platform === 'rk' && preparedRk.get(target);
    if (prepared) preparedRk.delete(target);
    const guarded = Boolean(prepared && sameTool(fresh, prepared.tool) && prepared.path === firmware.path &&
      prepared.sha256 === firmware.sha256 && await revalidateRkFirmware(firmware) && typeof beforeDispatch === 'function');
    if (platform === 'rk' && (prepared || target?.preWriteChipVerified === true) && !guarded) return failure('flash-plan-changed');
    if (platform === 'rk') {
      let writer;
      try { writer = await stageRkTool(fresh, { io }); }
      catch { return failure('flash-tool-unavailable'); }
      try {
        if (!await writer.validate()) return failure('flash-tool-unavailable');
        const confirmed = typeof beforeDispatch === 'function' && await beforeDispatch() === true;
        if (beforeDispatch && !confirmed) return failure('flash-plan-changed');
        return await writeRk(spawnProcess, writer.tool, args, onProgress, guarded && confirmed);
      } finally { await writer.release().catch(() => {}); }
    }
    const beforeConfirmed = typeof beforeDispatch === 'function' && await beforeDispatch() === true;
    if (beforeDispatch && !beforeConfirmed) return failure('flash-plan-changed');
    if (platform === 'mtk' && options.elevated === true) {
      if (!beforeConfirmed) return failure('flash-plan-changed');
      return elevatedMtk({ tool: fresh, args, target, mode: options.mode, permitFormatAll: options.permitFormatAll === true,
        protectedFiles: options.protectedFiles },
        { onReady, onProgress });
    }
    return writeMtk(spawnProcess, fresh, args, onProgress);
  }

  return { inspect, listRk, prepareRk, write };
}

module.exports = { createDirectFlashBackends };
