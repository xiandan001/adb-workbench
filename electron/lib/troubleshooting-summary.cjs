const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');
const { bindSummaryLifetime } = require('./ai-source-lifecycle.cjs');
const { canUseMembershipFeature } = require('./membership-entitlements.cjs');
const { tr } = require('./localization.cjs');

const REPORT = 'troubleshooting-report.md';
const SUMMARY = 'troubleshooting-summary.json';
const MATERIAL = 'troubleshooting-ai-material.json';
const AI_SECTION = '<!-- veylo-troubleshooting-ai -->';
const MATERIAL_BYTES = 256 * 1024;
const REPORT_BYTES = 2 * 1024 * 1024;
const directoryValid = value => typeof value === 'string' && value.length <= 255 &&
  /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[^/\\:*?"<>|]+$/.test(value);
const idValid = value => typeof value === 'string' && /^trouble-[a-z\d-]{1,80}$/i.test(value);
const unavailable = () => new Error(tr('原报告不存在、已变化或不可写入，未更新 AI 总结。'));

const samePath = (actual, expected) => process.platform === 'win32'
  ? path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase()
  : path.resolve(actual) === path.resolve(expected);

async function readFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw unavailable();
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw unavailable();
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function writeSummaryMaterial(outputDir, { taskId, platform, payload }) {
  const material = JSON.stringify({ version: 1, taskId, platform, payload });
  if (Buffer.byteLength(material) > MATERIAL_BYTES) throw unavailable();
  await atomicWriteAsync(path.join(outputDir, MATERIAL), material);
}

function createTroubleshootingSummary({ getRoot, getStatus, generate, formatLines }) {
  const active = new Map();

  async function readReport(ref) {
    if (!idValid(ref?.taskId) || !directoryValid(ref?.directory)) throw unavailable();
    const dir = path.join(await fs.realpath(getRoot()), ref.directory);
    if (!samePath(await fs.realpath(dir), dir)) throw unavailable();
    const reportFile = path.join(dir, REPORT);
    const summaryFile = path.join(dir, SUMMARY);
    const [report, originalSummary, materialText] = await Promise.all([
      readFile(reportFile, REPORT_BYTES), readFile(summaryFile, REPORT_BYTES),
      readFile(path.join(dir, MATERIAL), MATERIAL_BYTES)
    ]);
    const summary = JSON.parse(originalSummary);
    const material = JSON.parse(materialText);
    const marker = report.lastIndexOf(`\n${AI_SECTION}\n`);
    if (summary.taskId !== ref.taskId || summary.ok !== true || summary.aiSummaryAvailable !== true
      || material.taskId !== ref.taskId || material.version !== 1 || !material.payload || marker < 0) throw unavailable();
    return { report, originalSummary, materialText, reportFile, summaryFile, summary, material,
      reportPrefix: report.slice(0, marker + AI_SECTION.length + 2) };
  }

  async function latest() {
    try {
      const root = await fs.realpath(getRoot());
      const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && directoryValid(entry.name))
        .map(entry => entry.name).sort().reverse().slice(0, 32);
      for (const directory of dirs) {
        try {
          const dir = path.join(root, directory);
          if (!samePath(await fs.realpath(dir), dir)) continue;
          const summary = JSON.parse(await readFile(path.join(dir, SUMMARY), REPORT_BYTES));
          if (summary.ok !== true || !idValid(summary.taskId) || typeof summary.deviceId !== 'string') continue;
          const reportPath = path.join(dir, REPORT);
          const stat = await fs.lstat(reportPath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          return { ...summary, outputDir: dir, reportPath, summaryPath: path.join(dir, SUMMARY) };
        } catch { /* Ignore incomplete or unavailable reports. */ }
      }
    } catch { /* No previous report exists. */ }
    return null;
  }

  async function run(ref, sender) {
    if (!idValid(ref?.taskId) || !directoryValid(ref?.directory)) return { ok: false, error: unavailable().message };
    const key = ref.taskId;
    if (active.size > 0) return { ok: false, error: tr('正在生成 AI 总结') };
    const job = { sender };
    const lifetime = bindSummaryLifetime(job);
    active.set(key, job);
    try {
      if (!canUseMembershipFeature(await getStatus(), 'ai-analysis')) {
        return { ok: false, code: 'AI_SEND_VIP', error: tr('AI 分析需要有效会员授权。') };
      }
      let initial;
      try { initial = await readReport(ref); }
      catch { return { ok: false, error: unavailable().message }; }
      if (initial.summary.aiSummary?.ok) return { ok: true, taskId: key, aiSummary: initial.summary.aiSummary };
      if (lifetime.signal.aborted) return { ok: false, cancelled: true };
      const response = await generate(initial.material, lifetime.signal);
      if (lifetime.signal.aborted || response?.cancelled) return { ok: false, cancelled: true };
      if (!response?.ok || !response.summary?.trim()) return { ok: false, code: response?.code, error: response?.error || tr('AI 总结为空') };
      const aiSummary = { ok: true, summary: response.summary };
      try {
        const current = await readReport(ref);
        if (current.report !== initial.report || current.originalSummary !== initial.originalSummary
          || current.materialText !== initial.materialText) throw unavailable();
        if (lifetime.signal.aborted) return { ok: false, cancelled: true };
        const next = { ...current.summary, aiSummary };
        const updatedReport = `${current.reportPrefix}\n${formatLines(aiSummary).join('\n')}\n`;
        await atomicWriteAsync(current.reportFile, updatedReport);
        try { await atomicWriteAsync(current.summaryFile, `${JSON.stringify(next, null, 2)}\n`); }
        catch (error) {
          await atomicWriteAsync(current.reportFile, current.report).catch(() => {});
          throw error;
        }
      } catch { return { ok: false, error: unavailable().message }; }
      return { ok: true, taskId: key, aiSummary };
    } catch {
      return { ok: false, error: tr('AI 总结异常') };
    } finally {
      lifetime.dispose();
      active.delete(key);
    }
  }

  function cancel(taskId, sender) {
    const job = active.get(taskId);
    if (!job || job.sender !== sender) return { ok: true, cancelled: false };
    job.aiSummaryController?.abort();
    return { ok: true, cancelled: true };
  }

  return { run, latest, cancel };
}

module.exports = { AI_SECTION, createTroubleshootingSummary, writeSummaryMaterial };
