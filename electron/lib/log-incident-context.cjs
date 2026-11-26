const WINDOW_MS = 30_000;
const MAX_ROWS = 40;
const MAX_PREVIEW = 2_048;

function normalizeLogIncidentRequest(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).sort().join(',') !== 'deviceId,timestamp'
    || typeof args.deviceId !== 'string' || !args.deviceId.length || args.deviceId.length > 256
    || args.deviceId !== args.deviceId.trim() || /[\u0000-\u001f\u007f]/u.test(args.deviceId)
    || !Number.isSafeInteger(args.timestamp) || args.timestamp <= 0 || args.timestamp > 8.64e15) return null;
  return { deviceId: args.deviceId, timestamp: args.timestamp };
}

// Performance samples and log reception share the desktop clock. Device-origin
// time may have a different clock or timezone and must not be used here.
function readLogIncidentContext(request, { entries, deviceId: capturedDevice, truncated = false }) {
  const { deviceId, timestamp } = request;
  const window = { deviceId, timestamp, windowMs: WINDOW_MS };
  if (capturedDevice !== deviceId) return { ...window, ok: true, rows: [], status: 'no-source', truncated: false };
  const nearest = [];
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.source !== 'realtime' || entry.deviceId !== deviceId || !Number.isSafeInteger(entry.receivedAt) || entry.receivedAt <= 0 || entry.receivedAt > 8.64e15
      || !['number', 'string'].includes(typeof entry.id) || typeof entry.raw !== 'string') continue;
    const distance = Math.abs(entry.receivedAt - timestamp);
    if (distance > WINDOW_MS) continue;
    count++;
    const tail = nearest.at(-1);
    if (nearest.length === MAX_ROWS && distance >= tail.distance) continue;
    let position = nearest.length;
    while (position > 0 && nearest[position - 1].distance > distance) position--;
    nearest.splice(position, 0, { index, entry, distance });
    if (nearest.length > MAX_ROWS) nearest.pop();
  }
  const rows = nearest.sort((a, b) => a.entry.receivedAt - b.entry.receivedAt || a.index - b.index)
    .map(({ entry }) => {
      const end = MAX_PREVIEW - Number(entry.raw.length > MAX_PREVIEW && /[\uD800-\uDBFF]/.test(entry.raw[MAX_PREVIEW - 1] || ''));
      return { id: entry.id, receivedAt: entry.receivedAt, raw: entry.raw.slice(0, end),
        previewTruncated: entry.raw.length > end, level: /^[VDIWEFA]$/.test(entry.level || '') ? entry.level : '',
        tag: typeof entry.tag === 'string' ? entry.tag.slice(0, 100) : '' };
    });
  return { ...window, ok: true, rows, status: rows.length ? 'found' : 'empty', truncated: truncated || count > rows.length };
}

module.exports = { normalizeLogIncidentRequest, readLogIncidentContext };
