import { tr } from './i18n.js';

export const APPLICATION_RECENTS_KEY = 'adb-workbench.application-recents.v1';
const cache = new Map();
const clean = (value, limit) => typeof value === 'string' && value.length <= limit && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export const validApplicationPackage = value => clean(value, 256) && (!value || /^[A-Za-z0-9_.-]+$/.test(value));
export function applicationPopupPosition(rect, viewportWidth, viewportHeight) {
  const width = Math.min(Math.max(rect.width, 300), viewportWidth - 24);
  const below = viewportHeight - rect.bottom - 12, above = rect.top - 12;
  const height = Math.min(380, Math.max(above, below));
  return { left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)),
    top: below >= Math.min(300, height) ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), width, maxHeight: height };
}
export function applicationDeviceKey(device) {
  if (!clean(device?.id, 300) || !device.id || /\s/u.test(device.id)) return '';
  const generation = Number.isSafeInteger(device.generation) && device.generation >= 0 ? device.generation : 0;
  return JSON.stringify([device.id, generation]);
}
export function normalizeApplications(items) {
  if (!Array.isArray(items)) throw new Error(tr('读取应用列表失败，请重试或手动输入。'));
  const seen = new Set();
  return items.slice(0, 2000).flatMap(item => {
    const packageName = typeof item === 'string' ? item : item?.packageName;
    if (!packageName || !validApplicationPackage(packageName) || seen.has(packageName)) return [];
    seen.add(packageName);
    const proposed = item?.label || item?.name;
    const label = clean(proposed, 200) && proposed.trim() ? proposed.trim() : packageName;
    return [{ packageName, label }];
  });
}
export async function readApplications(api, device, { refresh = false, now = Date.now() } = {}) {
  const key = applicationDeviceKey(device);
  if (!key || device.status !== 'device' || typeof api?.packageList !== 'function') throw new Error(tr('请先选择在线设备，或手动填写应用包名。'));
  const existing = cache.get(key);
  if (!refresh && existing?.api === api) {
    if (existing.pending) return existing.pending;
    if (now - existing.at < 60000) return existing.items;
  }
  const entry = { api, pending: null, at: 0, items: [] };
  cache.delete(key); cache.set(key, entry);
  while (cache.size > 20) cache.delete(cache.keys().next().value);
  entry.pending = Promise.resolve().then(() => api.packageList({ deviceId: device.id })).then(response => {
    if (response?.ok !== true) throw new Error(tr('读取应用列表失败，请重试或手动输入。'));
    const items = normalizeApplications(response.packages);
    if (cache.get(key) === entry) { entry.items = items; entry.at = now; entry.pending = null; }
    return items;
  }).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
  return entry.pending;
}
export function filterApplications(items, query, recent = []) {
  const text = query.trim().toLocaleLowerCase();
  const rank = new Map(recent.map((name, index) => [name, index]));
  return items.filter(item => !text || `${item.label}\n${item.packageName}`.toLocaleLowerCase().includes(text))
    .sort((a, b) => (rank.get(a.packageName) ?? 100) - (rank.get(b.packageName) ?? 100));
}
export function normalizeApplicationRecents(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'items') || value.version !== 1
    || !Array.isArray(value.items) || value.items.length > 20) throw new Error();
  const seen = new Set();
  return { version: 1, items: value.items.map(item => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'deviceId') || !Object.hasOwn(item, 'packages') || !clean(item.deviceId, 300) || !item.deviceId || /\s/u.test(item.deviceId) || seen.has(item.deviceId)
      || !Array.isArray(item.packages) || item.packages.length > 6 || new Set(item.packages).size !== item.packages.length
      || item.packages.some(name => !name || !validApplicationPackage(name))) throw new Error();
    seen.add(item.deviceId); return { deviceId: item.deviceId, packages: [...item.packages] };
  }) };
}
export function readApplicationRecents(storage = globalThis.localStorage) {
  const raw = storage?.getItem(APPLICATION_RECENTS_KEY);
  if (raw === null || raw === undefined) return { version: 1, items: [] };
  try { if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 65536) throw new Error(); return normalizeApplicationRecents(JSON.parse(raw)); }
  catch { throw new Error(tr('最近应用数据异常，原内容已保留。')); }
}
export function rememberApplication(deviceId, packageName, storage = globalThis.localStorage) {
  if (!clean(deviceId, 300) || !deviceId || /\s/u.test(deviceId) || !validApplicationPackage(packageName)) throw new Error(tr('应用选择无效。'));
  const previous = readApplicationRecents(storage);
  if (!packageName) return previous;
  const packages = [packageName, ...(previous.items.find(item => item.deviceId === deviceId)?.packages || []).filter(name => name !== packageName)].slice(0, 6);
  const next = normalizeApplicationRecents({ version: 1, items: [{ deviceId, packages }, ...previous.items.filter(item => item.deviceId !== deviceId)].slice(0, 20) });
  storage.setItem(APPLICATION_RECENTS_KEY, JSON.stringify(next)); return next;
}
