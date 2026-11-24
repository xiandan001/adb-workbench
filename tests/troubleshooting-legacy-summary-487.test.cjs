const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createTroubleshootingSummary } = require('../electron/lib/troubleshooting-summary.cjs');

const startedAt = '2025-12-08T12:24:00.015Z';
const oldTask = 'trouble-1765196640015-ed';
const directory = '2025-12-08T12-24-00-016Z-AndroidFixture-crash';
const markdown = '# 一键问题排查报告\n\n- 开始时间：' + startedAt + '\n- 看到了 ANR。\n\n## AI 总结\n\n旧总结不能当作证据。';
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-legacy-summary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reports = path.join(root, 'troubleshooting');
  const calls = [];
  const state = { membership: { activated: true, scope: 'vip' }, generate: async () => ({ ok: true, summary: 'New summary' }) };
  const make = () => createTroubleshootingSummary({
    getRoot: () => reports,
    getStatus: async () => state.membership,
    generate: async (material, signal) => { calls.push(material); return state.generate(material, signal); },
    formatLines: () => assert.fail('Legacy report must not update its Markdown')
  });
  return { root, reports, state, calls, make, service: make(), sender: owner() };
}

async function writeBundle(root) {
  const dir = path.join(root, directory);
  const raw = path.join(dir, 'raw');
  await fs.mkdir(raw, { recursive: true });
  const report = path.join(dir, 'troubleshooting-report.md');
  const metadata = path.join(dir, 'troubleshooting-summary.json');
  await fs.writeFile(report, markdown);
  await fs.writeFile(metadata, JSON.stringify({
    ok: true, taskId: oldTask, startedAt,
    title: 'Old title', checks: [{ label: 'ANR marker', detail: 'saved check', ok: false }],
    artifacts: [{ path: 'C:/arbitrary/never-read.txt' }], aiSummary: { ok: true, summary: 'Original AI result' }
  }));
  await fs.writeFile(path.join(raw, 'matched-log-excerpt.txt'), 'A matched log');
  await fs.writeFile(path.join(raw, 'performance-snapshot.json'), JSON.stringify({
    cpu: { usage: 18 }, memory: { usage: 56 }, battery: { temperature: 37 }, arbitrary: 'never sent'
  }));
  return { dir, raw, report, metadata };
}

test('a prior native Android report without deviceId joins the latest report flow and reuses all existing evidence', async t => {
  const f = await fixture(t);
  const files = await writeBundle(f.reports);
  const original = await fs.readFile(files.metadata);
  const report = await f.service.latest();
  assert.equal(report.legacy, true);
  assert.equal(report.taskId, oldTask);
  assert.equal(report.aiSummary.summary, 'Original AI result');
  assert.deepEqual(report.evidenceSources, { report: true, summary: true, logs: true, performance: true });

  const result = await f.service.run(report.reportRef, f.sender);
  assert.equal(result.ok, true);
  assert.match(result.summaryPath, /[\/\\]ai-summaries[\/\\]/);
  assert.equal(f.calls.length, 1);
  const { payload, legacy } = f.calls[0];
  assert.equal(legacy, true);
  assert.match(payload.reportMarkdown, /ANR/);
  assert.doesNotMatch(payload.reportMarkdown, /旧总结/);
  assert.equal(payload.savedChecks.checks[0].detail, 'saved check');
  assert.equal(payload.savedLogExcerpt, 'A matched log');
  assert.equal(payload.savedPerformance.memoryUsagePercent, 56);
  assert.doesNotMatch(JSON.stringify(payload), /never sent|never-read/);
  assert.equal(await fs.readFile(files.report, 'utf8'), markdown);
  assert.deepEqual(await fs.readFile(files.metadata), original);
  assert.equal((await f.make().latest()).aiSummary.summary, 'New summary');
});

test('a picker-owned Markdown-only report works outside the reports directory and keeps its result on failure and retry', async t => {
  const f = await fixture(t);
  const markdownPath = path.join(f.root, 'standalone.markdown');
  await fs.writeFile(markdownPath, '# Evidence\n\nOnly Markdown ANR notes');
  await fs.writeFile(path.join(f.root, 'troubleshooting-summary.json'), '{"token":"never sent"}');
  const choice = await f.service.choose(markdownPath, f.sender);
  assert.equal(choice.ok, true);
  const { report } = choice;
  assert.deepEqual(report.evidenceSources, { report: true, summary: false, logs: false, performance: false });
  assert.equal((await f.service.run({ taskId: report.taskId, importId: 'not-chosen-by-picker' }, f.sender)).ok, false);
  assert.equal((await f.service.run(report.reportRef, owner())).ok, false);
  assert.equal(f.calls.length, 0);
  f.state.membership = { activated: true, scope: 'free' };
  assert.equal((await f.service.run(report.reportRef, f.sender)).code, 'AI_SEND_VIP');
  assert.equal(f.calls.length, 0);
  f.state.membership = { activated: true, scope: 'vip' };
  f.state.generate = async () => ({ ok: false, error: 'fixture network failure' });
  assert.equal((await f.service.run(report.reportRef, f.sender)).error, 'fixture network failure');
  f.state.generate = async () => ({ ok: true, summary: 'Original Markdown AI result' });
  const successful = await f.service.run(report.reportRef, f.sender);
  assert.equal(successful.ok, true);
  f.state.generate = async () => ({ cancelled: true });
  assert.equal((await f.service.run(report.reportRef, f.sender)).cancelled, true);
  assert.equal(await fs.readFile(markdownPath, 'utf8'), '# Evidence\n\nOnly Markdown ANR notes');
  assert.equal((await f.make().choose(markdownPath, f.sender)).report.aiSummary.summary, 'Original Markdown AI result');
  assert.ok(f.calls.every(call => call.payload.savedChecks === null && call.payload.savedPerformance === null && call.payload.savedLogExcerpt === ''));
});

test('a linked raw directory is excluded and a changed input does not write a stale summary', async t => {
  const f = await fixture(t);
  const files = await writeBundle(f.reports);
  const foreign = path.join(f.root, 'elsewhere');
  await fs.rename(files.raw, foreign);
  await fs.symlink(foreign, files.raw, 'junction');
  const saved = await f.service.latest();
  assert.equal(saved.evidenceSources.logs, false);
  assert.equal(saved.evidenceSources.performance, false);
  const opened = await f.service.choose(files.report, f.sender);
  await fs.appendFile(files.report, '\nchanged since preview preparation');
  assert.equal((await f.service.run(opened.report.reportRef, f.sender)).ok, false);
  assert.equal(f.calls.length, 0);
  f.state.generate = async () => {
    await fs.appendFile(files.report, '\nchanged during AI request');
    return { ok: true, summary: 'Stale AI text' };
  };
  assert.equal((await f.service.run(saved.reportRef, f.sender)).ok, false);
  assert.equal(f.calls.length, 1);
  await assert.rejects(fs.stat(path.join(f.reports, 'ai-summaries')), { code: 'ENOENT' });
});

test('empty and oversized Markdown are rejected without starting an AI job', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'evidence.md');
  await fs.writeFile(file, '    \r\n');
  assert.equal((await f.service.choose(file, f.sender)).ok, false);
  await fs.writeFile(file, 'a'.repeat(2 * 1024 * 1024 + 1));
  assert.equal((await f.service.choose(file, f.sender)).ok, false);
  assert.equal(f.calls.length, 0);
});
