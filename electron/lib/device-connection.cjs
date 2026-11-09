const { tr } = require('./localization.cjs');
const { runAdb } = require('./adb-runtime.cjs');
const { runHdcHost } = require('./hdc-runtime.cjs');
const { discoverDevices } = require('./device-discovery.cjs');
const { isHarmonyDevice, deviceTarget, hdcDeviceId } = require('./device-platform.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');

function connectionAddress(value) {
  const raw = String(value || '').trim();
  const address = isHarmonyDevice(raw) ? deviceTarget(raw) : raw;
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\]):\d{1,5}$/.test(address)
    || Number(address.slice(address.lastIndexOf(':') + 1)) < 1
    || Number(address.slice(address.lastIndexOf(':') + 1)) > 65535) {
    throw new Error(tr('请输入有效的设备 IP 地址和端口。'));
  }
  return address;
}
async function connectDevice(value, options = {}) {
  const address = connectionAddress(value);
  const adb = options.runAdb || runAdb, hdc = options.runHdcHost || runHdcHost;
  if (!isHarmonyDevice(value)) {
    const result = await adb(['connect', address], { queueGlobal: true, timeoutMs: 6000 });
    if (result.ok && /(?:already )?connected to /i.test(result.stdout || '')) {
      return { success: true, deviceId: address, transport: 'adb', message: result.stdout };
    }
  }
  const result = await hdc(['tconn', address], { timeoutMs: 8000 });
  if (!result.ok) return { success: false, error: result.error || result.stderr || tr('设备连接失败') };
  const discovered = await (options.discoverDevices || discoverDevices)();
  const id = hdcDeviceId(address);
  if (!discovered.devices.some(device => device.id === id && device.status === 'device')) {
    return { success: false, error: tr('尚未建立已授权的 HDC 连接，请在设备上确认调试授权后重试。') };
  }
  return { success: true, deviceId: id, transport: 'hdc', message: tr('已连接 {0}', { 0: address }) };
}
async function disconnectDevice(deviceId, options = {}) {
  if (!isHarmonyDevice(deviceId)) {
    const result = await (options.runAdb || runAdb)(['disconnect', deviceId], { queueGlobal: true });
    return { success: result.ok, message: result.stdout, error: result.error };
  }
  const ref = resolveDeviceRef(deviceId, { allowOffline: true });
  if (!['tcp', 'wifi'].includes(ref.connectionType)) return { success: false, error: tr('USB 或串口设备请拔出数据线；不会重启 HDC 服务或影响其他设备。') };
  const result = await (options.runHdcHost || runHdcHost)(['tconn', ref.targetKey, '-remove']);
  return { success: result.ok, message: result.stdout, error: result.error };
}
module.exports = { connectionAddress, connectDevice, disconnectDevice };
