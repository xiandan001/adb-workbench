const { types } = require('node:util');
const { safeDiagnosticChannel } = require('./app-diagnostic-log.cjs');

const EVENTS = {
  session: new Set(['start', 'stop']),
  app: new Set(['startup', 'ready', 'shutdown', 'failure', 'console', 'renderer-error', 'renderer-gone', 'load-failed']),
  ipc: new Set(['failure']),
  updater: new Set(['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error', 'retry']),
  media: new Set(['opening', 'state', 'configure', 'configured', 'decode-error', 'fallback', 'first-frame', 'queue-limit', 'decode-summary', 'first-frame-timeout', 'transport-error']),
};
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'NotSupportedError', 'DataError', 'InvalidStateError', 'EncodingError', 'AbortError', 'OperationError', 'SecurityError', 'UnknownError', 'TimeoutError', 'QuotaExceededError']);
const ERROR_CODES = new Set(['UNKNOWN', 'TIMEOUT', 'NETWORK', 'NOT_SUPPORTED', 'INVALID_DATA', 'INVALID_STATE', 'QUEUE_LIMIT', 'CONFIGURATION', 'DECODE', 'PAINT', 'ABORTED', 'IO_ERROR', 'IPC_THROW', 'IPC_REJECT', 'IPC_FAILURE',
  'CONFIG_UNSUPPORTED', 'CONFIG_FAILED', 'CONFIG_TIMEOUT', 'DECODE_FAILED', 'DRAIN_FAILED', 'DRAIN_TIMEOUT', 'NO_OUTPUT', 'PAINT_FAILED', 'INVALID_PACKET']);
const REASONS = new Set(['manual', 'time-limit', 'size-limit', 'interrupted', 'io-error']);
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
  if (get('channel') !== undefined) row.channel = safeDiagnosticChannel(get('channel'));
  const enums = { level: ['info', 'warn', 'error'], mode: ['hardware', 'software', 'default'],
    reason: [...REASONS], stage: [...STAGES], errorName: [...ERROR_NAMES], errorCode: [...ERROR_CODES],
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
