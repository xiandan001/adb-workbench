export const PINNED_DEVICES_KEY = 'adb-workbench.pinned-devices.v1';

export function normalizePinnedDevices(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string'
    || !id.trim() || id.length > 300 || [...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
    throw new Error('常用设备数据无效');
  }
  return [...new Set(value)];
}

function readStoredPins(storage) {
  const raw = storage.getItem(PINNED_DEVICES_KEY);
  if (raw === null || raw === undefined) return [];
  try { return normalizePinnedDevices(JSON.parse(raw)); }
  catch { throw new Error('常用设备数据异常，原数据已保留，请通过数据迁移恢复后重试'); }
}

export function readPinnedDevices(storage = globalThis.localStorage) {
  try { return readStoredPins(storage); }
  catch { return []; }
}

export function togglePinnedDevice(deviceId, storage = globalThis.localStorage) {
  normalizePinnedDevices([deviceId]);
  const previous = readStoredPins(storage);
  const next = normalizePinnedDevices(previous.includes(deviceId)
    ? previous.filter(id => id !== deviceId) : [...previous, deviceId]);
  storage.setItem(PINNED_DEVICES_KEY, JSON.stringify(next));
  return next;
}

// Membership eligibility is resolved by the caller before this presentation-only step.
export function filterDeviceCards(devices, { query = '', names = {}, pinnedIds = [] } = {}) {
  const search = query.trim().toLowerCase();
  const pins = new Set(pinnedIds);
  return devices.filter(device => !search || [names[device.id], device.model, device.id, device.ip]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(search)))
    .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)));
}
