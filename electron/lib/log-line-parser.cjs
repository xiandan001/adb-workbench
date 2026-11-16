const { randomUUID } = require('node:crypto');
const { parseHiLogLine } = require('./harmony-log.cjs');

function parseLogLine(source, line, { id = randomUUID(), now = Date.now(), receivedAt = source === 'realtime' ? now : undefined } = {}) {
  const raw = String(line).replace(/\r?\n$/, '');
  const received = Number.isFinite(receivedAt) ? { receivedAt } : {};
  const hilog = parseHiLogLine(raw, { now });
  if (hilog) {
    const entry = { id, source, ...hilog, ...received };
    if (source === 'file' && hilog.clockBasis === 'unknown') delete entry.ts;
    return entry;
  }
  const thread = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/.exec(raw);
  const time = !thread && /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEFA])\/([^(\s]+)\(\s*(\d+)\):\s?(.*)$/.exec(raw);
  if (!thread && !time) return { id, source, raw, message: raw, ...received,
    ...(source === 'realtime' ? { ts: receivedAt, clockBasis: 'received' } : { clockBasis: 'unknown' }) };
  const [, date, clock] = thread || time;
  const [, , , pid, tid, level, tag, message] = thread || [null, date, clock, time[5], undefined, time[3], time[4], time[6]];
  const ts = Date.parse(`${new Date(now).getFullYear()}-${date}T${clock}`), pkgMatch = message.match(/\[pkg:([^\]]+)\]\s*$/);
  return { id, source, raw, ...received, ...(Number.isFinite(ts) ? { ts } : {}), timestamp: `${date} ${clock}`,
    clockBasis: Number.isFinite(ts) ? 'device-local-year-unknown' : 'unknown', pid: Number(pid), ...(tid ? { tid: Number(tid) } : {}),
    level, tag: tag.trim(), ...(pkgMatch ? { pkg: pkgMatch[1] } : {}), message: pkgMatch ? message.slice(0, message.length - pkgMatch[0].length) : message };
}
module.exports = { parseLogLine };
