const { createHash } = require('node:crypto');
const { analysisMessages } = require('./analysis-language.cjs');
const { LIMITS } = require('./ai-outbound-policy.cjs');
const { contentBytes } = require('./ai-context-limits.json');
const { tr } = require('./localization.cjs');

const PLAN_REQUESTS = 64;
const REDUCE_LEVELS = 4;
const model = require('./ai-model-request-limits.cjs');
const invalid = (code = 'AI_CONTEXT_ATOM_LIMIT') => Object.assign(new Error(tr('单条完整证据超过模型请求容量，无法安全分块；请缩小来源范围，未发送或截断。')), { code, safe: true });

function requestRecord(prompt, content, maxTokens, mapping = []) {
  const messages = analysisMessages(prompt, [], content);
  const body = JSON.stringify({ model: 'm'.repeat(128), messages, stream: false, temperature: 0.2, max_tokens: maxTokens });
  const bytes = Buffer.byteLength(body);
  const estimatedTokens = Math.ceil(messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) / model.inputBytesPerEstimatedToken) + maxTokens + 128;
  if (bytes <= LIMITS.requestBytes && estimatedTokens <= model.contextTokens) return { systemPrompt: prompt, userContent: content, maxTokens, bytes, mapping };
  return null;
}

function maximumEnd(start, end, make) {
  let low = start + 1, high = end, best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), value = make(middle);
    if (value) { best = { end: middle, value }; low = middle + 1; } else high = middle - 1;
  }
  if (!best) throw invalid();
  return best;
}

function append(requests, request) {
  if (requests.length >= PLAN_REQUESTS) throw invalid('AI_CONTEXT_PLAN_LIMIT');
  requests.push(request);
}

function entryRange(entry, lines, start, end) {
  return { ...entry, text: lines.slice(start, end).join('\n'), retainedLineCount: end - start,
    chunkRange: { startLine: start + 1, endLine: end, totalFrozenLines: entry.lineCount || lines.length },
    ...(entry.originalLineNumbers ? { originalLineNumbers: entry.originalLineNumbers.slice(start, end) } : {}),
    ...(entry.events ? { events: entry.events.filter(event => event.line > start && event.line <= end) } : {}) };
}
function mappingFor(entry, text = entry.text) {
  const lines = text.split('\n');
  const line = (value, fallback) => Number(/^\[L(\d+)\]/.exec(value)?.[1]) || fallback;
  return { evidenceId: entry.id, lineStart: line(lines[0], entry.chunkRange?.startLine || 1), lineEnd: line(lines.at(-1), entry.chunkRange?.endLine || lines.length) };
}

function validatePlannedCitations(result, mapping) {
  const allowed = new Set(mapping.map(item => item.evidenceId));
  const invalid = () => Object.assign(new Error(tr('AI 分块引用不在本请求的冻结记录范围内，未生成最终结论。')), { code: 'AI_CONTEXT_REFERENCE', safe: true });
  for (const finding of result.findings || []) {
    if ((finding.evidenceIds || []).some(id => !allowed.has(id))) throw invalid();
    for (const citation of finding.citations || []) {
      const ranges = mapping.filter(item => item.evidenceId === citation.evidenceId).sort((a, b) => a.lineStart - b.lineStart);
      let cursor = citation.startLine;
      for (const range of ranges) if (range.lineStart <= cursor && range.lineEnd >= cursor) cursor = range.lineEnd + 1;
      if (cursor <= citation.endLine) throw invalid();
    }
  }
}

function buildRequestPlan({ prompt, payload, locale = '', maxTokens = 3000, phase = 'map' }, { checkCancelled = () => {} } = {}) {
  checkCancelled();
  if (typeof prompt !== 'string' || !payload || typeof payload !== 'object' || !['map', 'reduce'].includes(phase)
    || !Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 4096) throw invalid('AI_CONTEXT_PLAN_INPUT');
  const full = JSON.stringify(payload), sourceBytes = Buffer.byteLength(full);
  checkCancelled();
  if (sourceBytes > contentBytes) throw Object.assign(new Error(tr('完整 AI 上下文（含来源元数据）超过 20 MiB，请缩小范围；未发送或截断。')), { code: 'AI_EVIDENCE_LIMIT', safe: true });
  const key = createHash('sha256').update(locale).update(full).digest('hex');
  const mapping = (payload.evidence || []).map(entry => mappingFor(entry));
  const single = requestRecord(prompt, full, maxTokens, mapping);
  if (single) return { kind: 'single', requests: [single], key, sourceBytes };
  const requests = [];
  if (phase === 'reduce') {
    const { partialResults, ...metadata } = payload;
    if (!Array.isArray(partialResults) || !partialResults.length) throw invalid();
    for (let start = 0; start < partialResults.length;) {
      const selected = maximumEnd(start, partialResults.length, end => {
        checkCancelled();
        const subset = partialResults.slice(start, end);
        return requestRecord(prompt, JSON.stringify({ ...metadata, partialResults: subset }), maxTokens, subset.flatMap(item => item.mapping || []));
      });
      append(requests, selected.value); start = selected.end;
    }
  } else {
    const { evidence, ...metadata } = payload;
    if (!Array.isArray(evidence) || !evidence.length) throw invalid();
    let pending = [];
    const make = entries => { checkCancelled(); return requestRecord(prompt, JSON.stringify({ ...metadata, evidence: entries }), maxTokens, entries.map(entry => mappingFor(entry))); };
    for (const entry of evidence) {
      if (make([...pending, entry])) { pending.push(entry); continue; }
      if (pending.length) { append(requests, make(pending)); pending = []; }
      if (make([entry])) { pending.push(entry); continue; }
      const lines = entry.text.split('\n');
      for (let start = 0; start < lines.length;) {
        const selected = maximumEnd(start, lines.length, end => make([entryRange(entry, lines, start, end)]));
        if (!entry.numbered) selected.value.mapping = [{ evidenceId: entry.id, lineStart: start + 1, lineEnd: selected.end }];
        append(requests, selected.value); start = selected.end;
      }
    }
    if (pending.length) append(requests, make(pending));
  }
  return { kind: 'map', requests, key, sourceBytes };
}

function buildMarkdownPlan({ prompt, lines, intro = '', maxTokens = 3000, maxLines = Number.MAX_SAFE_INTEGER }, { checkCancelled = () => {} } = {}) {
  checkCancelled();
  if (!Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string') || !Number.isSafeInteger(maxLines) || maxLines < 1) throw invalid('AI_CONTEXT_PLAN_INPUT');
  if (lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, Buffer.byteLength(intro)) > contentBytes) throw invalid('AI_EVIDENCE_LIMIT');
  const requests = [];
  for (let start = 0; start < lines.length;) {
    const selected = maximumEnd(start, Math.min(lines.length, start + maxLines), end => {
      checkCancelled();
      return requestRecord(prompt, `${intro}${intro ? '\n\n' : ''}${lines.slice(start, end).join('\n')}`, maxTokens,
        [{ evidenceId: 'log', lineStart: start + 1, lineEnd: end }]);
    });
    append(requests, selected.value); start = selected.end;
  }
  return { kind: requests.length === 1 ? 'single' : 'map', requests };
}

module.exports = { buildRequestPlan, buildMarkdownPlan, requestRecord, validatePlannedCitations, PLAN_REQUESTS, REDUCE_LEVELS };
