const { types } = require('node:util');
const { safeDiagnosticChannel } = require('./app-diagnostic-log.cjs');
const installSpec = require('./update-install-spec.json');

const EVENTS = {
  session: new Set(['start', 'stop']),
  app: new Set(['startup', 'ready', 'shutdown', 'failure', 'console', 'renderer-error', 'renderer-gone', 'load-failed']),
  ipc: new Set(['failure']),
  updater: new Set(['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error', 'retry', 'install']),
  media: new Set(['opening', 'state', 'configure', 'configured', 'decode-error', 'fallback', 'first-frame', 'queue-limit', 'decode-summary', 'first-frame-timeout', 'transport-error', 'control-request', 'control-stage', 'control-result']),
};
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'NotSupportedError', 'DataError', 'InvalidStateError', 'EncodingError', 'AbortError', 'OperationError', 'SecurityError', 'UnknownError', 'TimeoutError', 'QuotaExceededError']);
const ERROR_CODES = new Set(['UNKNOWN', 'TIMEOUT', 'NETWORK', 'NOT_SUPPORTED', 'INVALID_DATA', 'INVALID_STATE', 'QUEUE_LIMIT', 'CONFIGURATION', 'DECODE', 'PAINT', 'ABORTED', 'IO_ERROR', 'IPC_THROW', 'IPC_REJECT', 'IPC_FAILURE',
  'CONFIG_UNSUPPORTED', 'CONFIG_FAILED', 'CONFIG_TIMEOUT', 'DECODE_FAILED', 'DRAIN_FAILED', 'DRAIN_TIMEOUT', 'NO_OUTPUT', 'PAINT_FAILED', 'INVALID_PACKET']);
const REASONS = new Set(['manual', 'time-limit', 'size-limit', 'interrupted', 'io-error']);
const CONTROL_REASONS = ['BUSY', 'NO_FRAME', 'DEVICE_CHANGED', 'INVALID_INPUT', 'HELP_UNAVAILABLE', 'API_UNAVAILABLE', 'UNSUPPORTED',
  'REMOTE_EXIT', 'REMOTE_UNCONFIRMED', 'TRANSPORT_ERROR', 'TIMEOUT', 'CANCELLED', 'PERMISSION_DENIED', 'UITEST_ERROR', 'UNKNOWN'];
const CONTROL_CODES = ['INPUT_BUSY', 'INPUT_SESSION', 'INPUT_DEVICE_CHANGED', 'INPUT_ARGUMENT', 'INPUT_UNSUPPORTED', 'INPUT_HELP', 'INPUT_API',
  'INPUT_PERMISSION', 'INPUT_TRANSPORT', 'INPUT_REMOTE_EXIT', 'INPUT_REMOTE_UNCONFIRMED', 'INPUT_TIMEOUT', 'INPUT_CANCELLED', 'INPUT_COMMAND', 'INPUT_UNKNOWN'];
