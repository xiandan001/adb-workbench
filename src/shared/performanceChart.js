export const PERFORMANCE_METRICS = [
  { key: 'cpu', label: 'CPU', color: '#22c55e', group: 'percent', unit: '%' },
  { key: 'memory', label: '内存', color: '#38bdf8', group: 'percent', unit: '%' },
  { key: 'data', label: '存储空间', color: '#f59e0b', group: 'percent', unit: '%' },
  { key: 'temp', label: '温度', color: '#ef4444', group: 'temperature', unit: '°C' },
  { key: 'foregroundFps', label: '前台 FPS', color: '#a78bfa', group: 'fps', unit: 'FPS' },
  { key: 'surfaceFps', label: '合成 FPS', color: '#14b8a6', group: 'fps', unit: 'FPS' }
];

export function performanceAxisMax(group, points, metrics) {
  if (group === 'percent') return 100;
  const minimum = group === 'fps' ? 120 : 60;
  const step = group === 'fps' ? 30 : 10;
  let maximum = minimum;
  for (const point of points) {
    for (const metric of metrics) {
      if (Number.isFinite(point[metric.key])) maximum = Math.max(maximum, point[metric.key]);
    }
  }
  return Math.ceil(maximum / step) * step;
}

export function makePerformancePath(values, width, height, pad, maxValue) {
  let previousValid = false;
  const commands = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { previousValid = false; return; }
    const x = pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
    const y = pad + (maxValue - Math.max(0, Math.min(maxValue, value))) / maxValue * (height - pad * 2);
    commands.push(`${previousValid ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    previousValid = true;
  });
  return commands.join(' ');
}

export function performanceSampleIndex(ratio, count) {
  if (!count) return -1;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}
