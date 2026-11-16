import { tr } from './i18n.js';
import { applySerialScheme } from './serialSchemes.js';

export const SERIAL_SCHEME_SELECTION_KEY = 'adb-workbench.serial-scheme-selection.v1';
export function normalizeSerialSchemeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length !== 3 || value.version !== 1
    || ['rs232', 'terminal'].some(key => typeof value[key] !== 'string' || value[key].length > 200
      || value[key] && !value[key].trim()
      || [...value[key]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new Error(tr('连接方案选择无法读取，原数据已保留。'));
  return { version: 1, rs232: value.rs232, terminal: value.terminal };
}
export function readSerialSchemeSelection(storage = globalThis.localStorage) {
  const raw = storage.getItem(SERIAL_SCHEME_SELECTION_KEY);
  if (raw == null) return { version: 1, rs232: '', terminal: '' };
  try { if (typeof raw !== 'string' || raw.length > 2048) throw Error(); return normalizeSerialSchemeSelection(JSON.parse(raw)); }
  catch { throw new Error(tr('连接方案选择无法读取，原数据已保留。')); }
}
export function saveSerialSchemeSelection(value, storage = globalThis.localStorage) {
  readSerialSchemeSelection(storage);
  const next = normalizeSerialSchemeSelection(value); storage.setItem(SERIAL_SCHEME_SELECTION_KEY, JSON.stringify(next)); return next;
}
export function resetSerialSchemeSelection(storage = globalThis.localStorage) {
  const next = { version: 1, rs232: '', terminal: '' };
  storage.setItem(SERIAL_SCHEME_SELECTION_KEY, JSON.stringify(next)); return next;
}

export async function applyAndConnectSerialScheme({ preferences, id, workspace, path, status, pending, persist, connect }) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(tr('请选择串口'));
  const applied = applySerialScheme(preferences, id, workspace, { status, pending });
  const config = workspace === 'terminal' ? applied.preferences.terminalConfig : applied.preferences.config;
  const request = Object.freeze({ workspace, path, config: Object.freeze({ ...config }) });
  if (await persist(applied.preferences, applied.terminalEnter) !== true) throw new Error(tr('方案未能保存，当前参数保持不变'));
  return connect(request);
}
