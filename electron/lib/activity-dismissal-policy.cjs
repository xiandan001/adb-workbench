const { tr } = require('./localization.cjs');

const ACTIVITY_DISMISSALS_KEY = 'adb-workbench.activity-dismissals.v1';
const ACTIVITY_DISMISSALS_BYTES = 200 * 1024;
const invalid = () => { throw Error(tr('活动记录偏好无法读取，原数据已保留。')); };
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key)) || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid();
}
function normalizeActivityDismissals(value) {
  fields(value, ['version', 'entries']);
  if (value.version !== 1 || !Array.isArray(value.entries) || Object.getPrototypeOf(value.entries) !== Array.prototype || Reflect.ownKeys(value.entries).length !== value.entries.length + 1) invalid();
  if (value.entries.length > 2048) throw Error(tr('已移除记录达到 2048 条上限，本次未移除任何记录。'));
  const seen = new Set(), entries = [];
  for (let index = 0; index < value.entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.entries, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const item = descriptor.value; fields(item, ['key', 'through']);
    if (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key) || seen.has(item.key) || !Number.isSafeInteger(item.through) || item.through < 0) invalid();
    seen.add(item.key); entries.push({ key: item.key, through: item.through });
  }
  const next = { version: 1, entries };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ACTIVITY_DISMISSALS_BYTES) invalid();
  return next;
}
module.exports = { ACTIVITY_DISMISSALS_KEY, ACTIVITY_DISMISSALS_BYTES, normalizeActivityDismissals };
