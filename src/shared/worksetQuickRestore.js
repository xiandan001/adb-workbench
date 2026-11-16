import { tr } from './i18n.js';

export function recentWorksets(items = []) {
  return [...items].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 5);
}
export function suggestWorksetName(devices, deviceId, pageLabel) {
  const device = devices.find(item => item.id === deviceId);
  const label = [device?.model || deviceId, pageLabel].filter(Boolean).join(' · ');
  return [...label].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, 80);
}
export async function restoreFreshWorkset(id, { list, onRestore, isCurrent }) {
  const result = await list();
  if (!isCurrent()) return { cancelled: true };
  if (!result?.ok) throw new Error(result?.error || tr('工作集读取失败，请重试。'));
  const selected = result.items?.find(item => item.id === id);
  if (!selected) throw new Error(tr('工作集已不存在，请刷新后重试。'));
  const snapshot = JSON.parse(JSON.stringify(selected));
  await onRestore(snapshot);
  return { restored: true };
}
