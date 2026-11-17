const { tr } = require('./localization.cjs');

const LOG_VIEW_PREFS_KEY = 'adb-workbench.log-view.v1';
const LOG_VIEW_PREFS_LIMIT = 128 * 1024;
const quotas = [128, 256, 512, 1024].map(value => value * 1024 * 1024);
const exact = (value, fields, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && fields.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => fields.includes(key) || optional.includes(key));
const foldFields = ['scopeExpanded', 'usageExpanded', 'infoExpanded'];
const invalid = () => { throw new Error(tr('本地偏好数据无效')); };
function normalizeLogViewFilter(value) {
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

function normalizeLogViewPreferences(value) {
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

module.exports = { LOG_VIEW_PREFS_KEY, LOG_VIEW_PREFS_LIMIT, normalizeLogViewPreferences };
