const fs = require('node:fs/promises');
const path = require('node:path');

// ArmSoM's archive of Rockchip Windows upgrade_tool 2.46.
const files = Object.freeze({
  'upgrade_tool.exe': '789c509dde39206d27b2f8915a5a169ff5eafb5b21fdb2108d0709bdda9ebde0',
  'config.ini': 'de40a55a95df909810245a0bc0e2d1919758205c5c6fe7a5788194aaff715472',
});
const executableName = 'upgrade_tool.exe';
const RK3576_CHIP = '0x33353736';
const maxBootBytes = 32 * 1024 * 1024;
const headerBytes = 102;
const badPath = /[\x00-\x1f\x7f"*?<>|]/;
const locationPattern = /^[0-9a-f]{1,8}$/i;
const noDevices = /^(?:List of rockusb connected\(\s*0\s*\)|No found any rockusb device,please plug device in!|not found any devices!?|no rockusb devices? found!?)$/i;
const listingHeader = /^List of rockusb connected\(\s*(\d{1,3})\s*\)$/i;
const listingRow = /^DevNo=(\d{1,3})\s+Vid=0x(2207)\s*,\s*Pid=0x([0-9a-f]{1,4})\s*,\s*LocationID=([0-9a-f]{1,8})\s+(?:Mode=)?(Loader|Maskrom)(?:\s+SerialNo=([^\x00-\x1f\x7f]{0,128}))?$/i;
const statusMarker = /^Upgrade firmware ok\.?$/i;
const targetMarker = /^Current Device Location ID:([0-9a-f]{1,8})$/i;
const failureMarker = /^(?:Error\s*:|No found (?:specific|any) rockusb device\b|Creating device object failed!|(?:Download Boot|Wait For Maskrom|Test Device|Check Chip|Get FlashInfo|Prepare IDB|Download IDB|Download Firmware|Upgrade firmware) Fail(?:ed)?[.!]?$|operation canceled[.!]?$)/i;
const progressMarker = /^Download Image\.\.\.\s*\((\d{1,3})%\)$/i;
const stageMarker = /^(Download Boot|Wait For Maskrom|Test Device|Check Chip|Get FlashInfo|Prepare IDB|Download IDB|Download Firmware) (Start|Success)$/i;

const fail = code => ({ ok: false, code });
const invalid = code => Object.assign(new Error(code), { code });
const stripAnsi = line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
const normalizeLocation = value => value.toLowerCase().replace(/^0+(?=[0-9a-f])/, '');

function localPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || badPath.test(value) || /^[\\/]{2}/.test(value)) return false;
  if (process.platform === 'win32') return /^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(':');
  return path.isAbsolute(value);
}

async function inspectRkTool(directory, io = fs) {
  if (!localPath(directory)) return fail('rk-tool-unavailable');
  try {
    const canonical = await io.realpath(directory);
    if (!localPath(canonical) || !(await io.stat(canonical)).isDirectory()) return fail('rk-tool-unavailable');
    // Fully validate the adjacent files that the native tool can load from this folder.
    const { inspectVendorFiles } = require('./firmware-tools.cjs');
    const result = await inspectVendorFiles(canonical, executableName, files, io);
    if (!result.path) return fail(result.code === 'missing-file' ? 'rk-tool-unavailable' : 'rk-tool-untrusted');
    return { ok: true, executable: result.path, cwd: canonical, version: '2.46', sha256: files[executableName] };
  } catch (error) {
    return fail(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'rk-tool-unavailable' : 'rk-tool-untrusted');
  }
}

function rkListArgs() { return ['ld']; }

