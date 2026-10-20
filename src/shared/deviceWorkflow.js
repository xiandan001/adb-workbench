export function resolveActiveDeviceId(currentId, devices) {
  return currentId || devices.find(device => device.status === 'device')?.id || devices[0]?.id || '';
}

export function deviceStatusLabel(status) {
  return { device: '在线', offline: '离线', unauthorized: '未授权', disconnected: '已断开' }[status] || '不可用';
}

export function deviceConnectionHint(status) {
  if (status === 'unauthorized') return '请解锁设备，在 USB 调试授权弹窗中允许此电脑；未出现弹窗时重新插拔 USB。';
  return '请检查 USB 连接、设备电源或 Wi-Fi 地址；恢复连接后会自动更新状态。';
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
    error: response?.error || '未返回执行结果，请核实设备状态后再决定是否重试'
  });
  return {
    items,
    successCount: items.filter(item => item.ok).length,
    failures: items.filter(item => !item.ok)
  };
}
