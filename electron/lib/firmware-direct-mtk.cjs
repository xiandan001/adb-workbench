const path = require('node:path').win32;

const MTK_VERSION = '6.2444.00.000';
const operations = Object.freeze({
  'download-only': 'download',
  'firmware-upgrade': 'firmware-upgrade',
  'format-all-download': 'format-download',
});
const batteryModes = new Set(['auto', 'with', 'without']);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function comPort(value) {
  if (typeof value !== 'string') return null;
  const match = /^COM([1-9][0-9]{0,3})$/i.exec(value);
  return match && Number(match[1]) <= 4096 ? 'COM' + match[1] : null;
}

function targetPort(target) {
  const port = comPort(target?.port);
  if (target?.verified !== true || !port) fail('MTK_TARGET_UNVERIFIED');
  if (target.stage === 'preloader' && !target.daPort) return port;
  const daPort = comPort(target.daPort);
  if (target.stage !== 'brom' || target.sameDeviceVerified !== true || !daPort || port === daPort) {
    fail('MTK_PORT_MAPPING_UNVERIFIED');
  }
  return port + '+' + daPort;
}

function verifiedFile(descriptor, filename, extension, code) {
  const selected = descriptor?.[filename];
  // Called only with files and live ports resolved by the main process.
  if (descriptor?.verified !== true || typeof selected !== 'string' || selected.length > 1024 ||
      !/^[a-z]:[\\/]/i.test(selected) || /[\x00-\x1f\x7f"<>|?*]/.test(selected) ||
      selected.slice(2).includes(':') || path.extname(selected).toLowerCase() !== extension) fail(code);
  const parts = selected.slice(3).split(/[\\/]/);
  if (parts.some(part => !part || part.endsWith('.') || part.endsWith(' ') ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail(code);
  return path.normalize(selected);
}

function buildMtkFlashArgs({
  executableVersion, target, firmware, mode, battery = 'auto', reboot = false,
  permitFormatAll = false, authenticationFile, certificateFile,
} = {}) {
  if (executableVersion !== MTK_VERSION) fail('MTK_VERSION_UNSUPPORTED');
  if (typeof mode !== 'string' || !Object.hasOwn(operations, mode)) fail('MTK_MODE_UNSUPPORTED');
  if (mode === 'format-all-download' && permitFormatAll !== true) fail('MTK_FORMAT_NOT_CONFIRMED');
  if (!batteryModes.has(battery) || typeof reboot !== 'boolean') fail('MTK_OPTIONS_INVALID');
  const port = targetPort(target);
  const manifest = verifiedFile(firmware, 'manifestPath', '.xml', 'MTK_MANIFEST_UNVERIFIED');
  const args = ['-c', operations[mode], '-f', manifest, '-p', port, '-t', battery, '-r'];
  if (authenticationFile !== undefined) args.push('-a', verifiedFile(authenticationFile, 'path', '.auth', 'MTK_AUTH_UNVERIFIED'));
  if (certificateFile !== undefined) args.push('-e', verifiedFile(certificateFile, 'path', '.cert', 'MTK_CERT_UNVERIFIED'));
  if (reboot) args.push('-b');
  return args;
}

function parseMtkFlashLine(line) {
  if (typeof line !== 'string' || line.length > 2048) return null;
  const text = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (text === 'All command exec done!') return { phase: 'tool-completed' };
  if (/^com port friendly name:/i.test(text)) {
    const port = /(?:\((COM[1-9][0-9]{0,3})\)(?=@)|(?:^|[\s(:])(COM[1-9][0-9]{0,3})\)?$)/i.exec(text)?.slice(1).find(Boolean);
    if (comPort(port)) return { phase: 'tool-target', port: comPort(port) };
  }
  if (/Invalid parameter:|Error: Unknow command line parse results!|image checksum mismatch|Operation failed!|(?:BaseException|std::exception): err_msg\[|Unknown error ocurred\./i.test(text)) {
    return { phase: 'tool-error' };
  }
  if (/Begin verify load images checksum|verify load images checksum done!/i.test(text)) return { phase: 'preparing' };
  const progress = /(?:^|\s)(100|[1-9]?[0-9])%{1,2} of (BROM data has been sent|DA data has been sent|flash has been formatted|image data has been sent|\[[a-z0-9_. -]{1,96}(?: \[(\d{1,3})\/(\d{1,3})\])?\] data has been sent)/i.exec(text);
  if (!progress) return null;
  const description = progress[2].toLowerCase();
  const phase = /^(brom|da) /.test(description) ? 'connecting'
    : description.startsWith('flash ') ? 'formatting' : 'writing';
  const [part, total] = progress.slice(3).map(Number);
  return {
    phase, percentage: Number(progress[1]),
    ...(part > 0 && total >= part ? { part, total } : {}),
  };
}

function parseMtkTraceLine(line, pid) {
  if (typeof line !== 'string' || line.length > 2048 || !Number.isInteger(pid) || pid <= 0) return null;
  const record = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\.\d{3} SPFlashToolV6\[(\d{1,10})\]\[\d{1,10}\]\[[A-Z]\]: (.*?)(?:\([a-z0-9_]+\.cpp,\d+\))?$/i.exec(line);
  if (!record || Number(record[1]) !== pid) return null;
  const body = record[2];
  const scan = /^Connection::scan_com_port\(\): scan device START, timeout set as (\d{1,7}) ms\.$/.exec(body);
  if (scan) return { phase: 'scan', timeoutMs: Number(scan[1]) };
  const clue = /^Connection::scan_com_port\(\): com port clue: COM:\/\/([^.]*)\.$/i.exec(body);
  if (clue) return { phase: 'clue', port: comPort(clue[1]) };
  const friendly = /^ConsoleModeCallBack::cb_com_port_status\(\): (com port friendly name:.*)$/.exec(body);
  if (friendly) {
    const target = parseMtkFlashLine(friendly[1]);
    const usb = /^com port friendly name: COM:\/\/\\\\\?\\usb#(vid_[a-f0-9]{4}&pid_[a-f0-9]{4}(?:&mi_[a-f0-9]{2})?)#([a-z0-9._&-]{1,160})#\{[a-f0-9-]{36}\}@/i.exec(friendly[1]);
    return target && usb ? { ...target, instanceId: ['USB', usb[1], usb[2]].join('\\').toUpperCase() } : target;
  }
  if (/^CmdExecutor::execute\(\): .*?\bCMD:(?:ERASE-FLASH|FLASH-ALL)\b/.test(body)) return { phase: 'mode-mismatch' };
  if (body === 'CmdExecutor::execute(): CMD:WRITE-PARTITIONS command execute successed.') return { phase: 'partitions-written' };
  if (/^CmdExecutor::execute\(\): CMD:WRITE-PARTITIONS command execute failed\b/.test(body)) return { phase: 'tool-error' };
  if (body === 'ConsoleMode::ConsoleModeEntry::run(): All command exec done!') return { phase: 'tool-completed' };
  const message = /^(?:ConsoleMode::ConsoleModeRunner::cbDownloadProgress|ConsoleMode::ConsoleModeEntry::run)\(\): (.*)$/.exec(body);
  return message ? parseMtkFlashLine(message[1]) : null;
}

function updateMtkEvidence(evidence, event) {
  if (!event) return evidence;
  return {
    sawWrite: evidence?.sawWrite === true || (event.phase === 'writing' && event.percentage > 0),
    sawCompletion: evidence?.sawCompletion === true || event.phase === 'tool-completed',
    sawError: evidence?.sawError === true || event.phase === 'tool-error',
  };
}

function finishMtkFlash({ exitCode, signal, evidence } = {}) {
  if (signal) return { ok: false, status: 'interrupted' };
  if (evidence?.sawError === true || (Number.isInteger(exitCode) && exitCode !== 0)) return { ok: false, status: 'failed' };
  if (exitCode !== 0 || evidence?.sawWrite !== true || evidence.sawCompletion !== true) {
    return { ok: false, status: 'unverified' };
  }
  // This confirms only the tool reported successful writing. Device boot evidence is separate.
  return { ok: true, status: 'tool-completed' };
}

module.exports = { MTK_VERSION, buildMtkFlashArgs, parseMtkFlashLine, parseMtkTraceLine, updateMtkEvidence, finishMtkFlash };