function parseRkDeviceList(output) {
  if (typeof output !== 'string' || output.length === 0 || output.length > 64 * 1024) return fail('rk-unrecognized-device-list');
  const lines = output.split(/[\r\n]+/).map(stripAnsi).filter(Boolean);
  const headers = lines.filter(line => listingHeader.test(line));
  if (headers.length === 0 && lines.some(line => noDevices.test(line)) && !lines.some(line => /DevNo|LocationID/i.test(line))) {
    return { ok: true, devices: [] };
  }
  if (headers.length !== 1) return fail('rk-unrecognized-device-list');
  const count = Number(listingHeader.exec(headers[0])[1]);
  const candidates = lines.filter(line => /DevNo=|LocationID=/i.test(line));
  if (count > 32 || candidates.length !== count ||
    (count > 0 && lines.some(line => noDevices.test(line)))) return fail('rk-unrecognized-device-list');
  const locations = new Set();
  const devices = [];
  for (const candidate of candidates) {
    const match = listingRow.exec(candidate);
    if (!match) return fail('rk-unrecognized-device-list');
    const [, , vid, pid, rawLocation, mode, serial] = match;
    const locationId = normalizeLocation(rawLocation);
    if (locations.has(locationId)) return fail('rk-ambiguous-device-list');
    locations.add(locationId);
    devices.push({ locationId, vid, pid: pid.toLowerCase().padStart(4, '0'), mode: mode.toLowerCase(), serial: serial?.trim() || '' });
  }
  return { ok: true, devices };
}

function rkTargetSelector(target) {
  if (!target || typeof target.locationId !== 'string' || !locationPattern.test(target.locationId)
    || target.vid !== '2207' || typeof target.pid !== 'string' || !/^[0-9a-f]{4}$/i.test(target.pid)
    || !['loader', 'maskrom'].includes(target.mode)) {
    throw invalid('rk-target-invalid');
  }
  return ['-s', normalizeLocation(target.locationId)];
}

function buildRkFlashArgs({ target, imagePath, reboot = true } = {}) {
  const selector = rkTargetSelector(target);
  if (!localPath(imagePath) || path.extname(imagePath).toLowerCase() !== '.img' || typeof reboot !== 'boolean') {
    throw invalid('rk-firmware-invalid');
  }
  // LocationID is passed exactly as an argv item. There is no auto-target fallback.
  return [...selector, 'uf', imagePath, ...(!reboot ? ['-noreset'] : [])];
}

function rkReadArgs(target, operation) {
  if (!['rci', 'rfi'].includes(operation)) throw invalid('rk-probe-invalid');
  return [...rkTargetSelector(target), operation];
}

function rkBootArgs(target, file) {
  if (target?.mode !== 'maskrom' || !localPath(file) || path.extname(file).toLowerCase() !== '.bin') {
    throw invalid('rk-ram-loader-invalid');
  }
  return [...rkTargetSelector(target), 'db', file];
}

function parseRkReadInfo(operation, output, targetLocation) {
  const unavailable = fail('rk-probe-unavailable');
  if (typeof output !== 'string' || output.length > 64 * 1024 || typeof targetLocation !== 'string' ||
    !locationPattern.test(targetLocation) || !['rci', 'rfi'].includes(operation)) return unavailable;
  const lines = output.split(/[\r\n]+/).map(stripAnsi).filter(Boolean);
  const events = lines.map(parseRkProgressLine);
  if (events.some(event => event?.type === 'target' && event.locationId !== normalizeLocation(targetLocation))) {
    return fail('rk-target-mismatch');
  }
  if (events.some(event => event?.type === 'failure') || lines.some(line => /^Read (?:Chip|Flash) Info (?:Fail|quit)/i.test(line))) return unavailable;
  if (operation === 'rci') {
    const rows = lines.filter(line => /^Chip Info:/i.test(line));
    const bytes = /^Chip Info:\s*((?:[\da-f]{2}[ \t]+){15}[\da-f]{2})$/i.exec(rows[0])?.[1];
    if (rows.length !== 1 || !bytes) return unavailable;
    return { ok: true, chip: '0x' + Buffer.from(bytes.replace(/\s/g, ''), 'hex').readUInt32LE().toString(16).padStart(8, '0') };
  }
  const rows = lines.filter(line => /^Flash Size:/i.test(line));
  const size = /^Flash Size:\s*([1-9]\d{0,7})\s*MB,\s*value=0x([\da-f]{1,8})$/i.exec(rows[0]);
  if (lines.filter(line => /^Flash Info:$/i.test(line)).length !== 1 || rows.length !== 1 || !size) return unavailable;
  const sectors = Number.parseInt(size[2], 16);
  if (Math.floor(sectors / 2048) !== Number(size[1])) return unavailable;
  return { ok: true, capacityBytes: sectors * 512 };
}

