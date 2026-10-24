import { tr } from './i18n.js';
export const SERIAL_TERMINAL_STYLE_KEY = 'adb-workbench.serial-terminal-style.v1';

export function normalizeSerialTerminalStyle(value) {
  if (value !== 'current' && value !== 'classic') throw new Error(tr("终端样式无效，仅支持当前主题或经典黑底"));
  return value;
}

export function readSerialTerminalStyle(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(SERIAL_TERMINAL_STYLE_KEY);
    if (raw === null || raw === undefined) return 'current';
    if (typeof raw !== 'string' || raw.length > 64) throw new Error(tr('终端样式数据无效'));
    return normalizeSerialTerminalStyle(JSON.parse(raw));
  } catch {
    throw new Error(tr("终端样式无法读取或数据异常，原数据未修改；可重新选择样式保存"));
  }
}

export function saveSerialTerminalStyle(value, storage = globalThis.localStorage) {
  const style = normalizeSerialTerminalStyle(value);
  try { storage.setItem(SERIAL_TERMINAL_STYLE_KEY, JSON.stringify(style)); }
  catch { throw new Error(tr("终端样式保存失败，请检查本地存储后重试")); }
  return style;
}
