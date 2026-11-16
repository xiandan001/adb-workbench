const LEVEL_ORDER = Object.freeze({ V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 6 });
const FILTER_TEXT_KEYS = ['pkg', 'tag', 'domain', 'text', 'excludeText', 'regex', 'regexFlags', 'minLevel'];
function normalizeFilter(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('LOG_FILTER_INPUT');
  const filter = {};
  for (const key of FILTER_TEXT_KEYS) {
    if (value[key] == null || !value[key] && key !== 'regexFlags') continue;
    if (typeof value[key] !== 'string' || value[key].length > 10000) throw Error('LOG_FILTER_INPUT');
    filter[key] = value[key];
  }
  if (typeof value.pid === 'number') { if (!Number.isFinite(value.pid)) throw Error('LOG_FILTER_INPUT'); filter.pid = value.pid; }
  return filter;
}
// Used in the worker and parity tests only. Main callers normalize but never compile user regex.
function compileLogFilter(value) {
  const filter = normalizeFilter(value), lower = {};
  for (const key of ['pkg', 'tag', 'domain', 'text', 'excludeText']) lower[key] = filter[key]?.toLowerCase();
  let regex;
  if (filter.regex) {
    try { regex = new RegExp(filter.regex, filter.regexFlags ?? 'i'); }
    catch { return { predicate: () => false, invalidRegex: true }; }
  }
  return { invalidRegex: false, predicate(entry) {
    if (filter.minLevel && entry.level && LEVEL_ORDER[entry.level] < LEVEL_ORDER[filter.minLevel]) return false;
    if (typeof filter.pid === 'number' && entry.pid !== filter.pid) return false;
    if (lower.pkg && !(entry.pkg || entry.processName || '').toLowerCase().includes(lower.pkg)) return false;
    if (lower.tag && !(entry.tag ?? '').toLowerCase().includes(lower.tag)) return false;
    if (lower.domain && !(entry.domain || '').toLowerCase().includes(lower.domain)) return false;
    if (lower.text || lower.excludeText) {
      const raw = (entry.raw ?? '').toLowerCase();
      if (lower.text && !raw.includes(lower.text) || lower.excludeText && raw.includes(lower.excludeText)) return false;
    }
    if (regex) { regex.lastIndex = 0; if (!regex.test(entry.raw)) return false; }
    return true;
  } };
}
function filterEntries(entries, filter) {
  if (!filter || !['minLevel', 'text', 'excludeText', 'tag', 'domain', 'pkg', 'regex'].some(key => filter[key]) && typeof filter.pid !== 'number') return entries;
  return entries.filter(compileLogFilter(filter).predicate);
}
function countByLevel(entries) {
  return entries.reduce((counts, entry) => { if (entry.level) counts[entry.level] = (counts[entry.level] ?? 0) + 1; return counts; }, { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, A: 0 });
}
module.exports = { LEVEL_ORDER, normalizeFilter, compileLogFilter, filterEntries, countByLevel };
