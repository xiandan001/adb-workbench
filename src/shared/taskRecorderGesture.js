const pointLimit = 120;
const replayPointLimit = 48;
const longPressThreshold = 600;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function recorderPreviewPoint(event, rect, width, height, clamp = false) {
  if (!(rect?.width > 0 && rect?.height > 0 && width > 0 && height > 0)) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const x = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (event.clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !clamp && (x < 0 || y < 0 || x >= width || y >= height)) return null;
  return { x: Math.max(0, Math.min(width - 1, Math.round(x))), y: Math.max(0, Math.min(height - 1, Math.round(y))) };
}

function sample(points, count) {
  if (points.length <= count) return points;
  return Array.from({ length: count }, (_, index) => points[Math.round(index * (points.length - 1) / (count - 1))]);
}

export function appendRecorderGesturePoint(points, point, force = false) {
  const last = points.at(-1);
  if (last && distance(last, point) < (force ? 1 : 8)) return points;
  const next = [...points, point];
  // Downsample in place rather than dropping the original contact point.
  return next.length > pointLimit ? sample(next, 96) : next;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return distance(point, start);
  const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return distance(point, { x: start.x + dx * progress, y: start.y + dy * progress });
}

export function classifyRecorderGesture({ points, elapsedMs, width, height, tapOnly = false, harmony = false }) {
  const start = points[0], end = points.at(-1);
  if (!start || !end || !(width > 0 && height > 0)) return null;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
  const clickTolerance = Math.max(12, Math.min(width, height) * 0.01);
  const moving = points.some(point => distance(point, start) > clickTolerance);
  if (!moving) {
    const point = { node: null, x: end.x, y: end.y };
    if (tapOnly || elapsed < longPressThreshold) return { action: 'tap', args: point };
    return { action: 'longPress', args: { ...point, ...(harmony
      ? { longPressMode: 'native', durationMs: null } : { durationMs: Math.min(10000, elapsed) }) } };
  }
  if (tapOnly) return null;

  // Sample fidelity distinguishes actual curves (including return-to-origin) from ordinary pointer motion on a straight drag.
  const curve = points.length > 2 && (distance(start, end) <= clickTolerance ||
    points.some(point => distanceToSegment(point, start, end) > Math.max(8, clickTolerance / 2)));
  if (harmony && curve) return { unsupported: 'curve' };
  return {
    action: 'swipe',
    args: { x: start.x, y: start.y, endX: end.x, endY: end.y, durationMs: Math.max(80, Math.min(10000, elapsed)),
      points: curve ? sample(points, replayPointLimit) : [start, end], curve },
  };
}

const hasCoordinate = value => value !== '' && value != null && Number.isFinite(Number(value));

export function decodeRecordedSwipePath(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const points = raw.map(point => Array.isArray(point) ? { x: point[0], y: point[1] } : point);
  return points.every(point => hasCoordinate(point?.x) && hasCoordinate(point?.y)) ? points.map(({ x, y }) => ({ x: Number(x), y: Number(y) })) : [];
}

export function mergeRecordedStepPatch(step, patch) {
  const next = { ...step, ...patch };
  if (step.type !== 'swipe' || next.type !== 'swipe') return next;
  if (Object.hasOwn(patch, 'points')) {
    const points = decodeRecordedSwipePath(patch.points);
    return points.length ? { ...next, x: points[0].x, y: points[0].y, endX: points.at(-1).x, endY: points.at(-1).y } : next;
  }
  const fields = [['x', 'x', 0], ['y', 'y', 0], ['endX', 'x', -1], ['endY', 'y', -1]];
  if (!fields.some(([key]) => Object.hasOwn(patch, key))) return next;
  const path = typeof step.points === 'string' ? decodeRecordedSwipePath(step.points) : step.points;
  if (!Array.isArray(path) || path.length < 2) return next;
  const points = path.map(point => Array.isArray(point) ? { x: point[0], y: point[1] } : { ...point });
  for (const [key, coordinate, index] of fields) if (Object.hasOwn(patch, key)) points.at(index)[coordinate] = patch[key];
  return { ...next, points };
}
