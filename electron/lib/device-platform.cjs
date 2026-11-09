const { tr } = require('./localization.cjs');

const HDC_PREFIX = 'hdc:';
function isHarmonyDevice(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith(HDC_PREFIX);
}
function hdcDeviceId(targetKey) {
  if (typeof targetKey !== 'string' || !targetKey || targetKey.length > 156 || /^-/.test(targetKey) || /[\s\u0000-\u001f\u007f]/u.test(targetKey)) {
    throw Object.assign(new Error(tr('鸿蒙设备标识无效。')), { code: 'INVALID_DEVICE', safe: true });
  }
  return HDC_PREFIX + targetKey;
}
function deviceTarget(deviceId) {
  if (!isHarmonyDevice(deviceId)) return String(deviceId || '');
  const targetKey = deviceId.slice(HDC_PREFIX.length);
  hdcDeviceId(targetKey);
  return targetKey;
}
function devicePlatform(deviceId) { return isHarmonyDevice(deviceId) ? 'harmony' : 'android'; }
function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw Object.assign(new Error(tr('命令参数不能包含空字符。')), { code: 'INVALID_ARGUMENT', safe: true });
  return "'" + text.replace(/'/g, "'\\''") + "'";
}
function unsupportedDeviceOperation(operation) {
  return Object.assign(new Error(tr('当前设备不支持此操作：{0}', { 0: operation })), { code: 'DEVICE_UNSUPPORTED', safe: true });
}
module.exports = { HDC_PREFIX, isHarmonyDevice, hdcDeviceId, deviceTarget, devicePlatform, shellQuote, unsupportedDeviceOperation };
