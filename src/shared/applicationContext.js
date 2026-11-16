import { tr } from './i18n.js';

export const APPLICATION_CONTEXT_KEY = 'adb-workbench.application-context.v1';
export const emptyApplicationContext = () => ({ version: 1, entries: [] });
const hasControl = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const fail = () => { throw new Error(tr('应用选择记录无效，原数据已保留。')); };
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function normalizeApplicationContext(value) {
  if (!shape(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 20) fail();
  const seen = new Set();
  const entries = Array.from(value.entries, item => {
    if (!shape(item, ['deviceId', 'packageName']) || typeof item.deviceId !== 'string' || !item.deviceId || item.deviceId.length > 300
      || /\s/u.test(item.deviceId) || hasControl(item.deviceId) || seen.has(item.deviceId) || typeof item.packageName !== 'string'
      || !item.packageName || item.packageName.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(item.packageName)) fail();
    seen.add(item.deviceId); return { deviceId: item.deviceId, packageName: item.packageName };
  });
  return { version: 1, entries };
}
export function readApplicationContext(storage = globalThis.localStorage) {
  const raw = storage.getItem(APPLICATION_CONTEXT_KEY);
  if (raw === null || raw === undefined) return emptyApplicationContext();
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 32768) fail();
  try { return normalizeApplicationContext(JSON.parse(raw)); } catch { fail(); }
}
export function nextApplicationContext(previous, deviceId, packageName) {
  const current = normalizeApplicationContext(previous);
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 300 || /\s/u.test(deviceId) || hasControl(deviceId)
    || typeof packageName !== 'string' || packageName.length > 256 || !/^[A-Za-z0-9_.-]*$/.test(packageName)) fail();
  return normalizeApplicationContext({ version: 1, entries: [...current.entries.filter(item => item.deviceId !== deviceId),
    ...(packageName ? [{ deviceId, packageName }] : [])].slice(-20) });
}
export function saveApplicationContext(value, storage = globalThis.localStorage) {
  readApplicationContext(storage);
  const next = normalizeApplicationContext(value), raw = JSON.stringify(next);
  if (new TextEncoder().encode(raw).byteLength > 32768) fail();
  storage.setItem(APPLICATION_CONTEXT_KEY, raw); return next;
}
export function applicationForDevice(value, deviceId) {
  return value.entries.find(item => item.deviceId === deviceId)?.packageName || '';
}
