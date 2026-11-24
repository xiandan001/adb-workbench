const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');
const { tr } = require('./localization.cjs');
const localeConfig = require('../locales/locale-config.json');

const REPORT = 'troubleshooting-report.md';
const SUMMARY = 'troubleshooting-summary.json';
const MAX_MARKDOWN = 2 * 1024 * 1024;
const MAX_SOURCE = 1024 * 1024;
const MAX_SUMMARY = 512 * 1024 + 256;
const DELIMITER = '<!-- veylo-legacy-ai-summary:';
const collapsePath = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const samePath = (actual, expected) => collapsePath(actual) === collapsePath(expected);
const digest = value => createHash('sha256').update(value).digest('hex');
const readError = () => new Error(tr('无法读取这份 Markdown 报告。请确认文件可读、非空且不超过 2 MiB。'));

async function readLocalText(file, maximum, singleLink = false) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum
    || (singleLink && before.nlink !== 1) || !samePath(await fs.realpath(file), file)) throw readError();
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev || before.size !== opened.size) throw readError();
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw readError();
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le'
      : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(0, offset));
    if (text.includes('\0')) throw readError();
    return text;
  } finally { await handle.close(); }
}

function bounded(text, bytes) {
  if (typeof text !== 'string') return '';
  const content = Buffer.from(text.trim());
  return new TextDecoder().decode(content.subarray(0, bytes), { stream: true });
}

