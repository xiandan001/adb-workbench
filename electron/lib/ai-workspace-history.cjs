const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { sanitize } = require('./ai-workspace-evidence.cjs');
const { parseAnalysis } = require('./ai-workspace-schema.cjs');
const { normalizeSelection } = require('./ai-workspace-selection.cjs');
const limits = require('./ai-workspace-limits.cjs');
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = () => Object.assign(new Error(tr('报告无效、已损坏或超过本地保存限制。')), { code: 'AI_REPORT', safe: true });
const clone = value => JSON.parse(JSON.stringify(value));

function validateReport(report) {
  const string = (value, max) => typeof value === 'string' && value.length <= max;
  const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!report || !UUID.test(report.id || '') || !['analysis', 'followup', 'comparison'].includes(report.kind)
    || !string(report.createdAt, 40) || !Number.isFinite(Date.parse(report.createdAt)) || !string(report.preview?.question, 4000)
    || !UUID.test(report.preview.id || '') || !Array.isArray(report.preview.entries) || !report.preview.entries.length || report.preview.entries.length > 32
    || (report.name !== undefined && !string(report.name, 80))
    || (report.turnId !== undefined && !UUID.test(report.turnId))
    || (report.preview.targetFingerprint != null && !/^[a-f\d]{24,64}$/.test(report.preview.targetFingerprint))
    || Buffer.byteLength(JSON.stringify(report)) > limits.reportBytes) throw fail();
  if (report.preview.context && (!string(report.preview.context.question, 4000) || !string(report.preview.context.summary, 4000))) throw fail();
  if (report.preview.selection !== undefined) normalizeSelection(report.preview.selection);
  if (report.usage != null && (!integer(report.usage.inputTokens, 1000000000) || !integer(report.usage.outputTokens, 1000000000)
    || report.usage.totalTokens !== report.usage.inputTokens + report.usage.outputTokens)) throw fail();
  const ids = new Set();
  for (const entry of report.preview.entries) {
    if (!entry || typeof entry.id !== 'string' || !/^E[1-9]\d*$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.text !== 'string' || Buffer.byteLength(entry.text) > limits.sourceBytes
      || !['adb', 'log', 'serial', 'ssh', 'text'].includes(entry.source) || !string(entry.label, 2000) || !string(entry.target, 2000)
      || !string(entry.timeBasis, 2000) || !string(entry.capturedAt, 40) || !Number.isFinite(Date.parse(entry.capturedAt))
      || typeof entry.truncated !== 'boolean' || !integer(entry.redactions)
      || (entry.numbered !== undefined && typeof entry.numbered !== 'boolean')
      || (entry.timeWarning !== undefined && !string(entry.timeWarning, 2000))
      || (entry.selectionWarning !== undefined && !string(entry.selectionWarning, 2000))
      || (entry.targetKey != null && !/^[a-f\d]{24,64}$/.test(entry.targetKey))
      || (entry.evidenceKind !== undefined && !['adb:device_info', 'adb:logcat_snapshot', 'adb:performance_snapshot', 'log', 'serial', 'ssh', 'text'].includes(entry.evidenceKind))) throw fail();
    ids.add(entry.id);
    const lineCount = entry.text ? entry.text.split('\n').length : 0;
    if (entry.lineCount !== undefined && entry.lineCount !== lineCount) throw fail();
    if (entry.numbered && lineCount && entry.text.split('\n').some((line, i) => !line.startsWith(`[L${i + 1}] `))) throw fail();
    for (const field of ['originalLineCount', 'selectedLineCount', 'retainedLineCount']) if (entry[field] !== undefined && !integer(entry[field])) throw fail();
    if (entry.retainedLineCount !== undefined && entry.retainedLineCount !== lineCount) throw fail();
    if (entry.originalLineCount !== undefined && entry.originalLineCount < lineCount) throw fail();
    if (entry.windowInfo && (!integer(entry.windowInfo.originalRecords) || !integer(entry.windowInfo.retainedRecords)
      || entry.windowInfo.originalRecords < entry.windowInfo.retainedRecords || !integer(entry.windowInfo.byteLimit, limits.logcatBufferBytes))) throw fail();
    if (entry.originalLineNumbers !== undefined && (!Array.isArray(entry.originalLineNumbers)
      || entry.originalLineNumbers.length !== lineCount || entry.originalLineNumbers.some((line, i, all) => !Number.isSafeInteger(line) || line < 1 || (i && line <= all[i - 1])))) throw fail();
    if (entry.events !== undefined && (!Array.isArray(entry.events) || entry.events.length > 256
      || entry.events.some(event => !Number.isSafeInteger(event?.line) || event.line < 1 || event.line > lineCount
        || typeof event.timestamp !== 'string' || event.timestamp.length > 50
        || !['explicit-offset', 'source-local', 'device-local-year-unknown', 'host-receive', 'unknown'].includes(event.clockBasis)))) throw fail();
  }
  if (Buffer.byteLength(JSON.stringify(report.preview.entries)) > limits.evidenceBytes) throw fail();
  const comparison = report.preview.comparison;
  if (comparison && (typeof comparison.comparable !== 'boolean' || !string(comparison.beforeName, 4000) || !string(comparison.afterName, 4000)
    || !Array.isArray(comparison.warnings) || comparison.warnings.length > 12 || comparison.warnings.some(item => !string(item, 1500))
    || !Array.isArray(comparison.beforeIds) || !Array.isArray(comparison.afterIds)
    || !comparison.beforeIds.length || !comparison.afterIds.length || [...comparison.beforeIds, ...comparison.afterIds].some(id => !ids.has(id))
    || comparison.beforeIds.some(id => comparison.afterIds.includes(id))
    || !Array.isArray(comparison.pairs) || comparison.pairs.length > 256 || comparison.pairs.some(pair => !comparison.beforeIds.includes(pair?.beforeId) || !comparison.afterIds.includes(pair?.afterId)))) throw fail();
  if (comparison) for (const pair of comparison.pairs) {
    const before = report.preview.entries.find(entry => entry.id === pair.beforeId), after = report.preview.entries.find(entry => entry.id === pair.afterId);
    if (!before.evidenceKind || before.evidenceKind !== after.evidenceKind || !before.targetKey || before.targetKey !== after.targetKey) throw fail();
  }
  return { ...clone(report), result: parseAnalysis(JSON.stringify(report.result), report.preview.entries, comparison) };
}

