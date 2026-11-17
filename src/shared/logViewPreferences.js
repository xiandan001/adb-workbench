import { tr } from './i18n.js';

export const LOG_VIEW_PREFS_KEY = 'adb-workbench.log-view.v1';
export const LOG_VIEW_PREFS_LIMIT = 128 * 1024;
const quotas = [128, 256, 512, 1024].map(value => value * 1024 * 1024);
const exact = (value, fields, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && fields.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => fields.includes(key) || optional.includes(key));
const foldFields = ['scopeExpanded', 'usageExpanded', 'infoExpanded'];
const invalid = () => { throw new Error(tr('本地偏好数据无效')); };
export const defaultLogView = () => ({ sidebarOpen: false, aiPanelHeight: 440, detailWrap: true, colWidths: { ts: 140, pkg: 100, tag: 100 }, filter: {}, buffers: ['main'], scopeExpanded: false, usageExpanded: false, infoExpanded: false });
export const defaultLogViewPreferences = () => ({ version: 1, archive: { enabled: false, maxBytes: 512 * 1024 * 1024 }, views: [] });
export function normalizeLogViewFilter(value) {
  const fields = ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'domain', 'minLevel', 'pid'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) invalid();
  const filter = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'pid') { if (!Number.isSafeInteger(item) || item < 0 || item > 2147483647) invalid(); filter.pid = item; continue; }
    if (typeof item !== 'string' || item.length > 1024 || [...item].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
    if (key === 'minLevel' && item && !['V', 'D', 'I', 'W', 'E', 'F', 'A'].includes(item)) invalid();
    if (key === 'regexFlags' && !/^[imsuyg]*$/.test(item)) invalid();
    if (item) filter[key] = item;
  }
  return filter;
}
function normalizeBuffers(value) {
  if (!Array.isArray(value) || value.length > 10 || new Set(value).size !== value.length
    || value.some(item => !['main', 'system', 'radio', 'events', 'crash', 'kernel', 'app', 'core', 'init', 'kmsg'].includes(item))) invalid();
  return [...value];
}

export function normalizeLogViewPreferences(value) {
  if (!exact(value, ['version', 'archive', 'views']) || value.version !== 1 || !exact(value.archive, ['enabled', 'maxBytes'])
    || typeof value.archive.enabled !== 'boolean' || !quotas.includes(value.archive.maxBytes) || !Array.isArray(value.views) || value.views.length > 20) invalid();
  const seen = new Set();
  const views = value.views.map(view => {
    const legacy = exact(view, ['deviceId', 'source', 'sidebarOpen', 'aiPanelHeight', 'detailWrap', 'colWidths'], foldFields);
    if ((!legacy && !exact(view, ['deviceId', 'source', 'sidebarOpen', 'aiPanelHeight', 'detailWrap', 'colWidths', 'filter', 'buffers'], foldFields))
      || foldFields.some(key => Object.hasOwn(view, key) && typeof view[key] !== 'boolean') || typeof view.deviceId !== 'string'
      || view.deviceId.length > 300 || /\s/u.test(view.deviceId) || [...view.deviceId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || !['realtime', 'file'].includes(view.source) || typeof view.sidebarOpen !== 'boolean' || typeof view.detailWrap !== 'boolean'
      || !Number.isInteger(view.aiPanelHeight) || view.aiPanelHeight < 240 || view.aiPanelHeight > 800 || !exact(view.colWidths, ['ts', 'pkg', 'tag'])) invalid();
    for (const [key, min, max] of [['ts', 100, 220], ['pkg', 60, 200], ['tag', 50, 200]]) {
      if (!Number.isInteger(view.colWidths[key]) || view.colWidths[key] < min || view.colWidths[key] > max) invalid();
    }
    const key = JSON.stringify([view.deviceId, view.source]); if (seen.has(key)) invalid(); seen.add(key);
    return { deviceId: view.deviceId, source: view.source, sidebarOpen: view.sidebarOpen, aiPanelHeight: view.aiPanelHeight,
      detailWrap: view.detailWrap, colWidths: { ...view.colWidths }, filter: normalizeLogViewFilter(legacy ? {} : view.filter), buffers: normalizeBuffers(legacy ? ['main'] : view.buffers),
      scopeExpanded: view.scopeExpanded ?? false, usageExpanded: view.usageExpanded ?? false, infoExpanded: view.infoExpanded ?? false };
  });
  return { version: 1, archive: { ...value.archive }, views };
}

export function readLogViewPreferences(storage = globalThis.localStorage) {
  const raw = storage.getItem(LOG_VIEW_PREFS_KEY); if (raw == null) return defaultLogViewPreferences();
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > LOG_VIEW_PREFS_LIMIT) invalid();
  try { return normalizeLogViewPreferences(JSON.parse(raw)); } catch { invalid(); }
}
export function saveLogViewPreferences(value, storage = globalThis.localStorage) {
  readLogViewPreferences(storage);
  const next = normalizeLogViewPreferences(value), raw = JSON.stringify(next);
  if (new TextEncoder().encode(raw).byteLength > LOG_VIEW_PREFS_LIMIT) invalid();
  if (storage.getItem(LOG_VIEW_PREFS_KEY) !== raw) storage.setItem(LOG_VIEW_PREFS_KEY, raw);
  return next;
}
export function logViewFor(value, deviceId, source) {
  const view = normalizeLogViewPreferences(value).views.find(item => item.deviceId === deviceId && item.source === source);
  if (!view) return defaultLogView();
  const { sidebarOpen, aiPanelHeight, detailWrap, colWidths, filter, buffers, scopeExpanded, usageExpanded, infoExpanded } = view;
  return { sidebarOpen, aiPanelHeight, detailWrap, colWidths: { ...colWidths }, filter: { ...filter }, buffers: [...buffers], scopeExpanded, usageExpanded, infoExpanded };
}
export function updateLogView(value, deviceId, source, changes) {
  const previous = normalizeLogViewPreferences(value), view = { ...logViewFor(previous, deviceId, source), ...changes };
  return normalizeLogViewPreferences({ ...previous, views: [...previous.views.filter(item => item.deviceId !== deviceId || item.source !== source), { deviceId, source, ...view }].slice(-20) });
}