async function readExact(handle, length, offset) {
  const data = Buffer.alloc(length);
  for (let read = 0; read < length;) {
    const { bytesRead } = await handle.read(data, read, length - read, offset + read);
    if (!bytesRead) throw invalid('rk-firmware-invalid');
    read += bytesRead;
  }
  return data;
}

async function readRkFirmware(firmware, { withBoot = false, io = fs } = {}) {
  if (firmware?.chip !== RK3576_CHIP || !localPath(firmware?.path) || path.extname(firmware.path).toLowerCase() !== '.img' ||
    !/^[0-9a-f]{64}$/.test(firmware.sha256 || '')) throw invalid('rk-firmware-invalid');
  const handle = await io.open(firmware.path, 'r');
  try {
    const stat = await handle.stat();
    const data = await readExact(handle, headerBytes, 0);
    const offset = data.readUInt32LE(25);
    const length = data.readUInt32LE(29);
    const imageOffset = data.readUInt32LE(33);
    const imageLength = BigInt(data.readUInt32LE(37)) + (data.toString('ascii', 55, 57) === 'HI' ? BigInt(data.readUInt32LE(57)) << 32n : 0n);
    if (!stat.isFile() || data.toString('ascii', 0, 4) !== 'RKFW' || data.readUInt32LE(21) !== Number(RK3576_CHIP) ||
      data.readUInt16LE(4) < headerBytes || offset < data.readUInt16LE(4) || length < 8 || length > maxBootBytes ||
      imageOffset < offset + length || imageLength < 4n || BigInt(stat.size) - BigInt(imageOffset) - imageLength < 32n) {
      throw invalid('rk-firmware-invalid');
    }
    if (!withBoot) return { size: stat.size };
    const boot = await readExact(handle, length, offset);
    if (!['BOOT', 'LDR '].includes(boot.toString('ascii', 0, 4))) throw invalid('rk-ram-loader-invalid');
    return { size: stat.size, boot };
  } finally { await handle.close(); }
}

function parseRkProgressLine(line) {
  if (typeof line !== 'string' || line.length > 1024) return null;
  const text = stripAnsi(line);
  if (statusMarker.test(text)) return { type: 'success' };
  if (failureMarker.test(text)) return { type: 'failure' };
  const target = targetMarker.exec(text);
  if (target) return { type: 'target', locationId: normalizeLocation(target[1]) };
  const progress = progressMarker.exec(text);
  if (progress && Number(progress[1]) <= 100) return { type: 'progress', percent: Number(progress[1]) };
  const stage = stageMarker.exec(text);
  return stage ? { type: 'stage', stage: (stage[1] + ' ' + stage[2]).toLowerCase().replaceAll(' ', '-') } : null;
}

function classifyRkResult({ exitCode, successMarker, failureMarker, signal } = {}) {
  if (signal || !Number.isInteger(exitCode)) return fail('rk-write-interrupted');
  if (exitCode !== 0 || failureMarker === true) return fail('rk-write-failed');
  if (successMarker !== true) return fail('rk-write-unconfirmed');
  return { ok: true, code: 'rk-tool-reported-success' };
}

module.exports = {
  RK3576_CHIP, inspectRkTool, rkListArgs, parseRkDeviceList, buildRkFlashArgs, rkReadArgs,
  rkBootArgs, parseRkReadInfo, readRkFirmware, parseRkProgressLine, classifyRkResult,
};
