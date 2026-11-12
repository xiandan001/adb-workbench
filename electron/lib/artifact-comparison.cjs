const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { tr } = require('./localization.cjs');
const { collectArtifactFiles, exportArtifact, validateExportDestination } = require('./artifact-export.cjs');

async function readTaskArtifact(item) {
  if (item?.type !== 'task' || !item.taskId) throw new Error(tr('请选择两份已保存的普通任务运行产物。'));
  const selected = await collectArtifactFiles(item);
  const manifest = selected.files.find(file => file.name === 'run-result.json');
  if (!selected.directory || !manifest || manifest.bytes > 8 * 1024 * 1024) throw new Error(tr('任务运行数据缺失或过大，无法安全对比导出。'));
  const contents = await fs.readFile(manifest.source, 'utf8');
  if (Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new Error(tr('任务运行数据缺失或过大，无法安全对比导出。'));
  const run = JSON.parse(contents);
  if (!run || typeof run !== 'object' || Array.isArray(run) || run.id !== item.taskId) throw new Error(tr('任务运行数据已变化，请刷新后重试。'));
  return { selected, run, manifestContents: contents };
}

async function prepareTaskComparison(beforeItem, afterItem) {
  if (!beforeItem || !afterItem || beforeItem.id === afterItem.id) throw new Error(tr('请选择两份不同的任务运行产物。'));
  const [before, after] = await Promise.all([readTaskArtifact(beforeItem), readTaskArtifact(afterItem)]);
  const { compareTaskRuns, taskComparisonSummary } = await import('./task-run-comparison.mjs');
  const comparison = compareTaskRuns(before.run, after.run, tr);
  if (!comparison.comparable) throw new Error(comparison.reason);
  return { before, after, summary: taskComparisonSummary(before.run, after.run, comparison, tr) };
}

async function exportTaskComparison(prepared, destination) {
  await validateExportDestination(prepared.before.selected, destination);
  await validateExportDestination(prepared.after.selected, destination);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-task-comparison-'));
  try {
    for (const [name, result] of [['before', prepared.before], ['after', prepared.after]]) {
      for (const file of result.selected.files) {
        const target = path.join(temporary, name, file.name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (file.name === 'run-result.json') await fs.writeFile(target, result.manifestContents, 'utf8');
        else await fs.copyFile(file.source, target);
      }
    }
    await fs.writeFile(path.join(temporary, 'comparison-summary.txt'), prepared.summary, 'utf8');
    return await exportArtifact({ type: 'task-comparison', title: tr('运行对比摘要'), deletePath: temporary }, destination);
  } finally {
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('awb-task-comparison-')) await fs.rm(temporary, { recursive: true, force: true });
  }
}
module.exports = { prepareTaskComparison, exportTaskComparison };
