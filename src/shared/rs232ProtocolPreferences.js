import { tr } from './i18n.js';
import catalog from '../../electron/lib/rs232-protocol-catalog.json' with { type: 'json' };
import tcl from '../../electron/lib/rs232-protocol-tcl.json' with { type: 'json' };

export const RS232_PROTOCOL_PREFS_KEY = 'adb-workbench.rs232-protocol.v1';
export const RS232_PROTOCOL_PREFS_LIMIT = 512 * 1024;
const invalid = () => { throw new Error(tr('RS232 协议配置无效，原数据已保留。')); };
const oversized = () => { throw new Error(tr('RS232 协议配置超过 512 KiB，原数据已保留。')); };
const tclIds = new Set(tcl.commands.map(command => command.id));
const builtinCommands = new Map([...catalog.commands, ...tcl.commands].map(command => [command.id, command]));
const commandFields = ['id', 'name', 'category', 'template', 'note', 'reviewed'];
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
export function normalizeProtocolParameterOverrides(value, id, template) {
  const entries = items(value, 32);
  if (entries.length === 0) return [];
  const placeholders = new Set(template.trim().split(/\s+/u).map(token => token.match(/^\{([A-Za-z][A-Za-z0-9_]{0,31})\}$/)?.[1]).filter(Boolean));
  const base = builtinCommands.get(id);
  const inherited = base && (isTclProtocolId(id) || base.template === template) ? base.parameters : [];
  const nonBytes = new Set(inherited.filter(parameter => parameter.type !== 'byte').map(parameter => parameter.key));
  const keys = new Set();
  return entries.map(item => {
    const { key, label, options } = fields(item, ['key', 'label', 'options']);
    if (!placeholders.has(key) || keys.has(key) || nonBytes.has(key)) invalid();
    keys.add(key);
    const values = new Set(), names = new Set();
    return { key, label: text(label, 80, true).trim(), options: items(options, 64).map(row => {
      const { label: raw, value: byte } = fields(row, ['label', 'value']);
      const name = text(raw, 80, true).trim(), canonical = name.toLowerCase();
      if (!Number.isInteger(byte) || byte < 0 || byte > 255 || values.has(byte) || names.has(canonical)) invalid();
      values.add(byte); names.add(canonical);
      return { label: name, value: byte };
    }) };
  });
}
export const defaultProtocolPreferences = () => ({ version: 1, overrides: [], removed: [] });
export function normalizeProtocolPreferences(value) {
  const root = fields(value, ['version', 'overrides', 'removed']); if (root.version !== 1) invalid();
  const seen = new Set();
  const overrides = items(root.overrides, 256).map(item => {
    const hasOverrides = Object.hasOwn(item || {}, 'parameterOverrides');
    const entry = fields(item, hasOverrides ? [...commandFields, 'parameterOverrides'] : commandFields);
    if ((!builtin(entry.id) && !custom(entry.id)) || seen.has(entry.id) || typeof entry.reviewed !== 'boolean') invalid();
    seen.add(entry.id);
    const template = text(entry.template, 8192, true, true);
    const parameters = hasOverrides ? normalizeProtocolParameterOverrides(entry.parameterOverrides, entry.id, template) : [];
    return { id: entry.id, name: text(entry.name, 80, true), category: text(entry.category, 40, true),
      template, note: text(entry.note, 2000, false, true), reviewed: entry.reviewed,
      ...(parameters.length ? { parameterOverrides: parameters } : {}) };
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
