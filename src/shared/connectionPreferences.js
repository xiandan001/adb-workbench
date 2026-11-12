import { tr } from './i18n.js';

export const SSH_CONNECTION_MEMORY_KEY = 'adb-workbench.ssh-connections.v1';
export const REPRODUCTION_CONFIG_KEY = 'adb-workbench.reproduction-config.v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(tr('连接与采证偏好格式无效。'));
}
function text(value, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(tr('连接与采证偏好格式无效。'));
  return value;
}
export const defaultSshConnectionMemory = () => ({ version: 1, profileId: '', search: '', recentIds: [] });
export function normalizeSshConnectionMemory(value) {
  exact(value, ['version', 'profileId', 'search', 'recentIds']);
  if (value.version !== 1 || value.profileId !== '' && !UUID.test(value.profileId) || !Array.isArray(value.recentIds) || value.recentIds.length > 10 || Array.from(value.recentIds).some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(value.recentIds).size !== value.recentIds.length) throw new Error(tr('连接与采证偏好格式无效。'));
  return { version: 1, profileId: text(value.profileId, 36), search: text(value.search, 200), recentIds: [...value.recentIds] };
}
export function selectSshProfile(memory, profileId) {
  return normalizeSshConnectionMemory({ ...memory, profileId, recentIds: profileId ? [profileId, ...memory.recentIds.filter(id => id !== profileId)].slice(0, 10) : memory.recentIds });
}
export function filterSshProfiles(profiles, memory) {
  const keyword = memory.search.trim().toLowerCase();
  const rank = id => { const index = memory.recentIds.indexOf(id); return index < 0 ? 10 : index; };
  return profiles.filter(profile => !keyword || [profile.name, profile.host, profile.username, profile.port].some(value => String(value || '').toLowerCase().includes(keyword)))
    .sort((a, b) => rank(a.id) - rank(b.id));
}
export const defaultReproductionConfig = () => ({ version: 1, title: tr('问题复现'), deviceId: '', durationMs: 60000, selection: { video: false, logs: false, performance: false, serial: [], ssh: [] } });
export function normalizeReproductionConfig(value) {
  exact(value, ['version', 'title', 'deviceId', 'durationMs', 'selection']);
  const deviceId = text(value.deviceId, 160);
  if (value.version !== 1 || ![30000, 60000, 180000, 300000].includes(value.durationMs) || /\s/u.test(deviceId)) throw new Error(tr('连接与采证偏好格式无效。'));
  const selection = value.selection;
  exact(selection, ['video', 'logs', 'performance', 'serial', 'ssh']);
  if (['video', 'logs', 'performance'].some(key => typeof selection[key] !== 'boolean')) throw new Error(tr('连接与采证偏好格式无效。'));
  const next = { video: selection.video, logs: selection.logs, performance: selection.performance, serial: [], ssh: [] };
  for (const [kind, keys, limit] of [['serial', ['workspace', 'sessionId'], 2], ['ssh', ['sessionId', 'terminalId'], 4]]) {
    if (!Array.isArray(selection[kind]) || selection[kind].length > limit) throw new Error(tr('连接与采证偏好格式无效。'));
    next[kind] = Array.from(selection[kind], ref => { exact(ref, keys); return Object.fromEntries(keys.map(key => [key, text(ref[key], 180, false)])); });
    if (kind === 'serial' && next[kind].some(ref => !['rs232', 'terminal'].includes(ref.workspace)) || new Set(next[kind].map(ref => JSON.stringify(ref))).size !== next[kind].length) throw new Error(tr('连接与采证偏好格式无效。'));
  }
  return { version: 1, title: text(value.title, 100, false), deviceId, durationMs: value.durationMs, selection: next };
}
export function revalidateReproductionConfig(value, devices, sources) {
  const next = normalizeReproductionConfig(value);
  next.deviceId = devices.some(device => device.id === next.deviceId && device.status === 'device') ? next.deviceId : '';
  next.selection.serial = next.selection.serial.filter(ref => sources.serial.some(item => item.workspace === ref.workspace && item.sessionId === ref.sessionId));
  next.selection.ssh = next.selection.ssh.filter(ref => sources.ssh.some(item => item.sessionId === ref.sessionId && item.terminalId === ref.terminalId));
  return next;
}
function read(key, normalize, fallback, storage) {
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined) return fallback();
  try { if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 16384) throw new Error(); return normalize(JSON.parse(raw)); }
  catch { throw new Error(tr('连接与采证偏好数据异常，原内容已保留。')); }
}
function save(key, normalize, fallback, value, storage) {
  const next = normalize(value);
  read(key, normalize, fallback, storage);
  const raw = JSON.stringify(next);
  if (new TextEncoder().encode(raw).length > 16384) throw new Error(tr('连接与采证偏好格式无效。'));
  storage.setItem(key, raw);
  return next;
}
export const readSshConnectionMemory = (storage = globalThis.localStorage) => read(SSH_CONNECTION_MEMORY_KEY, normalizeSshConnectionMemory, defaultSshConnectionMemory, storage);
export const saveSshConnectionMemory = (value, storage = globalThis.localStorage) => save(SSH_CONNECTION_MEMORY_KEY, normalizeSshConnectionMemory, defaultSshConnectionMemory, value, storage);
export const readReproductionConfig = (storage = globalThis.localStorage) => read(REPRODUCTION_CONFIG_KEY, normalizeReproductionConfig, defaultReproductionConfig, storage);
export const saveReproductionConfig = (value, storage = globalThis.localStorage) => save(REPRODUCTION_CONFIG_KEY, normalizeReproductionConfig, defaultReproductionConfig, value, storage);
