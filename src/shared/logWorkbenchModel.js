import { levelOrder } from './logTypes.js';
import { LOG_VIEW_BYTES, logRowByteLength } from './logStream.js';

export const LOG_WORKBENCH_LIMIT = 50000;
export const LOG_WORKBENCH_BYTES = LOG_VIEW_BYTES;
export const LOG_ISSUE_LIMIT = 100;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 || Number.isFinite(id);
export function applyLogRowFilter(filter, { field, value, mode = 'include' }) {
  if (!['pkg', 'tag', 'pid'].includes(field) || !['include', 'remove'].includes(mode)
    || field === 'pid' && (!Number.isSafeInteger(value) || value < 0)
    || field !== 'pid' && (typeof value !== 'string' || !value || value.length > 2000)) throw new Error('ROW_FILTER_INVALID');
  const next = { ...filter };
  if (mode === 'include') next[field] = value;
  else if (next[field] === value) delete next[field];
  return next;
}
export function logEntryTimestamp(entry, requested = 'source') {
  if (requested === 'received') return { value: Number.isFinite(entry?.receivedAt) ? entry.receivedAt : null, basis: 'received', reliableDate: true };
  const basis = entry?.clockBasis;
  const known = typeof basis === 'string' && !['unknown', 'received', 'host-received'].includes(basis);
  return { value: known && Number.isFinite(entry?.ts) ? entry.ts : null, basis: basis || 'unknown', reliableDate: known && !basis.includes('year-unknown') };
}
function compile(filter = {}, allowRegex = true) {
  for (const key of ['text', 'excludeText', 'pkg', 'tag', 'domain', 'regex']) if (filter[key] && (typeof filter[key] !== 'string' || filter[key].length > 5000)) throw new Error('LOG_FILTER_INVALID');
  if (filter.regex && !allowRegex) throw Object.assign(new Error('WORKER_REQUIRED'), { code: 'WORKER_REQUIRED' });
  const regex = filter.regex ? new RegExp(filter.regex, filter.regexFlags || 'i') : null;
  const lower = key => filter[key]?.toLocaleLowerCase();
  const pkg = lower('pkg'), tag = lower('tag'), domain = lower('domain'), text = lower('text'), exclude = lower('excludeText');
  return entry => {
    if (filter.minLevel && entry.level && levelOrder[entry.level] < levelOrder[filter.minLevel]) return false;
    if (Number.isFinite(filter.pid) && entry.pid !== filter.pid) return false;
    if (pkg && !(entry.pkg || entry.processName || '').toLocaleLowerCase().includes(pkg)) return false;
    if (tag && !(entry.tag || '').toLocaleLowerCase().includes(tag)) return false;
    if (domain && !(entry.domain || '').toLocaleLowerCase().includes(domain)) return false;
    if (text || exclude) { const haystack = String(entry.raw || '').toLocaleLowerCase(); if (text && !haystack.includes(text) || exclude && haystack.includes(exclude)) return false; }
    if (regex) { regex.lastIndex = 0; if (!regex.test(entry.raw || '')) return false; }
    return true;
  };
}
function timeWindow(rows, range = { kind: 'all' }) {
  const warnings = new Set(); let unknownTimeCount = 0;
  if (!range || range.kind === 'all') return { accept: () => true, warnings, unknown: () => 0 };
  const basis = range.basis === 'received' ? 'received' : 'source';
  const duration = range.kind === 'around' ? range.windowMs : range.durationMs;
  if (!['recent', 'around'].includes(range.kind) || !Number.isFinite(duration) || duration < 0 || duration > 86400000) throw new Error('LOG_TIME_RANGE_INVALID');
  let anchor = null;
  for (const entry of rows) {
    const time = logEntryTimestamp(entry, basis);
    if (range.kind === 'around' ? entry.id === range.entryId : time.value !== null && (anchor === null || time.value > anchor)) anchor = time.value;
  }
  if (anchor === null) warnings.add('TIME_ANCHOR_UNKNOWN');
  const from = anchor === null ? null : anchor - duration, to = range.kind === 'around' && anchor !== null ? anchor + duration : anchor;
  return { warnings, unknown: () => unknownTimeCount, accept: entry => {
    const time = logEntryTimestamp(entry, basis);
    if (time.value === null) { unknownTimeCount++; warnings.add('UNKNOWN_TIME_EXCLUDED'); return false; }
    if (basis === 'source' && time.basis !== 'explicit-offset') warnings.add(time.reliableDate ? 'SOURCE_LOCAL_TIME' : 'SOURCE_YEAR_UNKNOWN');
    return anchor !== null && time.value >= from && time.value <= to;
  } };
}
function compileRules(rules = [], allowRegex) {
  if (!Array.isArray(rules) || rules.length > 500) throw Object.assign(new Error('RULE_INVALID'), { code: 'RULE_INVALID' });
  return rules.filter(rule => rule.enabled === true).map(rule => {
    if (!allowRegex) throw Object.assign(new Error('WORKER_REQUIRED'), { code: 'WORKER_REQUIRED' });
    if (typeof rule.id !== 'string' || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 5000) throw Object.assign(new Error('RULE_INVALID'), { code: 'RULE_INVALID' });
    let regex; try { regex = new RegExp(rule.pattern, rule.flags || 'i'); } catch { throw Object.assign(new Error('RULE_INVALID'), { code: 'RULE_INVALID' }); }
    const keywords = Array.isArray(rule.keywords) ? rule.keywords.slice(0, 100).map(value => String(value).toLocaleLowerCase()) : [];
    return { id: rule.id, kind: rule.type || 'rule', label: rule.label || '', needsLower: keywords.length > 0, test(entry, lowerRaw) {
      const raw = String(entry.raw || '');
      if (keywords.length && !keywords.some(keyword => lowerRaw.includes(keyword))) return false;
      regex.lastIndex = 0; return regex.test(raw);
    } };
  });
}
function issueSignature(entry, kind, ruleId) {
  const message = String(entry.message || entry.raw || '');
  // Do not merge long, indistinguishable prefixes or different numeric error codes.
  const text = message.length > 8192 ? ['oversized', entry.id] : message.replace(/\s+/g, ' ').trim();
  return JSON.stringify([kind, ruleId || '', entry.pkg || entry.processName || '', entry.tag || '', text]);
}
function signatureId(value) { let hash = 2166136261; for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }

