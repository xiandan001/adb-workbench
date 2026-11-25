import { tr } from './i18n.js';
import tcl from '../../electron/lib/rs232-protocol-tcl.json' with { type: 'json' };

export const RS232_PROTOCOL_PREFS_KEY = 'adb-workbench.rs232-protocol.v1';
export const RS232_PROTOCOL_PREFS_LIMIT = 512 * 1024;
const invalid = () => { throw new Error(tr('RS232 协议配置无效，原数据已保留。')); };
const oversized = () => { throw new Error(tr('RS232 协议配置超过 512 KiB，原数据已保留。')); };
const tclIds = new Set(tcl.commands.map(command => command.id));
export const isTclProtocolId = id => tclIds.has(id);
const builtin = id => typeof id === 'string' && (isTclProtocolId(id) || /^lango-[0-9]{3}$/.test(id) && Number(id.slice(6)) >= 1 && Number(id.slice(6)) <= 111 || /^lango-report-[1-4]$/.test(id));
const custom = id => typeof id === 'string' && /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors[key] || {}, 'value') || !descriptors[key].enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function items(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output.push(descriptor.value);
  }
  return output;
}
function text(value, limit, required = false, multiline = false) {
  if (typeof value !== 'string' || value.length > limit || required && !value.trim()) invalid();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index); if (code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code))) invalid();
  }
  return value;
}
export const defaultProtocolPreferences = () => ({ version: 1, overrides: [], removed: [] });
export function normalizeProtocolPreferences(value) {
  const root = fields(value, ['version', 'overrides', 'removed']); if (root.version !== 1) invalid();
  const seen = new Set();
  const overrides = items(root.overrides, 256).map(item => {
    const entry = fields(item, ['id', 'name', 'category', 'template', 'note', 'reviewed']);
    if ((!builtin(entry.id) && !custom(entry.id)) || seen.has(entry.id) || typeof entry.reviewed !== 'boolean') invalid();
    seen.add(entry.id);
    return { id: entry.id, name: text(entry.name, 80, true), category: text(entry.category, 40, true),
      template: text(entry.template, 8192, true, true), note: text(entry.note, 2000, false, true), reviewed: entry.reviewed };
  });
  const removed = items(root.removed, 115 + tclIds.size); if (new Set(removed).size !== removed.length || removed.some(id => !builtin(id))) invalid();
  const next = { version: 1, overrides, removed };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > RS232_PROTOCOL_PREFS_LIMIT) oversized();
  return next;
}
export function readProtocolPreferences(storage) {
  let raw;
  try { raw = (storage === undefined ? globalThis.localStorage : storage).getItem(RS232_PROTOCOL_PREFS_KEY); }
  catch { throw new Error(tr('RS232 协议配置读取失败，原数据未修改。')); }
  if (raw == null) return defaultProtocolPreferences();
  if (typeof raw !== 'string') invalid();
  if (new TextEncoder().encode(raw).byteLength > RS232_PROTOCOL_PREFS_LIMIT) oversized();
  try { return normalizeProtocolPreferences(JSON.parse(raw)); } catch { invalid(); }
}
export function saveProtocolPreferences(value, storage) {
  let target;
  try { target = storage === undefined ? globalThis.localStorage : storage; }
  catch { throw new Error(tr('RS232 协议配置读取失败，原数据未修改。')); }
  readProtocolPreferences(target);
  const next = normalizeProtocolPreferences(value);
  try { target.setItem(RS232_PROTOCOL_PREFS_KEY, JSON.stringify(next)); }
  catch { throw new Error(tr('RS232 协议配置保存失败，原数据已保留。')); }
  return next;
}
export function upsertProtocolCommand(preferences, command) {
  const current = normalizeProtocolPreferences(preferences), entry = normalizeProtocolPreferences({ version: 1, overrides: [command], removed: [] }).overrides[0];
  const exists = current.overrides.some(item => item.id === entry.id);
  return normalizeProtocolPreferences({ version: 1, overrides: exists ? current.overrides.map(item => item.id === entry.id ? entry : item) : [...current.overrides, entry],
    removed: current.removed.filter(id => id !== entry.id) });
}
export function removeProtocolCommand(preferences, id) {
  const current = normalizeProtocolPreferences(preferences); if (!builtin(id) && !custom(id)) invalid();
  return normalizeProtocolPreferences({ version: 1, overrides: builtin(id) ? current.overrides : current.overrides.filter(item => item.id !== id),
    removed: builtin(id) && !current.removed.includes(id) ? [...current.removed, id] : current.removed });
}
export function restoreProtocolCommand(preferences, id) {
  const current = normalizeProtocolPreferences(preferences); if (!builtin(id)) invalid();
  return normalizeProtocolPreferences({ version: 1, overrides: current.overrides.filter(item => item.id !== id), removed: current.removed.filter(item => item !== id) });
}
