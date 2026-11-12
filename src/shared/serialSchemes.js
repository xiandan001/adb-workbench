import { tr } from './i18n.js';
import { normalizePreferences, normalizeSerialScheme } from './serialSettings.js';

export function addSerialScheme(preferences, { id, name, workspace, config, terminalEnter = 'cr' }) {
  const current = normalizePreferences(preferences);
  const scheme = normalizeSerialScheme({ id, name, workspace, config, terminalEnter,
    receiveMode: current.receiveMode, sendMode: current.sendMode, lineEnding: current.lineEnding });
  return normalizePreferences({ ...current, version: 3, schemes: [...(current.schemes || []), scheme] });
}

export function updateSerialScheme(preferences, { id, workspace, config, terminalEnter = 'cr' }) {
  const current = normalizePreferences(preferences);
  const previous = current.schemes?.find(item => item.id === id && item.workspace === workspace);
  if (!previous) throw new Error(tr('连接方案不存在或属于另一工作区'));
  const scheme = normalizeSerialScheme({ ...previous, config, terminalEnter,
    receiveMode: current.receiveMode, sendMode: current.sendMode, lineEnding: current.lineEnding });
  return normalizePreferences({ ...current, schemes: current.schemes.map(item => item.id === id ? scheme : item) });
}

export function applySerialScheme(preferences, id, workspace, { status, pending = false } = {}) {
  if (pending || !['disconnected', 'error'].includes(status)) throw new Error(tr('请先断开当前串口，再套用连接方案'));
  const current = normalizePreferences(preferences);
  const scheme = current.schemes?.find(item => item.id === id && item.workspace === workspace);
  if (!scheme) throw new Error(tr('连接方案不存在或属于另一工作区'));
  if (workspace === 'terminal') {
    return { preferences: normalizePreferences({ ...current, terminalConfig: scheme.config }), terminalEnter: scheme.terminalEnter };
  }
  return { preferences: normalizePreferences({ ...current, config: scheme.config,
    receiveMode: scheme.receiveMode, sendMode: scheme.sendMode, lineEnding: scheme.lineEnding }) };
}

export function removeSerialScheme(preferences, id, workspace) {
  const current = normalizePreferences(preferences);
  return normalizePreferences({ ...current, version: 3,
    schemes: (current.schemes || []).filter(item => item.id !== id || item.workspace !== workspace) });
}
