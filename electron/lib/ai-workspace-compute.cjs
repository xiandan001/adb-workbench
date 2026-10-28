const { createHash } = require('node:crypto');
const { freezeEntry } = require('./ai-workspace-evidence.cjs');
const { normalizeSelection } = require('./ai-workspace-selection.cjs');
const { shapeDiagnosticSource } = require('./ai-workspace-diagnostics.cjs');
const limits = require('./ai-workspace-limits.cjs');
const { tr } = require('./localization.cjs');
const copy = value => structuredClone(value);
function boundedBundle(entries) {
  const result = entries.map((entry, index) => ({ ...copy(entry), id: `E${index + 1}` }));
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (result.length > 32 || bytes > limits.evidenceBytes) throw Object.assign(new Error(tr('证据总量超过 1 MiB，请减少来源或缩小选段后重新生成预览。')), { code: 'AI_EVIDENCE_LIMIT', safe: true });
  return { entries: result, bytes, truncated: result.some(entry => entry.truncated) };
}
async function computeWorkspaceJob(command, args) {
  if (command === 'clone') return copy(args.value);
  if (command === 'transportBody') return JSON.stringify(args.payload);
  if (command === 'freeze') {
    const selection = normalizeSelection(args.selection);
    const entries = args.sources.map((raw, index) => {
      const source = shapeDiagnosticSource({ ...raw, kind: ['adb', 'log', 'serial', 'ssh', 'text'].includes(raw.kind) ? raw.kind : 'text' });
      const entry = freezeEntry(source, index, args.now ?? Date.now(), selection);
      if (raw.provenance?.trust === 'renderer-view') entry.targetKey = null;
      if (raw.provenance) entry.provenance = copy(raw.provenance);
      if (source.unavailable) entry.unavailable = true;
      if (source.diagnostic) entry.diagnostic = copy(source.diagnostic);
      return entry;
    });
    return { ...boundedBundle(entries), selection };
  }
  if (command === 'bundle') return boundedBundle(args.entries);
  if (command === 'request') {
    const content = JSON.stringify(args.payload);
    if (Buffer.byteLength(args.prompt) + Buffer.byteLength(content) > limits.inputBytes) throw Object.assign(new Error(tr('证据总量超过 1 MiB，请减少来源或缩小选段后重新生成预览。')), { code: 'AI_EVIDENCE_LIMIT', safe: true });
    return { content, key: createHash('sha256').update(args.locale || '').update(content).digest('hex') };
  }
  if (command === 'refilter') {
    return args.entries.map((entry, index) => {
      const text = entry.numbered ? entry.text.replace(/^\[L\d+\] /gm, '') : entry.text;
      const next = freezeEntry({ kind: entry.source, label: entry.label, target: entry.target, text, capturedAt: entry.capturedAt,
        timeBasis: entry.timeBasis, truncated: entry.truncated }, index, args.now, normalizeSelection(args.selection));
      if (entry.originalLineNumbers) next.originalLineNumbers = next.originalLineNumbers.map(line => entry.originalLineNumbers[line - 1]);
      else delete next.originalLineNumbers;
      return { ...next, evidenceKind: entry.evidenceKind, targetKey: entry.targetKey, originalLineCount: entry.originalLineCount ?? next.originalLineCount,
        ...(entry.provenance ? { provenance: entry.provenance } : {}), ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
        ...(entry.selectionWarning ? { selectionWarning: entry.selectionWarning, windowInfo: entry.windowInfo } : {}) };
    });
  }
  if (command === 'reportText') return require('./ai-workspace-history.cjs').reportText(args.report);
  if (command === 'analysis') {
    const result = require('./ai-workspace-schema.cjs').parseAnalysis(args.text, args.entries, args.comparison);
    const { sanitize } = require('./ai-workspace-evidence.cjs');
    result.summary = sanitize(result.summary);
    for (const finding of result.findings) { finding.title = sanitize(finding.title); finding.detail = sanitize(finding.detail); }
    for (const field of ['hypotheses', 'nextSteps', 'limitations']) result[field] = result[field].map(sanitize);
    return result;
  }
  throw Object.assign(new Error(tr('AI 后台操作无效。')), { code: 'AI_WORKER_OPERATION', safe: true });
}
module.exports = { computeWorkspaceJob, boundedBundle };