function atomicWrite(filename, content, io = fs) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    let target;
    try { target = io.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (target && (!target.isFile() || target.isSymbolicLink())) throw fail();
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, content, 'utf8');
    io.fsyncSync(descriptor); io.closeSync(descriptor); descriptor = undefined;
    io.renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function createReportHistory({ directory, io = fs, now = Date.now }) {
  const root = path.resolve(directory);
  const indexFile = path.join(root, 'index.json');
  function directoryReady(create = false) {
    let stat;
    try { stat = io.lstatSync(root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      let ancestor = path.dirname(root);
      while (!io.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
      if (io.lstatSync(ancestor).isSymbolicLink() || path.resolve(io.realpathSync(ancestor)) !== ancestor) throw fail();
      io.mkdirSync(root, { recursive: true }); stat = io.lstatSync(root);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(io.realpathSync(root)) !== root) throw fail();
    return true;
  }
  function readFile(filename, maxBytes) {
    const stat = io.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw fail();
    const contents = io.readFileSync(filename, 'utf8');
    if (Buffer.byteLength(contents) > maxBytes) throw fail();
    return JSON.parse(contents);
  }
  function index() {
    if (!directoryReady()) return [];
    let data;
    try { data = readFile(indexFile, 128 * 1024); } catch (error) { if (error.code === 'ENOENT') return []; throw fail(); }
    if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > limits.reports) throw fail();
    const ids = new Set();
    for (const item of data.items) {
      if (!UUID.test(item?.id || '') || ids.has(item.id) || typeof item.name !== 'string' || item.name.length > 80
        || typeof item.question !== 'string' || item.question.length > 4000 || !Number.isFinite(Date.parse(item.createdAt))
        || !['analysis', 'followup', 'comparison'].includes(item.kind) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > limits.reportBytes) throw fail();
      ids.add(item.id);
    }
    return data.items;
  }
  function filename(id) { if (!UUID.test(id || '')) throw fail(); return path.join(root, `${id}.json`); }
  return {
    list() { return clone(index().map(({ bytes: _bytes, ...item }) => item)); },
    load(id) {
      const item = index().find(item => item.id === id); if (!item) throw fail();
      try {
        const report = validateReport(readFile(filename(id), limits.reportBytes));
        if (report.id !== id || report.name !== item.name) throw fail();
        return report;
      } catch { throw fail(); }
    },
    save(turn, name) {
      if (typeof name !== 'string' || name.trim().length > 80) throw fail();
      const report = validateReport({ ...clone(turn), turnId: turn.id, id: randomUUID(), name: sanitize(name.trim() || turn.preview.question.slice(0, 80)), savedAt: new Date(now()).toISOString() });
      const content = JSON.stringify(report); const bytes = Buffer.byteLength(content);
      directoryReady(true);
      const items = index();
      if (items.length >= limits.reports || items.reduce((sum, item) => sum + item.bytes, bytes) > limits.historyBytes) throw fail();
      const item = { id: report.id, name: report.name, createdAt: report.createdAt, kind: report.kind, question: report.preview.question, bytes };
      const target = filename(report.id);
      atomicWrite(target, content, io);
      try { atomicWrite(indexFile, JSON.stringify({ version: 1, items: [item, ...items] }), io); }
      catch (error) { io.unlinkSync(target); throw error; }
      const { bytes: _bytes, ...metadata } = item; return metadata;
    },
    delete(id) {
      const items = index(); if (!items.some(item => item.id === id)) throw fail();
      const target = filename(id), retired = path.join(root, `.${id}.removed`);
      let stat;
      try { stat = io.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail();
      if (stat) io.renameSync(target, retired);
      try { atomicWrite(indexFile, JSON.stringify({ version: 1, items: items.filter(item => item.id !== id) }), io); }
      catch (error) { if (stat) io.renameSync(retired, target); throw error; }
      if (stat) io.unlinkSync(retired);
    },
  };
}

function fenced(value) {
  const text = String(value ?? '');
  const run = (text.match(/`+/g) || []).reduce((longest, part) => Math.max(longest, part.length), 2);
  const fence = '`'.repeat(run + 1);
  return `${fence}text\n${text}\n${fence}`;
}
function reportText(report) {
  report = validateReport(report);
  const sections = [fenced(report.name || ''), fenced(report.preview.question), fenced(report.createdAt), fenced(report.result.summary)];
  for (const field of ['findings', 'hypotheses', 'nextSteps', 'limitations']) {
    for (const value of report.result[field]) sections.push(fenced(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  }
  if (report.result.verdict) sections.push(fenced(report.result.verdict));
  if (report.preview.context) sections.push(fenced(JSON.stringify(report.preview.context, null, 2)));
  if (report.preview.comparison) sections.push(fenced(JSON.stringify(report.preview.comparison, null, 2)));
  if (report.preview.selection) sections.push(fenced(JSON.stringify(report.preview.selection, null, 2)));
  for (const entry of report.preview.entries) {
    const { text: _text, ...metadata } = entry;
    sections.push(fenced(JSON.stringify(metadata, null, 2)));
    sections.push(fenced(entry.numbered ? entry.text : entry.text.split('\n').map((line, index) => `[L${index + 1}] ${line}`).join('\n')));
  }
  return sections.join('\n\n') + '\n';
}

module.exports = { createReportHistory, validateReport, reportText, atomicWrite, UUID };
