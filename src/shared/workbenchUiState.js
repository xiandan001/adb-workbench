import { tr } from './i18n.js';
export const UI_WORKSPACE_KEY = 'adb-workbench.ui-workspace.v1';
const PAGES = ['devices', 'serial', 'ssh', 'troubleshoot', 'quality', 'tasks', 'performance', 'ai-workspace', 'history', 'settings', 'member', 'artifacts', 'ai-tools'];
export const defaultUiWorkspace = () => ({ version: 1, density: 'full', expandedDeviceIds: [], deviceQuery: '', scrollPositions: {} });
const fail = () => { throw new Error(tr('界面现场设置无效，原数据已保留。')); };
const hasControl = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
export function normalizeUiWorkspace(value) {
  const fields = ['version', 'density', 'expandedDeviceIds', 'deviceQuery', 'scrollPositions'];
  if (!plain(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) || value.version !== 1
    || !['full', 'compact'].includes(value.density) || !Array.isArray(value.expandedDeviceIds) || value.expandedDeviceIds.length > 100) fail();
  const expandedDeviceIds = Array.from(value.expandedDeviceIds, id => {
    if (typeof id !== 'string' || !id || id.length > 300 || /\s/u.test(id) || hasControl(id)) fail(); return id;
  });
  if (new Set(expandedDeviceIds).size !== expandedDeviceIds.length || typeof value.deviceQuery !== 'string' || value.deviceQuery.length > 300 || hasControl(value.deviceQuery)
    || !plain(value.scrollPositions) || Object.keys(value.scrollPositions).some(key => !PAGES.includes(key))
    || Object.values(value.scrollPositions).some(offset => !Number.isFinite(offset) || offset < 0 || offset > 10000000)) fail();
  return { version: 1, density: value.density, expandedDeviceIds, deviceQuery: value.deviceQuery, scrollPositions: { ...value.scrollPositions } };
}
export function readUiWorkspace(storage = globalThis.localStorage) {
  const raw = storage.getItem(UI_WORKSPACE_KEY);
  if (raw === null || raw === undefined) return defaultUiWorkspace();
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 128 * 1024) fail();
  try { return normalizeUiWorkspace(JSON.parse(raw)); } catch { fail(); }
}
export function saveUiWorkspace(value, storage = globalThis.localStorage) {
  readUiWorkspace(storage);
  const next = normalizeUiWorkspace(value), raw = JSON.stringify(next);
  if (new TextEncoder().encode(raw).byteLength > 128 * 1024) fail();
  if (storage.getItem(UI_WORKSPACE_KEY) !== raw) storage.setItem(UI_WORKSPACE_KEY, raw);
  return next;
}
export function recentWirelessEntries(history, limit = 3) {
  const result = [], seen = new Set();
  for (const item of history) {
    if (item.type !== 'wifi' || typeof item.deviceId !== 'string' || !item.deviceId || seen.has(item.deviceId)) continue;
    seen.add(item.deviceId); result.push(item); if (result.length >= limit) break;
  }
  return result;
}
