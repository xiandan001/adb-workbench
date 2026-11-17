const { createHash } = require('node:crypto');
const { freezeEntry } = require('./ai-workspace-evidence.cjs');
const { normalizeSelection } = require('./ai-workspace-selection.cjs');
const { shapeDiagnosticSource } = require('./ai-workspace-diagnostics.cjs');
const limits = require('./ai-workspace-limits.cjs');
const { tr } = require('./localization.cjs');
const copy = value => structuredClone(value);
const evidenceLimit = () => Object.assign(new Error(tr('完整证据及来源信息超过 20 MiB，请减少材料或缩小选段后重试；未截断内容。')), { code: 'AI_EVIDENCE_LIMIT', safe: true });
function contentBytes(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > limits.evidenceBytes) throw evidenceLimit();
  return bytes;
}
function boundedBundle(entries) {
  if (!Array.isArray(entries) || entries.length > 32) throw evidenceLimit();
  const result = entries.map((entry, index) => ({ ...copy(entry), id: `E${index + 1}` }));
  const bytes = contentBytes(result);
  return { entries: result, bytes, truncated: result.some(entry => entry.truncated) };
}
async function computeWorkspaceJob(command, args, { flag } = {}) {
  const checkCancelled = () => require('./ai-workspace-store-async.cjs').cancelled(flag);
  if (command === 'clone') return copy(args.value);
  if (command === 'freeze-preview') { const bytes = contentBytes(args.value); return { preview: copy(args.value), bytes }; }
  if (command === 'fingerprints') {
    if (!Array.isArray(args.entries) || args.entries.length > 32) throw evidenceLimit();
    contentBytes(args.entries);
    return args.entries.map(({ id: _id, ...entry }) => createHash('sha256').update(JSON.stringify(entry)).digest('hex'));
  }
  if (command === 'request-plan') {
    if (!args || Object.keys(args).some(key => !['prompt', 'payload', 'locale', 'maxTokens', 'phase'].includes(key))) throw evidenceLimit();
    return require('./ai-workspace-request-plan.cjs').buildRequestPlan(args, { checkCancelled });
  }
  if (command === 'markdown-plan') {
    if (!args || Object.keys(args).some(key => !['prompt', 'lines', 'intro', 'maxTokens', 'maxLines'].includes(key))) throw evidenceLimit();
    return require('./ai-workspace-request-plan.cjs').buildMarkdownPlan(args, { checkCancelled });
  }
  if (command === 'serial-snapshot') {
    if (!args || Object.keys(args).some(key => !['rows', 'maxRecords', 'maxBytes', 'originalRecords'].includes(key))
      || !Array.isArray(args.rows) || !Number.isSafeInteger(args.maxRecords) || args.maxRecords < 1 || args.maxRecords > 10000
      || !Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1 || args.maxBytes > limits.sourceBytes
      || !Number.isSafeInteger(args.originalRecords) || args.originalRecords < args.rows.length || args.originalRecords > 10000) throw evidenceLimit();
    const result = require('./serial-ai-evidence.cjs').captureSerialEvidenceRows(args.rows, args);
    const retainedRecords = result.windowInfo?.retainedRecords ?? args.rows.length;
    return args.originalRecords > retainedRecords ? { ...result, truncated: true,
      windowInfo: { originalRecords: args.originalRecords, retainedRecords, byteLimit: args.maxBytes } } : result;
  }
  if (command === 'transportBody') return JSON.stringify(args.payload);
  if (command === 'freeze') {
    if (!Array.isArray(args.sources) || args.sources.length > 32) throw evidenceLimit();
    contentBytes(args.sources);
    const selection = normalizeSelection(args.selection);
    const entries = args.sources.map((raw, index) => {
      const source = shapeDiagnosticSource({ ...raw, kind: ['adb', 'hdc', 'log', 'serial', 'ssh', 'text'].includes(raw.kind) ? raw.kind : 'text' });
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
    if (Buffer.byteLength(args.prompt) + Buffer.byteLength(content) > limits.inputBytes) throw Object.assign(new Error(tr('单次模型请求超过安全上限，请使用分批分析；未截断内容。')), { code: 'AI_EVIDENCE_LIMIT', safe: true });
    return { content, key: createHash('sha256').update(args.locale || '').update(content).digest('hex') };
  }
  if (command === 'refilter') {
    return args.entries.map((entry, index) => {
      const text = entry.numbered ? entry.text.replace(/^\[L\d+\] /gm, '') : entry.text;
      const next = freezeEntry({ kind: entry.source, label: entry.label, target: entry.target, text, capturedAt: entry.capturedAt,
        timeBasis: entry.timeBasis, platform: entry.platform, truncated: entry.truncated }, index, args.now, normalizeSelection(args.selection));
      if (entry.originalLineNumbers) next.originalLineNumbers = next.originalLineNumbers.map(line => entry.originalLineNumbers[line - 1]);
      else delete next.originalLineNumbers;
      return { ...next, evidenceKind: entry.evidenceKind, targetKey: entry.targetKey, originalLineCount: entry.originalLineCount ?? next.originalLineCount,
        ...(entry.provenance ? { provenance: entry.provenance } : {}), ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}), ...(entry.unavailable ? { unavailable: true } : {}),
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
    for (const card of result.verificationChecks || []) { card.title = sanitize(card.title); card.expectedObservation = sanitize(card.expectedObservation); }
    return result;
  }
  throw Object.assign(new Error(tr('AI 后台操作无效。')), { code: 'AI_WORKER_OPERATION', safe: true });
}
module.exports = { computeWorkspaceJob, boundedBundle };
