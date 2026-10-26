const { tr } = require('./localization.cjs');
const { recentLines } = require('./ai-workspace-limits.cjs');
const invalid = () => Object.assign(new Error(tr('证据选段条件无效，请检查关键词、时间范围和行数。')), { code: 'AI_SELECTION', safe: true });

function dateValue(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw invalid();
  const [, year, month, day, hour, minute, second = '00', fraction = '', zone = ''] = match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0')}`;
  const epoch = Date.parse(wall + (zone || 'Z'));
  if (!Number.isFinite(epoch) || +hour > 23 || +minute > 59 || +second > 59
    || new Date(Date.UTC(+year, +month - 1, +day)).toISOString().slice(0, 10) !== wall.slice(0, 10)) throw invalid();
  return { wall, epoch, zone };
}

function normalizeSelection(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['keywords', 'from', 'to', 'contextLines', 'maxLines'].includes(key))) throw invalid();
  const { keywords = '', from = '', to = '', contextLines = 3, maxLines = recentLines } = value;
  if (typeof keywords !== 'string' || keywords.length > 512 || typeof from !== 'string' || typeof to !== 'string'
    || from.length > 40 || to.length > 40 || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20
    || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > recentLines) throw invalid();
  const terms = keywords.split(/[,，\n]/).map(term => term.trim()).filter(Boolean);
  if (terms.length > 12 || terms.some(term => term.length > 80)) throw invalid();
  const start = dateValue(from), end = dateValue(to);
  if (start && end && (Boolean(start.zone) !== Boolean(end.zone) || (start.zone ? start.epoch > end.epoch : start.wall > end.wall))) throw invalid();
  return { keywords: keywords.trim(), from, to, contextLines, maxLines };
}

function eventTime(line, kind) {
  if (kind === 'serial') return null; // Prefixes are host receipt times, not device event times.
  const iso = /^(?:\[)?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)(?=[\]\s])/.exec(line);
  if (iso) {
    try {
      const parsed = dateValue(iso[1]);
      return { timestamp: iso[1], clockBasis: parsed.zone ? 'explicit-offset' : 'source-local', ...parsed };
    } catch { return null; }
  }
  const partial = /^(\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})(?=\s)/.exec(line);
  if (partial) {
    try {
      const parsed = dateValue(`2000-${partial[1]}T${partial[2]}`);
      return { timestamp: `${partial[1]}T${partial[2]}`, clockBasis: 'device-local-year-unknown', wall: parsed.wall.slice(5) };
    } catch { return null; }
  }
  return null;
}

function selectLines(text, kind, selection) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const start = dateValue(selection.from), end = dateValue(selection.to);
  const terms = selection.keywords.split(/[,，\n]/).map(term => term.trim().toLocaleLowerCase()).filter(Boolean);
  const observations = lines.map(line => eventTime(line, kind));
  let unknown = 0;
  const inTime = observations.map(event => {
    if (!start && !end) return true;
    if (!event) { unknown++; return false; }
    if (event.clockBasis === 'device-local-year-unknown') {
      if (start?.zone || end?.zone || (start && end && start.wall.slice(0, 4) !== end.wall.slice(0, 4))) { unknown++; return false; }
      return (!start || event.wall >= start.wall.slice(5)) && (!end || event.wall <= end.wall.slice(5));
    }
    if (start?.zone || end?.zone) {
      if (!event.zone) { unknown++; return false; }
      return (!start || event.epoch >= start.epoch) && (!end || event.epoch <= end.epoch);
    }
    return (!start || event.wall >= start.wall) && (!end || event.wall <= end.wall);
  });
  const selected = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!inTime[i] || (terms.length && !terms.some(term => lines[i].toLocaleLowerCase().includes(term)))) continue;
    for (let j = Math.max(0, i - (terms.length ? selection.contextLines : 0)); j <= Math.min(lines.length - 1, i + (terms.length ? selection.contextLines : 0)); j++) {
      // Context can include untimed continuation lines; never include a known out-of-range event.
      if (inTime[j] || !observations[j]) selected.add(j);
    }
  }
  const indexes = [...selected].sort((a, b) => a - b);
  return { lines, observations, indexes: indexes.slice(-selection.maxLines), originalLineCount: lines.length,
    selectedLineCount: indexes.length, omittedUnknownTimeLines: unknown };
}

module.exports = { normalizeSelection, eventTime, selectLines };