async function optionalText(file, cap) {
  try { return await readLocalText(file, cap, true); }
  catch { return ''; }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function linesWithoutPreviousSummary(markdown) {
  const headings = new Set(localeConfig.supportedLocales.map(locale => tr('## AI 总结', {}, locale)));
  const lines = markdown.split(/\r?\n/);
  const index = lines.findLastIndex(line => headings.has(line.trim()));
  return index > 0 ? lines.slice(0, index).join('\n') : markdown;
}

function storedChecks(metadata) {
  const checks = Array.isArray(metadata.checks) ? metadata.checks.slice(0, 24).filter(row => row && typeof row === 'object') : [];
  return {
    title: bounded(metadata.title, 300), message: bounded(metadata.message, 1000),
    status: bounded(metadata.status, 28),
    checks: checks.map(row => ({
      label: bounded(row.label, 300), ok: row.ok === true, skipped: row.skipped === true,
      unavailable: row.unavailable === true, detail: bounded(row.detail, 500)
    }))
  };
}

function storedPerformance(snapshot) {
  const finite = value => Number.isFinite(value) ? value : null;
  const disk = Array.isArray(snapshot.disk) ? snapshot.disk.find(item => item?.mount === '/data') || snapshot.disk[0] : null;
  return {
    cpuUsagePercent: finite(snapshot.cpu?.usage),
    memoryUsagePercent: finite(snapshot.memory?.usage),
    diskUsagePercent: finite(disk?.usage),
    temperatureCelsius: finite(snapshot.battery?.temperature ?? snapshot.thermal?.hottest),
    sampleError: bounded(snapshot.sampleError, 300),
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice(0, 12).filter(item => item && typeof item === 'object')
      .map(item => ({ label: bounded(item.label || item.type, 200), value: finite(item.value), limit: finite(item.limit) })) : [],
    unavailable: Array.isArray(snapshot.unavailable) ? snapshot.unavailable.slice(0, 12).filter(item => item && typeof item === 'object')
      .map(item => ({ metric: bounded(item.metric, 100), reason: bounded(item.reason, 200) })) : []
  };
}

const taskIdPattern = /^trouble-[a-z\d-]{1,80}$/i;
const reportHeader = new Set(localeConfig.supportedLocales.map(locale => tr('# 一键问题排查报告', {}, locale)));

async function readLegacyEvidence(markdownPath, { trustedBundle = false } = {}) {
  if (!/\.m(?:d|arkdown)$/i.test(markdownPath)) throw readError();
  const markdown = await readLocalText(markdownPath, MAX_MARKDOWN);
  if (!markdown.trim()) throw readError();
  const folder = path.dirname(markdownPath);
  const sourceKey = digest(collapsePath(markdownPath));
  const isNamedBundle = path.basename(markdownPath).toLowerCase() === REPORT
    && reportHeader.has(markdown.split(/\r?\n/, 1)[0].trim());
  const candidate = isNamedBundle ? parseObject(await optionalText(path.join(folder, SUMMARY), MAX_SOURCE)) : null;
  // The report and companion metadata must identify a bundle, not a filename supplied by a renderer.
  const metadata = candidate && typeof candidate.taskId === 'string' && taskIdPattern.test(candidate.taskId) &&
    typeof candidate.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(candidate.startedAt) &&
    markdown.includes(candidate.startedAt) ? candidate : null;
  const raw = path.join(folder, 'raw');
  let logs = '', snapshot = null;
  if (isNamedBundle && (metadata || trustedBundle)) {
    [logs, snapshot] = await Promise.all([
      (async () => (await optionalText(path.join(raw, 'matched-log-excerpt.txt'), MAX_SOURCE)).trim()
        || await readStoredLog(raw, metadata?.platform))(),
      optionalText(path.join(raw, 'performance-snapshot.json'), MAX_SOURCE).then(parseObject)
    ]);
  }
  const report = linesWithoutPreviousSummary(markdown);
  const payload = {
    reportMarkdown: bounded(report, 88 * 1024), reportLimited: Buffer.byteLength(report.trim()) > 88 * 1024,
    savedChecks: metadata ? storedChecks(metadata) : null,
    savedLogExcerpt: bounded(logs, 48 * 1024), logsLimited: Buffer.byteLength(logs) > 48 * 1024,
    savedPerformance: snapshot ? storedPerformance(snapshot) : null
  };
  const material = { platform: metadata?.platform === 'harmony' ? 'harmony' : 'unknown', payload, legacy: true };
  return {
    markdownPath, metadata, material, sourceKey, fingerprint: digest(JSON.stringify([digest(markdown), material])),
    evidenceSources: { report: true, summary: Boolean(metadata), logs: Boolean(logs), performance: Boolean(snapshot) },
    evidenceLimited: payload.reportLimited || payload.logsLimited
  };
}

async function readStoredLog(raw, platform) {
  const names = platform === 'harmony' ? ['hilog-tail.txt'] : platform === 'android' ? ['logcat-tail.txt'] : ['logcat-tail.txt', 'hilog-tail.txt'];
  for (const name of names) {
    const text = (await optionalText(path.join(raw, name), MAX_SOURCE)).trim();
    if (text) return text;
  }
  return '';
}

async function summaryFile(getRoot, evidence, create = false) {
  if (create) await fs.mkdir(getRoot(), { recursive: true });
  const root = await fs.realpath(getRoot());
  const directory = path.join(root, 'ai-summaries');
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw readError();
  return path.join(directory, evidence.sourceKey + '.md');
}

const summaryMarker = evidence => DELIMITER + evidence.fingerprint + ' -->\n\n';
async function readLegacySummary(getRoot, evidence) {
  try {
    const summaryPath = await summaryFile(getRoot, evidence);
    const content = await readLocalText(summaryPath, MAX_SUMMARY, true);
    const marker = summaryMarker(evidence);
    if (!content.startsWith(marker) || !content.slice(marker.length).trim()) return {};
    return { aiSummary: { ok: true, summary: content.slice(marker.length).trim() }, aiSummaryPath: summaryPath, summaryPath };
  } catch { return {}; }
}

async function writeLegacySummary(getRoot, evidence, summary) {
  const content = summaryMarker(evidence) + summary.trim() + '\n';
  if (Buffer.byteLength(content) > MAX_SUMMARY) throw readError();
  const summaryPath = await summaryFile(getRoot, evidence, true);
  await atomicWriteAsync(summaryPath, content);
  return summaryPath;
}

module.exports = { readLegacyEvidence, readLegacySummary, writeLegacySummary, readLocalText, samePath };
