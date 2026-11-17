import { tr } from './i18n.js';

export const ACTIVITY_DISMISSALS_KEY = 'adb-workbench.activity-dismissals.v1';
export const ACTIVITY_DISMISSALS_LIMIT = 2048;
const MAX_BYTES = 200 * 1024;
export const activityRunning = status => ['running', 'queued', 'starting', 'recording', 'stopping', 'saving', 'cancelling'].includes(status);
export const activityTimestamp = value => Number.isFinite(value) ? Math.max(0, value) : Math.max(0, Date.parse(value) || 0);
const invalid = () => { throw Error(tr('活动记录偏好无法读取，原数据已保留。')); };
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key)) || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid();
}
export function normalizeActivityDismissals(value) {
  fields(value, ['version', 'entries']);
  if (value.version !== 1 || !Array.isArray(value.entries) || Object.getPrototypeOf(value.entries) !== Array.prototype || Reflect.ownKeys(value.entries).length !== value.entries.length + 1) invalid();
  if (value.entries.length > ACTIVITY_DISMISSALS_LIMIT) throw Error(tr('已移除记录达到 2048 条上限，本次未移除任何记录。'));
  const seen = new Set(), entries = [];
  for (let index = 0; index < value.entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.entries, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const item = descriptor.value; fields(item, ['key', 'through']);
    if (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key) || seen.has(item.key) || !Number.isSafeInteger(item.through) || item.through < 0) invalid();
    seen.add(item.key); entries.push({ key: item.key, through: item.through });
  }
  const next = { version: 1, entries };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_BYTES) invalid();
  return next;
}
export function readActivityDismissals(storage = globalThis.localStorage) {
  const raw = storage.getItem(ACTIVITY_DISMISSALS_KEY);
  if (raw == null) return { version: 1, entries: [] };
  try { if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_BYTES) invalid(); return normalizeActivityDismissals(JSON.parse(raw)); }
  catch { invalid(); }
}
export function recordActivityDismissals(rows, storage = globalThis.localStorage) {
  const current = readActivityDismissals(storage), entries = new Map(current.entries.map(item => [item.key, item.through]));
  for (const row of rows) if (!row.active) entries.set(row.key, Math.max(entries.get(row.key) || 0, row.through));
  const next = normalizeActivityDismissals({ version: 1, entries: [...entries].map(([key, through]) => ({ key, through })) });
  try { storage.setItem(ACTIVITY_DISMISSALS_KEY, JSON.stringify(next)); }
  catch { throw Error(tr('活动记录未能移除，请重试；当前列表和原数据保持不变。')); }
  return next;
}
export function isActivityDismissed(item, preferences) {
  return !item.active && preferences.entries.some(entry => entry.key === item.key && item.through <= entry.through);
}

function identify(item) {
  const kind = item.activityKind || item.kind || 'registry';
  const externalKind = ['task', 'guard', 'recording', 'inspection', 'performance'].includes(kind);
  const id = externalKind ? item.target?.id || item.id : item.id;
  return JSON.stringify([1, kind, String(id || '')]);
}
export function buildActivityItems({ registry = { items: [] }, external = { tasks: [], guards: [], recordings: [] }, tasks = [] }) {
  const rows = registry.items.map(item => ({ ...item, target: item.target || { page: 'devices' }, active: activityRunning(item.status) || item.canCancel === true }));
  for (const task of external.tasks) rows.push({ id: `task:${task.id}`, activityKind: 'task', title: task.scriptName || tr('任务中心'), status: task.status === 'success' ? 'completed' : task.status, stage: task.error || '',
    active: task.activityActive === true || activityRunning(task.status), startedAt: activityTimestamp(task.startedAt || task.createdAt), endedAt: activityTimestamp(task.endedAt), updatedAt: activityTimestamp(task.endedAt || task.startedAt || task.createdAt), target: { page: 'tasks', id: task.id } });
  for (const guard of external.guards) rows.push({ id: `guard:${guard.id}`, activityKind: 'guard', title: tr('设备守护'), status: guard.activityActive ? guard.status : guard.error ? 'failed' : 'completed', stage: guard.error || '', deviceId: guard.deviceId,
    active: guard.activityActive === true || activityRunning(guard.status), startedAt: activityTimestamp(guard.startedAt), endedAt: activityTimestamp(guard.endedAt), updatedAt: activityTimestamp(guard.endedAt || guard.startedAt), target: { page: 'quality', id: guard.id, deviceId: guard.deviceId } });
  for (const record of external.recordings) rows.push({ id: `recording:${record.id}`, activityKind: 'recording', title: tr('录屏'), status: record.status === 'saved' ? 'completed' : ['error', 'needs-save'].includes(record.status) ? 'failed' : record.status, stage: record.error || '', deviceId: record.deviceId,
    active: activityRunning(record.status) || !['saved', 'error', 'needs-save', 'completed', 'failed', 'cancelled'].includes(record.status) && !record.endedAt,
    startedAt: activityTimestamp(record.startedAt), endedAt: activityTimestamp(record.endedAt), updatedAt: activityTimestamp(record.savedAt || record.endedAt || record.startedAt), target: { page: 'devices', id: record.id, deviceId: record.deviceId } });
  for (const task of tasks) rows.push({ id: `legacy:${task.id || task.key}`, activityKind: task.key === 'inspection' ? 'inspection' : task.key === 'performanceReport' ? 'performance' : 'legacy', title: task.title, status: task.status === 'success' ? 'completed' : task.status, stage: task.message, deviceId: task.deviceId,
    active: activityRunning(task.status), startedAt: activityTimestamp(task.startedAt || task.createdAt), endedAt: activityTimestamp(task.endedAt), updatedAt: activityTimestamp(task.endedAt || task.startedAt || task.createdAt), target: { page: task.tab, id: task.id || task.key, deviceId: task.deviceId } });
  const merged = new Map();
  for (const row of rows) {
    const identity = identify(row), through = Math.floor(Math.max(activityTimestamp(row.startedAt), activityTimestamp(row.endedAt), activityTimestamp(row.updatedAt))), previous = merged.get(identity);
    const preferred = !previous || row.active && !previous.active || row.active === previous.active && through > previous.through ? row : previous;
    merged.set(identity, { ...preferred, identity, through: Math.max(through, previous?.through || 0), active: row.active || previous?.active || false });
  }
  return [...merged.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.through - a.through);
}
export async function prepareActivityItems(items, occurrences = new Map(), cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw Error(tr('活动记录暂时无法读取，请重新打开后台活动。'));
  const current = new Set(items.map(item => item.identity));
  for (const key of occurrences.keys()) if (!current.has(key)) occurrences.delete(key);
  return Promise.all(items.map(async item => {
    const previous = occurrences.get(item.identity);
    const generation = !item.through && item.active && previous && !previous.active ? cryptoApi.randomUUID() : previous?.generation || '';
    occurrences.set(item.identity, { active: item.active, generation });
    const bytes = new TextEncoder().encode(JSON.stringify([item.identity, generation]));
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes), key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return { ...item, key };
  }));
}
