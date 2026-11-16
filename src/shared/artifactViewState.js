import { tr } from './i18n.js';

export const ARTIFACT_VIEW_KEY = 'adb-workbench.artifact-view.v1';
const TYPES = new Set(['all', 'troubleshooting', 'inspection', 'regression', 'deviceGuard', 'performance', 'task', 'reproduction']);
const ORDERS = new Set(['newest', 'oldest', 'size']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const invalid = () => { throw Object.assign(new Error(tr('产物查看设置无效，原数据已保留。')), { code: 'ARTIFACT_VIEW_INVALID' }); };
export const defaultArtifactView = () => ({ query: '', typeFilter: 'all', sortOrder: 'newest', visibleCount: 30 });

export function normalizeArtifactViewState(value) {
  if (!exact(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 20) invalid();
  const seen = new Set();
  const entries = value.entries.map(entry => {
    if (!exact(entry, ['deviceId', 'query', 'typeFilter', 'sortOrder', 'visibleCount']) || !text(entry.deviceId, 300)
      || seen.has(entry.deviceId) || !text(entry.query, 300) || !TYPES.has(entry.typeFilter) || !ORDERS.has(entry.sortOrder)
      || !Number.isSafeInteger(entry.visibleCount) || entry.visibleCount < 30 || entry.visibleCount > 3000 || entry.visibleCount % 30) invalid();
    seen.add(entry.deviceId);
    return { deviceId: entry.deviceId, query: entry.query, typeFilter: entry.typeFilter, sortOrder: entry.sortOrder, visibleCount: entry.visibleCount };
  });
  const result = { version: 1, entries };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 128 * 1024) invalid();
  return result;
}

function readDocument(storage) {
  const raw = storage.getItem(ARTIFACT_VIEW_KEY);
  if (raw === null || raw === undefined) return { version: 1, entries: [] };
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 128 * 1024) invalid();
  let value;
  try { value = JSON.parse(raw); } catch { throw Object.assign(new Error(tr('产物查看设置异常，原数据已保留。')), { code: 'ARTIFACT_VIEW_CORRUPT' }); }
  return normalizeArtifactViewState(value);
}

export function readArtifactView(deviceId = '', storage = globalThis.localStorage) {
  if (!text(deviceId, 300)) invalid();
  const entry = readDocument(storage).entries.find(item => item.deviceId === deviceId);
  if (!entry) return defaultArtifactView();
  const { query, typeFilter, sortOrder, visibleCount } = entry;
  return { query, typeFilter, sortOrder, visibleCount };
}

export function saveArtifactView(deviceId, value, storage = globalThis.localStorage) {
  if (!text(deviceId, 300) || !exact(value, ['query', 'typeFilter', 'sortOrder', 'visibleCount'])
    || !Number.isSafeInteger(value.visibleCount) || value.visibleCount < 30 || value.visibleCount > 1000000 || value.visibleCount % 30) invalid();
  const previous = readDocument(storage);
  const view = { ...value, visibleCount: Math.min(3000, value.visibleCount) };
  const result = normalizeArtifactViewState({ version: 1, entries: [...previous.entries.filter(item => item.deviceId !== deviceId), { deviceId, ...view }].slice(-20) });
  storage.setItem(ARTIFACT_VIEW_KEY, JSON.stringify(result));
  return view;
}
