export function formatBytes(value) {
  if (!Number.isFinite(value)) return '容量未知';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let bytes = value / 1024;
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(bytes >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function sortArtifacts(items, order) {
  return [...items].sort((a, b) => {
    if (order === 'size') {
      const size = (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1);
      if (size) return size;
    }
    const difference = new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    return order === 'oldest' ? -difference : difference;
  });
}
