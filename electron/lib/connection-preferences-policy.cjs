const { tr } = require('./localization.cjs');
const SSH_CONNECTION_MEMORY_KEY = 'adb-workbench.ssh-connections.v1';
const REPRODUCTION_CONFIG_KEY = 'adb-workbench.reproduction-config.v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function invalid() { throw new Error(tr('连接与采证偏好格式无效。')); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function text(value, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return value;
}
function normalizeSshConnectionMemory(value) {
  exact(value, ['version', 'profileId', 'search', 'recentIds']);
  if (value.version !== 1 || value.profileId !== '' && !UUID.test(value.profileId) || !Array.isArray(value.recentIds) || value.recentIds.length > 10 || Array.from(value.recentIds).some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(value.recentIds).size !== value.recentIds.length) invalid();
  return { version: 1, profileId: text(value.profileId, 36), search: text(value.search, 200), recentIds: [...value.recentIds] };
}
function normalizeReproductionConfig(value) {
  exact(value, ['version', 'title', 'deviceId', 'durationMs', 'selection']);
  const deviceId = text(value.deviceId, 160);
  if (value.version !== 1 || ![30000, 60000, 180000, 300000].includes(value.durationMs) || /\s/u.test(deviceId)) invalid();
  const selection = value.selection;
  exact(selection, ['video', 'logs', 'performance', 'serial', 'ssh']);
  if (['video', 'logs', 'performance'].some(key => typeof selection[key] !== 'boolean')) invalid();
  const next = { video: selection.video, logs: selection.logs, performance: selection.performance, serial: [], ssh: [] };
  for (const [kind, keys, limit] of [['serial', ['workspace', 'sessionId'], 2], ['ssh', ['sessionId', 'terminalId'], 4]]) {
    if (!Array.isArray(selection[kind]) || selection[kind].length > limit) invalid();
    next[kind] = Array.from(selection[kind], ref => { exact(ref, keys); return Object.fromEntries(keys.map(key => [key, text(ref[key], 180, false)])); });
    if (kind === 'serial' && next[kind].some(ref => !['rs232', 'terminal'].includes(ref.workspace)) || new Set(next[kind].map(ref => JSON.stringify(ref))).size !== next[kind].length) invalid();
  }
  return { version: 1, title: text(value.title, 100, false), deviceId, durationMs: value.durationMs, selection: next };
}
module.exports = { SSH_CONNECTION_MEMORY_KEY, REPRODUCTION_CONFIG_KEY, normalizeSshConnectionMemory, normalizeReproductionConfig };
