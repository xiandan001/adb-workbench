const { tr } = require('./localization.cjs');
const { isHarmonyDevice, hdcDeviceId, deviceTarget } = require('./device-platform.cjs');
const registry = new Map();

function normalizeDeviceDescriptor(value) {
  if (!value || typeof value.id !== 'string' || !value.id) throw new Error(tr('设备信息无效。'));
  const harmony = isHarmonyDevice(value.id), targetKey = deviceTarget(value.id);
  if (value.transport && value.transport !== (harmony ? 'hdc' : 'adb') || value.targetKey && value.targetKey !== targetKey) {
    throw Object.assign(new Error(tr('设备通道与目标不匹配。')), { code: 'DEVICE_TRANSPORT_MISMATCH', safe: true });
  }
  return Object.freeze({ ...value, targetKey, displayId: targetKey, transport: harmony ? 'hdc' : 'adb',
    platform: harmony ? 'harmony' : 'android', status: value.status || 'device',
    generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
    capabilities: Object.freeze({ ...(value.capabilities || {}) }) });
}
function registerDiscoveredDevices(transport, devices) {
  if (!['adb', 'hdc'].includes(transport) || !Array.isArray(devices)) throw new Error(tr('设备列表无效。'));
  const current = new Set();
  const result = devices.map(value => {
    const id = transport === 'hdc' ? hdcDeviceId(value.targetKey || deviceTarget(value.id)) : value.id;
    const previous = registry.get(id);
    const generation = (previous?.generation || 0) + (previous && previous.status !== value.status ? 1 : 0);
    const retained = previous?.generation === generation ? previous : {};
    const ref = normalizeDeviceDescriptor({ ...retained, ...value, id, transport, generation });
    current.add(id); registry.set(id, ref); return ref;
  });
  for (const [id, previous] of registry) if (previous.transport === transport && !current.has(id) && previous.status === 'device') {
    registry.set(id, normalizeDeviceDescriptor({ ...previous, status: 'disconnected', generation: previous.generation + 1 }));
  }
  return result;
}
function resolveDeviceRef(deviceId, { deviceRef, allowOffline = false } = {}) {
  let ref;
  if (deviceRef) {
    ref = normalizeDeviceDescriptor(deviceRef);
    if (ref.id !== deviceId) throw Object.assign(new Error(tr('设备通道与目标不匹配。')), { code: 'DEVICE_TRANSPORT_MISMATCH', safe: true });
  } else ref = registry.get(deviceId);
  if (!ref && !isHarmonyDevice(deviceId)) ref = normalizeDeviceDescriptor({ id: deviceId, status: 'device' });
  if (!ref) throw Object.assign(new Error(tr('尚未识别此鸿蒙设备，请刷新设备列表。')), { code: 'DEVICE_UNKNOWN', safe: true });
  if (!allowOffline && ref.status !== 'device') throw Object.assign(new Error(tr('所选设备尚未连接或未获授权。')), { code: 'DEVICE_OFFLINE', safe: true });
  return ref;
}
function knownDevices() { return [...registry.values()]; }
module.exports = { normalizeDeviceDescriptor, registerDiscoveredDevices, resolveDeviceRef, knownDevices };
