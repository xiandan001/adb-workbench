const { tr } = require('./localization.cjs');

const HILOG_TYPES = Object.freeze(['app', 'core', 'init', 'kmsg']);
function logTypes(types = []) {
  if (!Array.isArray(types) || types.length > HILOG_TYPES.length || new Set(types).size !== types.length
    || types.some(type => !HILOG_TYPES.includes(type)) || types.includes('kmsg') && types.length > 1) {
    throw Object.assign(new Error(tr('HiLog 类型无效；内核日志不能与其他类型混选。')), { code: 'HILOG_OPTIONS', safe: true });
  }
  return types.length ? ['-t', types.join(',')] : [];
}

// Official HiLog query options: -x is non-blocking, -z is a tail line count;
// -t belongs to hilog types here, never to the host HDC target selection.
function buildHiLogArgs({ snapshot = false, maxLines = 2000, types = [] } = {}) {
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 2000) throw Object.assign(new Error(tr('HiLog 保留行数必须在 1–2000 之间。')), { code: 'HILOG_OPTIONS', safe: true });
  return ['shell', 'hilog', ...(snapshot ? ['-x'] : []), '-v', 'time', '-z', String(maxLines), ...logTypes(types)];
}
function readHiLogSnapshot(deviceId, { maxLines = 2000, types = [], ...options } = {}, dependencies = {}) {
  return (dependencies.runHdc || require('./hdc-runtime.cjs').runHdc)(deviceId, buildHiLogArgs({ snapshot: true, maxLines, types }),
    { timeoutMs: 12000, ...options, maxBuffer: Math.min(options.maxBuffer || 2 * 1024 * 1024, 2 * 1024 * 1024) });
}
function spawnHiLog(deviceId, { maxLines = 2000, types = [], ...options } = {}, dependencies = {}) {
  return (dependencies.spawnHdc || require('./hdc-runtime.cjs').spawnHdc)(deviceId, buildHiLogArgs({ maxLines, types }), options);
}
function clearHiLog(deviceId, { types = [], ...options } = {}, dependencies = {}) {
  return (dependencies.runHdc || require('./hdc-runtime.cjs').runHdc)(deviceId, ['shell', 'hilog', '-r', ...logTypes(types)], { timeoutMs: 5000, maxBuffer: 64 * 1024, ...options });
}

function parseHiLogLine(line, { now = Date.now() } = {}) {
  const raw = String(line).replace(/\r?\n$/, '');
  const clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:[.,]\d{3,9})?)(?:\s?(Z|[+-]\d{2}:?\d{2}))?\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([A-Z][\da-fA-F]{4,8})\/(.+?):(?:\s+(.*)|$)/.exec(clean);
  if (!match) return null;
  const [, date, time, zone, pid, tid, level, domain, names, message = ''] = match;
  const parts = names.split('/'), processName = parts.length > 1 ? parts.shift() : '', tag = parts.join('/');
  const yearKnown = date.length === 10, stamp = `${yearKnown ? date : `${new Date(now).getFullYear()}-${date}`}T${time.replace(',', '.')}`;
  const parsed = Date.parse(stamp + (zone || ''));
  return { raw, ts: Number.isFinite(parsed) ? parsed : now, timestamp: `${date} ${time}${zone || ''}`,
    pid: Number(pid), tid: Number(tid), level, domain, processName, tag, message,
    platform: 'harmony', logFormat: 'hilog', clockBasis: !Number.isFinite(parsed) ? 'unknown' : !yearKnown ? 'device-local-year-unknown' : zone ? 'explicit-offset' : 'source-local' };
}

module.exports = { HILOG_TYPES, buildHiLogArgs, readHiLogSnapshot, spawnHiLog, clearHiLog, parseHiLogLine };
