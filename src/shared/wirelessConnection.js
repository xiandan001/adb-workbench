import { tr } from './i18n.js';
export function historyConnectionAddress(entry) {
  return String(entry.ip || (entry.type === 'wifi' ? entry.deviceId : '') || '').trim();
}

// A connected device stays successful even if the optional history write fails.
export async function connectWirelessDevice(address, { api, refreshDevices, historyEntry }) {
  const target = String(address || '').trim();
  if (!target) return { success: false, message: tr("请输入设备 IP 地址和端口") };
  if (!api?.adbConnect) return { success: false, message: tr("连接功能需要 Electron 环境") };
  try {
    const result = await api.adbConnect(target);
    if (!result.success) return { success: false, message: result.error || tr("设备连接失败") };
  } catch (error) {
    return { success: false, message: error.message || tr("设备连接失败") };
  }
  const result = { success: true, message: tr("已连接 {0}", { 0: target }) };
  const warnings = [];
  try {
    await refreshDevices();
  } catch {
    warnings.push(tr("设备列表刷新失败，可手动刷新"));
  }
  try {
    const saved = await api.saveConnectionHistory({
      deviceId: target,
      deviceName: historyEntry?.deviceName || target,
      ip: target,
      type: 'wifi'
    });
    if (!saved.success) throw new Error(saved.error);
    const loaded = await api.loadConnectionHistory();
    if (!loaded.success) throw new Error(loaded.error);
    result.history = loaded.data;
  } catch {
    warnings.push(tr("连接历史未保存"));
  }
  if (warnings.length) result.message += `；${warnings.join('；')}`;
  return result;
}
