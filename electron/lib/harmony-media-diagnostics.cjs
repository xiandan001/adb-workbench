const { tr } = require('./localization.cjs');

const STAGES = new Set(['waiting-configuration', 'waiting-keyframe', 'submitted', 'decoder-error']);
const EVENTS = new Set(['configure', 'configured', 'decode-error', 'fallback', 'first-frame', 'queue-limit', 'decode-summary']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'DataError', 'EncodingError', 'InvalidStateError',
  'NotSupportedError', 'OperationError', 'QuotaExceededError', 'SecurityError', 'TimeoutError']);
const ERROR_CODES = new Set(['CONFIG_UNSUPPORTED', 'CONFIG_FAILED', 'CONFIG_TIMEOUT', 'DECODE_FAILED', 'DRAIN_FAILED',
  'DRAIN_TIMEOUT', 'NO_OUTPUT', 'PAINT_FAILED', 'QUEUE_LIMIT', 'INVALID_PACKET']);
function normalizeDecoderEvent(value) {
  const fields = new Set(['event', 'mode', 'codec', 'supported', 'received', 'submitted', 'output', 'keyframes', 'width', 'height', 'errorName', 'errorCode']);
  const invalid = () => { throw new Error(tr('视频解码状态无效，未接受额外数据。')); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !fields.has(key) || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  const data = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  if (!EVENTS.has(data.event)) invalid();
  if (data.mode !== undefined && !['hardware', 'software', 'default'].includes(data.mode)) invalid();
  if (data.codec !== undefined && (typeof data.codec !== 'string' || data.codec !== '' && !/^avc1\.[a-f\d]{6}$/i.test(data.codec))) invalid();
  if (data.supported !== undefined && typeof data.supported !== 'boolean') invalid();
  for (const key of ['received', 'submitted', 'output', 'keyframes', 'width', 'height']) {
    if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > (['width', 'height'].includes(key) ? 16384 : 1000000000))) invalid();
  }
  if (data.errorName !== undefined && !ERROR_NAMES.has(data.errorName)) invalid();
  if (data.errorCode !== undefined && !ERROR_CODES.has(data.errorCode)) invalid();
  return data;
}
function normalizeDecoderDiagnostic(value) {
  const keys = ['stage', 'received', 'submitted', 'keyframes', 'sps', 'pps', 'codec'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || !STAGES.has(value.stage)
    || ['received', 'submitted', 'keyframes'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1000000000)
    || typeof value.sps !== 'boolean' || typeof value.pps !== 'boolean'
    || typeof value.codec !== 'string' || value.codec !== '' && !/^avc1\.[a-f\d]{6}$/i.test(value.codec)) {
    throw new Error(tr('视频解码状态无效，未接受额外数据。'));
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function firstFrameFailure(diagnostic) {
  if (!diagnostic) return tr('主机未能解码首个视频帧，未将投屏标记为成功。');
  if (!diagnostic.received) return tr('尚未收到设备视频数据，请检查设备是否允许屏幕采集。');
  if (!diagnostic.sps || !diagnostic.pps) return tr('已收到视频数据，但视频初始化参数不完整，尚不能显示画面。');
  if (!diagnostic.keyframes) return tr('已收到视频数据，但尚未收到可解码的关键帧。');
  if (!diagnostic.submitted) return tr('已收到关键帧，但尚未提交解码。请导出应用日志。');
  return tr('设备视频已送达解码器，但主机尚未显示首帧。');
}
module.exports = { normalizeDecoderDiagnostic, normalizeDecoderEvent, firstFrameFailure };
