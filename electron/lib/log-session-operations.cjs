const { tr } = require('./localization.cjs');
const { redactText } = require('./feedback-policy.cjs');
const { createHash } = require('node:crypto');

function identity(session) {
  const platforms = [...new Set(session.entries.map(entry => ['android', 'harmony'].includes(entry.platform) ? entry.platform : '').filter(Boolean))];
  return { id: session.id, name: session.name, entryCount: session.entries.length, deviceId: session.deviceId || '', source: session.source,
    platform: platforms.length === 1 ? platforms[0] : platforms.length ? 'mixed' : session.deviceId?.startsWith('hdc:') ? 'harmony' : 'unknown' };
}
function time(entry) {
  if (entry.clockBasis === 'received' && Number.isFinite(entry.receivedAt)) return { value: entry.receivedAt, basis: 'received' };
  if (entry.clockBasis && !['unknown', 'device-local-year-unknown'].includes(entry.clockBasis) && Number.isFinite(entry.ts)) return { value: entry.ts, basis: entry.clockBasis };
  return null;
}
function groupRows(entries) {
  const groups = new Map(); let issueEntries = 0;
  for (const entry of entries) {
    if (!['E', 'F'].includes(entry.level) && !/crash|fatal|exception|\banr\b|watchdog|app_freeze/i.test(entry.message || entry.raw)) continue;
    issueEntries++;
    const message = String(entry.message || entry.raw);
    const tag = String(entry.tag || '').slice(0, 200), level = String(entry.level || '').slice(0, 8);
    const key = createHash('sha256').update(JSON.stringify([String(entry.level || ''), String(entry.tag || '')])).update('\0').update(message).digest('hex');
    const signature = [level, tag, message.slice(0, 240)].join(' · ');
    const row = groups.get(key) || { id: key, signature, tag, level, count: 0, first: null, last: null, mixedTime: false };
    row.count++;
    const at = time(entry);
    if (!at) { row.first = null; row.last = null; row.mixedTime = true; }
    else if (!row.mixedTime) {
      if (row.first && row.first.basis !== at.basis) { row.first = null; row.last = null; row.mixedTime = true; }
      else { if (!row.first || at.value < row.first.value) row.first = at; if (!row.last || at.value > row.last.value) row.last = at; }
    }
    groups.set(key, row);
  }
  return { groups, issueEntries };
}
function compareSessions(before, after) {
  const a = identity(before), b = identity(after), left = groupRows(before.entries), right = groupRows(after.entries);
  const comparable = Boolean(a.deviceId && a.deviceId === b.deviceId && a.source === b.source && a.platform !== 'mixed' && a.platform === b.platform);
  const signatures = new Set([...left.groups.keys(), ...right.groups.keys()]);
  const groups = [...signatures].map(key => {
    const l = left.groups.get(key), r = right.groups.get(key);
    return { id: key, signature: (l || r).signature, tag: (l || r).tag, level: (l || r).level, beforeCount: l?.count || 0, afterCount: r?.count || 0,
      delta: (r?.count || 0) - (l?.count || 0), beforeFirst: l?.first || null, beforeLast: l?.last || null, afterFirst: r?.first || null, afterLast: r?.last || null };
  }).sort((a, b) => b.afterCount + b.beforeCount - a.afterCount - a.beforeCount);
  return { comparable, before: a, after: b, beforeIssueEntries: left.issueEntries, afterIssueEntries: right.issueEntries,
    groupCount: groups.length, groupsLimited: groups.length > 100, groups: groups.slice(0, 100), warnings: [
      ...(!comparable ? [tr('来源身份不同或不完整，仅列出数量变化，不能判断改善或退化。')] : []),
      tr('规则分组只是线索，不是根因。采集时长与完整性可能不同，不计算错误率或推断修复。'),
      ...([...before.entries, ...after.entries].some(entry => !time(entry)) ? [tr('部分日志时间未知；未补造时间或计算速率。')] : [])] };
}
function exportContents(session, { scope, format, redact, includeAi = false }) {
  if (!['filtered', 'loaded', 'issue'].includes(scope) || !['raw', 'bundle'].includes(format) || typeof redact !== 'boolean' || typeof includeAi !== 'boolean') throw new Error(tr('导出选项无效。'));
  const mask = text => redact ? redactText(text) : text;
  const raw = session.entries.map(entry => mask(entry.raw)).join('\n') + (session.entries.length ? '\n' : '');
  const markers = session.markers.map(marker => ({ ...marker, note: mask(marker.note), entry: { ...marker.entry, raw: mask(marker.entry.raw) },
    context: marker.context.map(entry => ({ ...entry, raw: mask(entry.raw) })) }));
  const report = includeAi ? session.aiTurns.map(turn => [mask(turn.header), mask(turn.content), mask(turn.reasoning)].filter(Boolean).join('\n\n')).join('\n\n---\n\n') : '';
  // Only declared export files are built; neither source session bytes nor evidence objects are modified.
  const maskValue = value => typeof value === 'string' ? mask(value) : Array.isArray(value) ? value.map(maskValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item)])) : value;
  return { raw, markers: maskValue(markers), report, title: mask(session.name),
    manifest: { version: 1, scope, entryCount: session.entries.length, markerCount: markers.length, aiIncluded: includeAi,
      source: session.source, filter: maskValue(session.filter || {}), timeRange: maskValue(session.timeRange || { kind: 'all' }),
      redacted: redact, truncated: session.truncated === true, originalRaw: !redact, warnings: [tr('导出仅包含已选择的有限日志范围，不代表完整设备历史。')] } };
}
module.exports = { compareSessions, exportContents };
