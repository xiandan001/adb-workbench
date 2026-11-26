import { tr } from './i18n.js';
export const PERFORMANCE_METRICS = [
  { key: 'cpu', label: 'CPU', color: '#22c55e', group: 'percent', unit: '%' },
  { key: 'memory', get label() { return tr("内存"); }, color: '#38bdf8', group: 'percent', unit: '%' },
  { key: 'data', get label() { return tr("存储空间"); }, color: '#f59e0b', group: 'percent', unit: '%' },
  { key: 'temp', get label() { return tr("温度"); }, color: '#ef4444', group: 'temperature', unit: '°C' },
  { key: 'foregroundFps', get label() { return tr("前台 FPS"); }, color: '#a78bfa', group: 'fps', unit: 'FPS' },
  { key: 'surfaceFps', get label() { return tr("合成 FPS"); }, color: '#14b8a6', group: 'fps', unit: 'FPS' }
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

export function makePerformancePath(values, width, height, pad, maxValue, positions, timestamps) {
  let previousValid = false;
  const commands = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { previousValid = false; return; }
    if (timestamps && timestamps[index] - timestamps[index - 1] > ADJACENT_MS) previousValid = false;
    const x = pad + (positions?.[index] ?? index / Math.max(values.length - 1, 1)) * (width - pad * 2);
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

const MAX_TIMESTAMP = 8.64e15;
const ADJACENT_MS = 20_000;

export function buildPerformanceTimeline(samples) {
  const unique = new Map();
  for (const sample of samples) {
    if (Number.isSafeInteger(sample.timestamp) && sample.timestamp > 0 && sample.timestamp <= MAX_TIMESTAMP) {
      unique.set(sample.timestamp, sample);
    }
  }
  const ordered = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-80);
  return ordered.map((sample, index) => {
    const previous = ordered[index - 1];
    const notices = (Array.isArray(sample.warnings) ? sample.warnings : []).slice(0, 8)
      .filter(warning => typeof warning?.label === 'string' && warning.label)
      .map(warning => ({ kind: 'warning', label: warning.label }));
    if (previous && sample.timestamp - previous.timestamp <= ADJACENT_MS) {
      if (Number.isFinite(previous.cpu) && Number.isFinite(sample.cpu) && sample.cpu >= 80 && sample.cpu - previous.cpu >= 20) notices.push({ kind: 'cpu-spike' });
      for (const key of ['foregroundFps', 'surfaceFps']) {
        if (Number.isFinite(previous[key]) && Number.isFinite(sample[key]) && previous[key] >= 24
          && previous[key] - sample[key] >= 10 && sample[key] <= previous[key] * .75) notices.push({ kind: key });
      }
    }
    return { ...sample, notices };
  });
}

export function performanceTimelinePositions(points) {
  const start = points[0]?.timestamp;
  const span = points.at(-1)?.timestamp - start;
  return points.map(point => span > 0 ? (point.timestamp - start) / span : .5);
}

export function performanceLogPositions(points, times) {
  const start = points[0]?.timestamp, end = points.at(-1)?.timestamp;
  if (!(end > start)) return [];
  return [...new Set(times)].filter(time => Number.isSafeInteger(time) && time >= start && time <= end)
    .map(time => (time - start) / (end - start));
}

export function nearestPerformanceSample(ratio, positions) {
  return positions.reduce((nearest, position, index) => nearest < 0 || Math.abs(position - ratio) < Math.abs(positions[nearest] - ratio)
    ? index : nearest, -1);
}

export function performanceNoticeLabel(notice) {
  if (notice.kind === 'cpu-spike') return tr('CPU 突升');
  if (notice.kind === 'foregroundFps') return tr('前台 FPS 下降');
  if (notice.kind === 'surfaceFps') return tr('合成 FPS 下降');
  return notice.label;
}