const STAGES = new Set(['starting', 'awaiting-consent', 'streaming', 'stopping', 'stopped', 'failed', 'waiting-configuration', 'waiting-keyframe', 'submitted', 'decoder-error']);
const NUMBERS = ['received', 'submitted', 'output', 'keyframes', 'width', 'height', 'durationMs', 'bytes', 'records', 'dropped', 'percent', 'errorNumber'];
function fields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return key => descriptors[key] && Object.hasOwn(descriptors[key], 'value') ? descriptors[key].value : undefined;
}
function normalizeApplicationLogEvent(value) {
  const get = fields(value);
  if (!get || typeof get('source') !== 'string' || !Object.hasOwn(EVENTS, get('source')) || !EVENTS[get('source')].has(get('event'))) return null;
  const row = { source: get('source'), event: get('event') };
  if (row.source === 'updater' && row.event === 'install') {
    if (installSpec.phases.includes(get('installPhase'))) row.installPhase = get('installPhase');
    if (installSpec.codes.includes(get('installCode'))) row.installCode = get('installCode');
    if (Number.isSafeInteger(get('installerPid')) && get('installerPid') > 0 && get('installerPid') <= 4294967295) row.installerPid = get('installerPid');
  }
  const control = get('source') === 'media' && ['control-request', 'control-stage', 'control-result'].includes(get('event'));
  if (get('channel') !== undefined) row.channel = safeDiagnosticChannel(get('channel'));
  const enums = { level: ['info', 'warn', 'error'], mode: ['hardware', 'software', 'default'],
    reason: control ? CONTROL_REASONS : [...REASONS], stage: [...STAGES], errorName: [...ERROR_NAMES], errorCode: [...ERROR_CODES],
    component: ['app', 'startup', 'updater', 'mcp', 'renderer', 'ipc', 'media', 'other'],
    platform: ['win32', 'darwin', 'linux'], architecture: ['x64', 'arm64', 'ia32'],
    acceleration: ['enabled', 'disabled', 'unavailable', 'unknown'] };
  for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(get(key))) row[key] = get(key);
  for (const key of NUMBERS) if (Number.isFinite(get(key)) && get(key) >= 0 && get(key) <= 1e12) row[key] = Math.round(get(key));
  for (const key of ['sps', 'pps', 'supported', 'decoded']) if (typeof get(key) === 'boolean') row[key] = get(key);
  if (typeof get('codec') === 'string' && /^avc1\.[a-f\d]{6}$/i.test(get('codec'))) row.codec = get('codec');
  for (const key of ['version', 'electron', 'chrome', 'osRelease']) {
    if (typeof get(key) === 'string' && /^\d[\d.]{0,48}$/.test(get(key))) row[key] = get(key);
  }
  if (control) {
    const meta = { operation: ['tap', 'swipe', 'home', 'back', 'text', 'unknown'], phase: ['validation', 'help', 'api', 'execute', 'complete'],
      outcome: ['started', 'success', 'failure', 'cancelled', 'rejected'], completion: ['confirmed', 'missing', 'not-requested'], controlCode: CONTROL_CODES };
    for (const [key, allowed] of Object.entries(meta)) if (allowed.includes(get(key))) row[key] = get(key);
    for (const key of ['viewNumber', 'requestNumber']) if (Number.isSafeInteger(get(key)) && get(key) >= 0 && get(key) <= 1e12) row[key] = get(key);
    if (Number.isInteger(get('remoteCode')) && get('remoteCode') >= 0 && get('remoteCode') <= 255) row.remoteCode = get('remoteCode');
    if (Number.isInteger(get('hostCode')) && get('hostCode') >= -2147483648 && get('hostCode') <= 4294967295) row.hostCode = get('hostCode');
    for (const key of ['streaming', 'transportFailure']) if (typeof get(key) === 'boolean') row[key] = get(key);
  }
  return row;
}
function classifyApplicationError(error) {
  let name = '', text = '';
  try {
    if (typeof error === 'string') text = error.slice(0, 4096);
    else if (error && !types.isProxy(error)) {
      const own = Object.getOwnPropertyDescriptors(error);
      name = typeof own.name?.value === 'string' ? own.name.value : error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'Error';
      text = [own.code?.value, own.message?.value].filter(value => typeof value === 'string').join(' ').slice(0, 4096);
    }
  } catch { /* Only fixed classifications leave this boundary. */ }
  const errorName = ERROR_NAMES.has(name) ? name : 'Error';
  const patterns = [['TIMEOUT', /TIMED?_?OUT|timeout|超时/i], ['NETWORK', /ERR_NETWORK|ENET|ECONN|ENOTFOUND|network/i],
    ['NOT_SUPPORTED', /NotSupported|not supported|unsupported|不支持/i], ['QUEUE_LIMIT', /H264_QUEUE|queue|堆积/i],
    ['ABORTED', /AbortError|abort/i], ['INVALID_STATE', /InvalidState|closed/i],
    ['INVALID_DATA', /DataError|invalid data/i], ['CONFIGURATION', /configur/i], ['DECODE', /decod/i]];
  return { errorName, errorCode: patterns.find(([, pattern]) => pattern.test(name + ' ' + text))?.[0] || 'UNKNOWN' };
}
module.exports = { normalizeApplicationLogEvent, classifyApplicationError };
