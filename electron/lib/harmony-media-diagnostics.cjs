const { tr } = require('./localization.cjs');

const STAGES = new Set(['waiting-configuration', 'waiting-keyframe', 'submitted', 'decoder-error']);
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
  return tr('设备视频已送达解码器，但主机尚未显示首帧。');
}
module.exports = { normalizeDecoderDiagnostic, firstFrameFailure };
