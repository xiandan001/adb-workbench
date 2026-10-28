const { tr } = require('./localization.cjs');
const { redactText } = require('./feedback-policy.cjs');
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
function safeText(value, max) {
  if (typeof value !== 'string') return '';
  const bounded = value.slice(0, Math.max(max, 12000))
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/^[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/, '[REDACTED]');
  const safe = redactText(bounded).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(safe) ? safe.slice(0, -1) : safe;
}

function normalizeTaskOrigin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = { question: safeText(value.question, 4000), summary: safeText(value.summary, 4000) };
  for (const key of ['caseId', 'turnId', 'casebookId', 'historyId']) if (UUID.test(value[key] || '')) result[key] = value[key];
  if (Number.isInteger(value.findingIndex) && value.findingIndex >= 0 && value.findingIndex < 12) result.findingIndex = value.findingIndex;
  if (value.finding && typeof value.finding === 'object') result.finding = { title: safeText(value.finding.title, 200), detail: safeText(value.finding.detail, 4000) };
  return result.question || result.summary || result.finding ? result : null;
}

function runEvidence(record) {
  const deviceRuns = Array.isArray(record.deviceRuns) ? record.deviceRuns.slice(0, 32) : [];
  const devices = [...new Set(deviceRuns.map(run => String(run.deviceId || '')).filter(Boolean))];
  const origin = normalizeTaskOrigin(record.analysisOrigin);
  const sections = [tr('任务运行结果：{0}', { 0: safeText(record.scriptName, 200) }),
    tr('仅包含有界的运行摘要；完整记录请查看原运行产物。'), `Run: ${record.id}`, `Status: ${record.status}`];
  if (origin) sections.push(tr('原分析上下文（不是已验证结论）：'), JSON.stringify(origin));
  if (record.error) sections.push(safeText(record.error, 4000));
  let chars = sections.join('\n').length;
  for (const run of deviceRuns) {
    if (chars > 100000) break;
    sections.push(`Device: ${run.deviceId}\nStatus: ${run.status}`);
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const chosen = [...steps.filter(step => step.status === 'failed' || step.error), ...steps.filter(step => step.status !== 'failed' && !step.error)].slice(0, 100);
    for (const step of chosen) {
      if (chars > 100000) break;
      const part = JSON.stringify({ index: step.index, type: step.type, label: safeText(step.label, 200), status: step.status,
        error: safeText(step.error, 2000), output: safeText(step.output, 2000), startedAt: step.startedAt, endedAt: step.endedAt });
      chars += part.length; sections.push(part);
    }
  }
  const raw = sections.join('\n');
  const bytes = Buffer.from(raw.slice(0, 200000));
  let end = Math.min(bytes.length, 256 * 1024);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { origin: 'task-run', deviceId: devices.length === 1 ? devices[0] : '', title: safeText(record.scriptName, 200),
    question: origin?.question || tr('请分析这次任务运行中的失败与未验证项，不要把完成步骤视为问题已修复。'),
    text: bytes.subarray(0, end).toString('utf8'), ...(origin ? { originSnapshot: origin } : {}) };
}

module.exports = { normalizeTaskOrigin, runEvidence };
