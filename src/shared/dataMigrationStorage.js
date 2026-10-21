import { normalizeDeviceShortcuts, SHORTCUTS_KEY } from './deviceNavigationShortcuts.js';
import { normalizePinnedDevices, PINNED_DEVICES_KEY } from './deviceDiscovery.js';
import { normalizePreferences as normalizeSerialPreferences, SERIAL_PREFS_KEY } from './serialSettings.js';

// Keep this list in sync with the main-process migration policy (covered by a contract test).
export const PORTABLE_PREF_KEYS = Object.freeze([
  'globalCommandSettings', 'autoUpdateEnabled', 'adb-workbench.favorite-packages.v1',
  'logFilterPresets.v1', 'adb-workbench.task-center.draft.v1', 'packageSearchVisible',
  'deviceNames', 'currentTheme', 'scrcpySettings', SHORTCUTS_KEY, PINNED_DEVICES_KEY, SERIAL_PREFS_KEY
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeValue(value, depth = 0) {
  if (depth > 48) throw new Error('本地偏好层级过深');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error('本地偏好包含不安全字段');
    assertSafeValue(item, depth + 1);
  }
}
function parsePreference(key, raw) {
  if (!PORTABLE_PREF_KEYS.includes(key) || typeof raw !== 'string') throw new Error('不支持的本地偏好');
  if (key === 'currentTheme') {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw new Error('主题名称无效');
    return raw;
  }
  const value = JSON.parse(raw);
  assertSafeValue(value);
  if (key === SHORTCUTS_KEY) return normalizeDeviceShortcuts(value);
  if (key === PINNED_DEVICES_KEY) return normalizePinnedDevices(value);
  if (key === SERIAL_PREFS_KEY) return normalizeSerialPreferences(value);
  if (['autoUpdateEnabled', 'packageSearchVisible'].includes(key)) {
    if (typeof value !== 'boolean') throw new Error('偏好开关无效');
  } else if (['adb-workbench.favorite-packages.v1', 'logFilterPresets.v1'].includes(key)) {
    if (!Array.isArray(value)) throw new Error('偏好列表无效');
  } else if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('偏好对象无效');
  if (key === 'deviceNames' && Object.values(value).some(name => typeof name !== 'string' || !name.trim())) throw new Error('设备别名无效');
  if (key === 'scrcpySettings' && (typeof value.screenOff !== 'boolean' || typeof value.stayAwake !== 'boolean'
    || !['2 Mbps', '4 Mbps', '8 Mbps', '16 Mbps', '32 Mbps'].includes(value.bitrate)
    || !['0', '1920', '1280', '1024', '720'].includes(value.maxSize))) throw new Error('投屏设置无效');
  return value;
}

export function collectMigrationPreferences(storage = globalThis.localStorage) {
  const preferences = {};
  for (const key of PORTABLE_PREF_KEYS) {
    const value = storage.getItem(key);
    if (value !== null && value !== undefined) {
      parsePreference(key, value);
      preferences[key] = value;
    }
  }
  return preferences;
}

export function applyMigrationPreferences(preferences, storage = globalThis.localStorage, removeKeys = []) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(preferences))) throw new Error('本地偏好数据无效');
  const entries = Object.entries(preferences);
  for (const [key, value] of entries) parsePreference(key, value);
  if (!Array.isArray(removeKeys) || removeKeys.some(key => !PORTABLE_PREF_KEYS.includes(key))) throw new Error('不允许移除该本地偏好');
  const touched = [...new Set([...removeKeys, ...entries.map(([key]) => key)])];
  const previous = new Map(touched.map(key => [key, storage.getItem(key)]));
  const changed = [];
  try {
    for (const key of removeKeys) {
      changed.push(key);
      storage.removeItem(key);
    }
    for (const [key, value] of entries) {
      changed.push(key);
      storage.setItem(key, value);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const key of [...new Set(changed.reverse())]) {
      try {
        const value = previous.get(key);
        if (storage.getItem(key) === value) continue;
        if (value === null || value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) throw new Error(`导入偏好失败，部分原偏好恢复失败：${rollbackErrors.join('；')}。原错误：${error.message}`);
    throw error;
  }
}

export function readMigratedPreference(key, fallback, storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(key);
    return raw === null || raw === undefined ? fallback : parsePreference(key, raw);
  } catch { return fallback; }
}