function createRowEvaluator(filter, rules, allowRegex) {
  const matches = compile(filter, allowRegex), compiledRules = compileRules(rules, allowRegex), needsLower = compiledRules.some(rule => rule.needsLower);
  return entry => {
    if (!matches(entry)) return { matches: false };
    const lowerRaw = needsLower ? entry.raw.toLocaleLowerCase() : '', rule = compiledRules.find(candidate => candidate.test(entry, lowerRaw));
    const kind = rule?.kind || (['E', 'F', 'A'].includes(entry.level) ? 'error' : '');
    return { matches: true, rule, kind, signature: kind ? issueSignature(entry, kind, rule?.id) : '' };
  };
}

// A query accumulator is shared with the chunked, non-regex fallback; raw evidence is never rewritten.
export function createLogQuery(rows, { filter = {}, timeRange, rules = [], allowRegex = true, evaluateEntry } = {}) {
  const evaluate = evaluateEntry || createRowEvaluator(filter, rules, allowRegex), time = timeWindow(rows, timeRange), ids = [], groups = new Map();
  const counts = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, A: 0 }; let ungroupedIssueCount = 0;
  return { visit(entry, index) {
    if (!time.accept(entry)) return;
    const { matches, kind, rule, signature } = evaluate(entry); if (!matches) return;
    ids.push(entry.id); if (Object.hasOwn(counts, entry.level)) counts[entry.level]++;
    if (!kind) return;
    let group = groups.get(signature);
    const sourceTime = logEntryTimestamp(entry), timestamp = sourceTime.value !== null ? sourceTime : logEntryTimestamp(entry, 'received');
    if (!group) {
      if (groups.size === LOG_ISSUE_LIMIT) { ungroupedIssueCount++; return; }
      group = { id: `issue-${signatureId(signature)}-${groups.size}`, signature, kind, ruleId: rule?.id || '', label: rule?.label || '', count: 0, firstTime: null, lastTime: null, timeBasis: timestamp.value === null ? 'unknown' : timestamp.basis,
        reliableDate: timestamp.reliableDate, representativeId: entry.id, contextIds: rows.slice(Math.max(0, index - 5), index + 6).map(row => row.id) };
      groups.set(signature, group);
    }
    group.count++;
    if (timestamp.value !== null && group.timeBasis === timestamp.basis) { group.firstTime = group.firstTime === null ? timestamp.value : Math.min(group.firstTime, timestamp.value); group.lastTime = group.lastTime === null ? timestamp.value : Math.max(group.lastTime, timestamp.value); }
    else if (timestamp.value !== null) { group.timeBasis = 'mixed'; group.firstTime = null; group.lastTime = null; }
  }, finish() { return { ids, counts, issues: [...groups.values()], total: rows.length, unknownTimeCount: time.unknown(), timeWarnings: [...time.warnings], ungroupedIssueCount }; } };
}
export function createLogViewIndex({ limit = LOG_WORKBENCH_LIMIT, maxBytes = LOG_WORKBENCH_BYTES } = {}) {
  const rows = new Map(), sizes = new Map(); let bytes = 0, omittedRows = 0, evaluatorKey = '', evaluator, evaluated = new WeakMap();
  const remove = id => { if (rows.delete(id)) { bytes -= sizes.get(id) || 0; sizes.delete(id); } };
  return { sync({ reset = false, removedIds = [], upsertRows = [] } = {}) {
    if (reset) { rows.clear(); sizes.clear(); bytes = 0; omittedRows = 0; }
    for (const id of removedIds) remove(id);
    for (const row of upsertRows) {
      if (!validId(row?.id) || typeof row.raw !== 'string') continue;
      const size = logRowByteLength(row);
      if (size > maxBytes) { remove(row.id); omittedRows++; continue; }
      if (rows.has(row.id)) bytes -= sizes.get(row.id) || 0;
      rows.set(row.id, row); sizes.set(row.id, size); bytes += size;
      while (rows.size > limit || bytes > maxBytes) { remove(rows.keys().next().value); omittedRows++; }
    }
    return { size: rows.size, bytes, omittedRows };
  }, query(options = {}) {
    const key = JSON.stringify([options.filter || {}, options.rules || [], options.allowRegex !== false]);
    if (key !== evaluatorKey) { evaluator = createRowEvaluator(options.filter || {}, options.rules || [], options.allowRegex !== false); evaluated = new WeakMap(); evaluatorKey = key; }
    let evaluatedRows = 0;
    const evaluateEntry = entry => { let value = evaluated.get(entry); if (!value) { value = evaluator(entry); evaluated.set(entry, value); evaluatedRows++; } return value; };
    const snapshot = [...rows.values()], query = createLogQuery(snapshot, { ...options, evaluateEntry });
    snapshot.forEach(query.visit); return { ...query.finish(), retainedBytes: bytes, omittedRows, evaluatedRows };
  }, get size() { return rows.size; }, get bytes() { return bytes; } };
}
