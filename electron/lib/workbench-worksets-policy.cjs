const { tr } = require('./localization.cjs');
const FILE_NAME = 'workbench-worksets.json';
const MAX_BYTES = 256 * 1024, MAX_ITEMS = 20;
const UI_WORKSPACE_KEY = 'adb-workbench.ui-workspace.v1';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PAGES = ['devices', 'serial', 'ssh', 'troubleshoot', 'quality', 'tasks', 'performance', 'ai-workspace'];
const FILTER_KEYS = ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'domain', 'minLevel', 'pid'];
const BUFFERS = ['main', 'system', 'radio', 'events', 'crash', 'kernel', 'app', 'core', 'init', 'kmsg'];
const fail = () => { throw new Error(tr('工作集数据无效，原文件已保留。')); };
function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
function text(value, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function device(value) { text(value, 300); if (/\s/u.test(value)) fail(); return value; }
function packageName(value) { text(value, 256); if (!/^[A-Za-z0-9_.-]*$/.test(value)) fail(); return value; }
function normalizeLogs(value) {
  shape(value, ['deviceId', 'filter', 'buffers']); device(value.deviceId);
  shape(value.filter, [], FILTER_KEYS);
  const filter = {};
  for (const [key, item] of Object.entries(value.filter)) {
    if (key === 'pid') { if (!Number.isSafeInteger(item) || item < 0 || item > 2147483647) fail(); filter.pid = item; }
    else filter[key] = text(item, 4096);
  }
  if (!Array.isArray(value.buffers) || !value.buffers.length || value.buffers.length > BUFFERS.length
    || value.buffers.some(item => !BUFFERS.includes(item)) || new Set(value.buffers).size !== value.buffers.length) fail();
  return { deviceId: value.deviceId, filter, buffers: [...value.buffers] };
}
function normalizePart(part, value) {
  if (!['application', 'logs', 'ssh', 'serial'].includes(part)) fail();
  if (value === null) return null;
  if (part === 'logs') return normalizeLogs(value);
  if (part === 'application') { shape(value, ['deviceId', 'packageName']); return { deviceId: device(value.deviceId), packageName: packageName(value.packageName) }; }
  if (part === 'ssh') { shape(value, ['profileId']); if (!UUID.test(value.profileId)) fail(); return { profileId: value.profileId }; }
  shape(value, ['workspace', 'schemeId']);
  if (!['rs232', 'terminal'].includes(value.workspace)) fail();
  return { workspace: value.workspace, schemeId: text(value.schemeId, 200, false) };
}
const emptyContext = () => ({ application: null, logs: null, ssh: null, serial: null });
function normalizeContext(value) {
  shape(value, ['application', 'logs', 'ssh', 'serial']);
  return Object.fromEntries(Object.keys(emptyContext()).map(part => [part, normalizePart(part, value[part])]));
}
function normalizeWorkset(value) {
  shape(value, ['id', 'name', 'deviceId', 'packageName', 'page', 'logs', 'ssh', 'serial', 'createdAt', 'updatedAt']);
  if (!UUID.test(value.id) || !PAGES.includes(value.page)) fail();
  const name = text(value.name, 80, false).trim();
  for (const key of ['createdAt', 'updatedAt']) if (typeof value[key] !== 'string' || value[key].length > 40 || !Number.isFinite(Date.parse(value[key]))) fail();
  const result = { id: value.id, name, deviceId: device(value.deviceId), packageName: packageName(value.packageName), page: value.page,
    logs: normalizePart('logs', value.logs), ssh: normalizePart('ssh', value.ssh), serial: normalizePart('serial', value.serial), createdAt: value.createdAt, updatedAt: value.updatedAt };
  if (result.logs && result.logs.deviceId !== result.deviceId) fail();
  return result;
}
const emptyStore = () => ({ version: 1, items: [], context: emptyContext() });
function normalizeStore(value) {
  shape(value, ['version', 'items', 'context']);
  if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS || value.items.some((_, index) => !Object.hasOwn(value.items, index))) fail();
  const items = Array.from(value.items, normalizeWorkset);
  if (items.length !== new Set(items.map(item => item.id)).size || items.length !== new Set(items.map(item => item.name.toLocaleLowerCase())).size) fail();
  const result = { version: 1, items, context: normalizeContext(value.context) };
  if (Buffer.byteLength(JSON.stringify(result) + '\n', 'utf8') > MAX_BYTES) fail();
  return result;
}
function normalizeSave(value) {
  shape(value, ['name', 'deviceId', 'packageName', 'page'], ['id']);
  if (!PAGES.includes(value.page) || value.id !== undefined && !UUID.test(value.id)) fail();
  return { ...(value.id ? { id: value.id } : {}), name: text(value.name, 80, false).trim(), deviceId: device(value.deviceId), packageName: packageName(value.packageName), page: value.page };
}
function normalizeUiWorkspace(value) {
  shape(value, ['version', 'density', 'expandedDeviceIds', 'deviceQuery', 'scrollPositions']);
  if (value.version !== 1 || !['full', 'compact'].includes(value.density) || !Array.isArray(value.expandedDeviceIds) || value.expandedDeviceIds.length > 100) fail();
  const expandedDeviceIds = Array.from(value.expandedDeviceIds, id => { if (!device(id)) fail(); return id; });
  if (new Set(expandedDeviceIds).size !== expandedDeviceIds.length) fail();
  shape(value.scrollPositions, [], [...PAGES, 'history', 'settings', 'member', 'artifacts', 'ai-tools']);
  for (const offset of Object.values(value.scrollPositions)) if (!Number.isFinite(offset) || offset < 0 || offset > 10000000) fail();
  return { version: 1, density: value.density, expandedDeviceIds, deviceQuery: text(value.deviceQuery, 300), scrollPositions: { ...value.scrollPositions } };
}
module.exports = { FILE_NAME, MAX_BYTES, MAX_ITEMS, UI_WORKSPACE_KEY, PAGES, emptyStore, emptyContext, normalizePart, normalizeContext, normalizeWorkset, normalizeStore, normalizeSave, normalizeUiWorkspace };
