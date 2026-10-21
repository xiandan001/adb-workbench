export function recentDeviceMedia(items, deviceId) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item?.deviceId === deviceId && ['image', 'video'].includes(item.type))
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, 10);
}

export function formatMediaBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
