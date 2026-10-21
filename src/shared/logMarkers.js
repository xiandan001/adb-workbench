export const MAX_LOG_MARKERS = 500;

// IDs can repeat after capture restarts; preserve the captured raw/time/source/device tuple.
export function logEntryIdentity(entry, deviceId = '') {
  return JSON.stringify([entry.id, entry.raw, entry.ts ?? null, entry.source || '', entry.deviceId || deviceId]);
}

export function captureLogMarker(entry, entries, deviceId, note, id, createdAt = Date.now()) {
  const title = note.trim();
  if (!title || title.length > 240) throw new Error('请输入 1–240 字的问题备注');
  const savedEntry = { ...entry, deviceId: entry.deviceId || deviceId || '' };
  const identity = logEntryIdentity(savedEntry);
  const index = entries.findIndex(item => item.id === savedEntry.id && logEntryIdentity(item, deviceId) === identity);
  const context = index < 0 ? [savedEntry] : entries.slice(Math.max(0, index - 5), index + 6)
    .map(item => ({ ...item, deviceId: item.deviceId || deviceId || '' }));
  return { id, note: title, createdAt, entry: savedEntry, context };
}

export function filterLogSessions(sessions, query = '', period = 'all', now = Date.now()) {
  const term = query.trim().toLocaleLowerCase();
  const start = period === 'today' ? new Date(now).setHours(0, 0, 0, 0)
    : ['7', '30', '90'].includes(period) ? now - Number(period) * 86400000 : 0;
  return sessions.filter(session => (!term || `${session.name} ${session.deviceId || ''}`.toLocaleLowerCase().includes(term))
    && (!start || Date.parse(session.savedAt) >= start));
}
