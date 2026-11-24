import { tr } from './i18n.js';
import { isHarmonyDevice } from './devicePlatform.js';

export function resolveActiveDeviceId(currentId, devices, channels) {
  if (currentId && ['pending', 'unconfirmed'].includes(channels?.[isHarmonyDevice(currentId) ? 'hdc' : 'adb'])) return currentId;
  if (devices.some(device => device.id === currentId && ['device', 'unconfirmed'].includes(device.status))) return currentId;
  const confirmed = devices.filter(device => !channels || channels[isHarmonyDevice(device) ? 'hdc' : 'adb'] === 'ready');
  return confirmed.find(device => device.status === 'device')?.id
    || devices.find(device => device.id === currentId)?.id
    || confirmed.find(device => device.status !== 'unconfirmed')?.id || '';
}

export function deviceStatusLabel(status) {
  return { device: tr("在线"), offline: tr("离线"), unauthorized: tr("未授权"), disconnected: tr("已断开"),
    unconfirmed: tr('暂无法确认') }[status] || tr("不可用");
}

export function deviceConnectionHint(status) {
  if (status === 'unconfirmed') return tr('暂时无法确认设备连接，已保留原设备。连接恢复后可继续操作。');
  if (status === 'unauthorized') return tr("请解锁设备，在 USB 调试授权弹窗中允许此电脑；未出现弹窗时重新插拔 USB。");
  return tr("请检查 USB 连接、设备电源或 Wi-Fi 地址；恢复连接后会自动更新状态。");
}

// Keep the actual request in flight until it settles, even when callers refresh again.
export function singleFlight(action) {
  let pending = null;
  return (...args) => {
    if (!pending) {
      pending = Promise.resolve().then(() => action(...args)).finally(() => { pending = null; });
    }
    return pending;
  };
}

export function summarizePackageBatch(packageNames, response) {
  const results = new Map((response?.results || []).map(item => [item.packageName, item]));
  const items = packageNames.map(packageName => results.get(packageName) || {
    packageName,
    ok: false,
    error: response?.error || tr("未返回执行结果，请核实设备状态后再决定是否重试")
  });
  return {
    items,
    successCount: items.filter(item => item.ok).length,
    failures: items.filter(item => !item.ok)
  };
}
